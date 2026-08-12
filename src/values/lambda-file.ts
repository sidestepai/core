/**
 * `lam.file` — a lambda body that lives in its own type-checked module.
 *
 * The inline form ({@link lam.fn}) is right up to the point where a body earns
 * real structure: helpers, branches, a shape worth reading on its own. Past that
 * it wants to be a file the author's own `tsconfig` checks, their editor
 * navigates, and their formatter formats. `lam.file("./lambdas/total.ts")` reads
 * that file at build time and emits the same `const:text` every other `lam.*`
 * form emits, through the same extraction and the same guard.
 *
 * The file's shape is one default-exported function whose first parameter
 * destructures the bindings — the same convention as the inline form, so
 * `LambdaBindings<"reduce">` annotates it and the body type-checks:
 *
 * ```ts
 * // lambdas/order-total.ts
 * import type { LambdaBindings } from "@sidestep/core";
 * export default ({ $result, $this }: LambdaBindings<"reduce">) => {
 *   const line = $this.qty * $this.price;
 *   return $result + line;
 * };
 * ```
 *
 * It is read as TEXT rather than imported: no transpiler runs, so what the engine
 * receives is exactly the bytes in the file (TypeScript annotations included —
 * the engine's executor accepts them). That is also what makes this the
 * deterministic option when a bundler is in play, where `Function.prototype
 * .toString()` returns whatever the bundler emitted.
 *
 * This lives on `@sidestep/core/node` because it touches the filesystem; the
 * isomorphic entry has no `lam.file`.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Value } from "./value.js";
import {
  extractFunctionBody,
  lam as isomorphicLam,
  lambdaValue,
  maskNonCode,
  LAMBDA_GLOBALS,
  LAMBDA_MODULE_GLOBALS,
} from "./lambda.js";
import type { CaptureValue, LambdaOptions } from "./lambda.js";

const PREFIX = "lam.file";

/** Transpiling loaders whose frames sit between this module and the caller's. */
const LOADER_FRAME = /[/\\]node_modules[/\\](?:\.pnpm[/\\][^/\\]+[/\\]node_modules[/\\])?(?:vite-node|vite|vitest|tsx|ts-node|jiti|esbuild-register|@esbuild-kit)[/\\]/;

/** This module's own path, so its frames can be told from the caller's. */
const SELF = fileURLToPath(import.meta.url);

/**
 * The directory of the module that called `lam.file`.
 *
 * A relative path in a workspace definition means "next to this file", the way
 * every `import` in the same file does — resolving against `process.cwd()`
 * instead would make the same definition compile or fail depending on which
 * directory the build was launched from. Node has no `import.meta` of the
 * caller, so the frame is read off a stack trace: the first frame outside this
 * module is the caller.
 */
function callerDir(): string {
  const stack = new Error().stack ?? "";
  const frames: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const match = /\((.*?):\d+:\d+\)\s*$/.exec(line) ?? /at (.*?):\d+:\d+\s*$/.exec(line);
    const raw = match?.[1];
    if (raw === undefined || raw.startsWith("node:")) continue;
    const path = raw.startsWith("file:") ? fileURLToPath(raw) : raw;
    // Matched by PATH, not by filename: a user module may well be called
    // `lambda-file.ts` too, and skipping it would resolve against the wrong dir.
    if (path === SELF) continue;
    frames.push(path);
  }
  // A loader can sit between this module and the authored one — vite-node, tsx,
  // ts-node — and its frames come first. Skipping those by NAME rather than
  // skipping all of `node_modules` matters: a shared definitions package that
  // ships its own lambda files lives in `node_modules` legitimately, and
  // resolving its relative paths against the consuming app's directory would
  // read the wrong file (or none).
  const authored = frames.find((p) => !LOADER_FRAME.test(p));
  return dirname(authored ?? frames[0] ?? process.cwd());
}

/**
 * Statement keywords a lambda module may carry at its top level.
 *
 * Only the default export's body is sent to the engine, so anything ELSE
 * declared at the top level of the file is silently absent at runtime — a helper
 * function defined beside the default export would be undefined inside it, and
 * the engine would hand that back as diagnostic text in the value slot. Imports
 * and type-only declarations are the exception: they exist for the author's
 * type-checker and vanish from the emitted body either way.
 */
const ALLOWED_TOP_LEVEL = ["type", "interface", "declare"];

/**
 * Reject anything at the module's top level that would not survive extraction.
 *
 * Depth-tracked over the masked source, so braces inside the default export's
 * own body are not mistaken for top-level statements. This is the same tokenizer
 * the binding scan uses — no parser, and no dependency on one.
 */
function assertOnlyDefaultExport(mask: string, path: string): void {
  let depth = 0;
  let atStatementStart = true;
  for (let i = 0; i < mask.length; i++) {
    const ch = mask[i] ?? "";
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      continue;
    }
    // Only a `;` or a newline OUTSIDE every bracket starts the next statement —
    // a closing brace does not, or the `}` of `import { X } from "…"` would make
    // the rest of that same line look like a new declaration.
    if (depth === 0 && (ch === ";" || ch === "\n")) {
      atStatementStart = true;
      continue;
    }
    if (/\s/.test(ch) || depth > 0) continue;
    if (!atStatementStart) continue;
    atStatementStart = false;
    const rest = mask.slice(i);
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest)?.[0];
    if (word === undefined || ALLOWED_TOP_LEVEL.includes(word)) continue;
    // `export default` is the point of the file. Any OTHER export is a value
    // that never leaves this file — the engine receives the default export's
    // body and nothing else — so `export const helper = …` beside it is
    // undefined at runtime exactly like an unexported one would be.
    if (word === "export") {
      if (/^export\s+(?:default\b|type\b|interface\b)/.test(rest)) continue;
      throw new Error(
        `${PREFIX}: ${path} exports something besides its default. Only the default export's BODY is sent to the ` +
          `engine, so a second export is undefined at runtime — the engine returns that failure as diagnostic text ` +
          `in the value slot rather than as an error. A lambda module is one \`export default\` function and nothing ` +
          `else: move it inside that function. (issue #221)`,
      );
    }
    // A TYPE import vanishes at compile time and is free. A VALUE import does
    // not: the module is never loaded, so the imported binding is undefined
    // inside the body. Dependencies come from the preloaded globals — a literal
    // `import()`/`require()` specifier does not resolve on every instance (#265).
    if (word === "import") {
      if (/^import\s+type\b/.test(rest)) continue;
      throw new Error(
        `${PREFIX}: ${path} imports a value at the top level, which the engine never resolves — only the default ` +
          `export's body is sent, so the import is undefined at runtime. Use \`import type\` for types, or reach a ` +
          `dependency through the PRELOADED globals, which need no specifier and are the only route that works on ` +
          `every instance: ${LAMBDA_MODULE_GLOBALS.join(", ")} (plus ${LAMBDA_GLOBALS.join(" / ")}, fetch, Buffer, ` +
          `TextEncoder). (issues #221, #265)`,
      );
    }
    // Name what the author actually declared, not the keyword in front of it.
    const declared = /^(?:const|let|var|function|class|async)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(mask.slice(i))?.[1];
    throw new Error(
      `${PREFIX}: ${path} declares \`${declared ?? word}\` at the top level, and only the default export's BODY is ` +
        `sent to the engine — anything beside it is undefined at runtime, and the engine returns that failure as ` +
        `diagnostic text in the value slot rather than as an error. Move it inside the default-exported function. ` +
        `(issue #221)`,
    );
  }
}

/**
 * Length of the function expression starting at the beginning of `mask`.
 *
 * A block body ends at the `{` … `}` that closes it; a concise body ends at the
 * first `;` or newline outside every bracket. Bracket-depth counting over the
 * masked source, so a brace inside a string or a comment is not mistaken for
 * either.
 */
function functionExtent(mask: string): number {
  let depth = 0;
  let seenBody = false;
  for (let i = 0; i < mask.length; i++) {
    const ch = mask[i] ?? "";
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      if (ch === "{" && depth === 1) seenBody = true;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      // The closing brace of the body block ends the function.
      if (depth === 0 && ch === "}" && seenBody) return i + 1;
      continue;
    }
    if (depth === 0 && (ch === ";" || ch === "\n")) return i;
  }
  return mask.length;
}

/**
 * Read a lambda body from its own module.
 *
 * `path` resolves against the CALLING module's directory (like an `import`), not
 * the process working directory. The file must default-export exactly one
 * function; its body is extracted and validated exactly as {@link lam.fn}'s is.
 */
export function file(path: string, opts?: LambdaOptions<Record<string, CaptureValue>>): Value {
  const resolved = isAbsolute(path) ? path : resolve(callerDir(), path);

  let source: string;
  try {
    source = readFileSync(resolved, "utf8");
  } catch {
    throw new Error(
      `${PREFIX}: cannot read ${resolved} (resolved from ${JSON.stringify(path)}, relative to the calling module ` +
        `rather than the working directory). (issue #221)`,
    );
  }

  const mask = maskNonCode(source);
  assertOnlyDefaultExport(mask, resolved);

  const marker = /(^|[;}\n])\s*export\s+default\s+/.exec(mask);
  if (marker === null) {
    throw new Error(
      `${PREFIX}: ${resolved} has no \`export default\`. A lambda module is one default-exported function whose ` +
        `first parameter destructures the bindings — \`export default ({ $this }: LambdaBindings<"map">) => …\`. ` +
        `(issue #221)`,
    );
  }
  if (mask.slice(marker.index + marker[0].length).match(/(^|[;}\n])\s*export\s+default\s+/)) {
    throw new Error(`${PREFIX}: ${resolved} has more than one \`export default\`.`);
  }

  const start = marker.index + marker[0].length;
  const afterMask = mask.slice(start);
  if (!/^\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$])/.test(afterMask)) {
    throw new Error(
      `${PREFIX}: ${resolved} default-exports something that is not a function. Export the lambda itself: ` +
        `\`export default ({ $this }: LambdaBindings<"map">) => …\`. (issue #221)`,
    );
  }

  // Slice to the END of the exported function, not to the file's last `}`. A
  // module may legitimately declare a type after its default export, and taking
  // the last brace would swallow it into the body — silently, and only sometimes
  // as a syntax error.
  const end = start + functionExtent(afterMask);
  return lambdaValue(extractFunctionBody(source.slice(start, end), PREFIX), opts, `${PREFIX}(${path})`);
}

/**
 * Lambda authoring, with the filesystem form attached.
 *
 * Identical to the `lam` exported from `@sidestep/core`, plus {@link file}. The
 * isomorphic entry deliberately does not carry it: reading a file is not
 * something a browser bundle can do, and a workspace definition shared with a
 * frontend must keep resolving.
 */
export const lam = { ...isomorphicLam, file };
