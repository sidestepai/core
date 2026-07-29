/**
 * Project assembly — decoded objects → a tree of source files.
 *
 * Three problems live here, none of which a per-object decoder can see:
 *
 * - **Symbols.** Xano names are not identifiers. They carry spaces, hyphens,
 *   leading digits, and they collide across kinds (a `users` table and a `users`
 *   function are both legal). Sanitization plus deterministic disambiguation
 *   happens once, up front, so every reference site agrees.
 * - **File layout.** Tables, and anything referenced from more than one file,
 *   land in `_shared.ts` — mirroring `examples/sandbox/`, and keeping the import
 *   graph shallow enough to read.
 * - **Cycles.** Two functions that call each other would import each other.
 *   `ObjectRef` already accepts `{name, guid}`, so a back edge degrades to that
 *   literal instead (KTD-8) and no circular import is ever emitted.
 *
 * The reference graph those last two need is derived from the **stored** objects,
 * not from decoding them: any guid a decoder resolves appears as a string
 * somewhere in the stored JSON, so scanning for known guids yields a superset of
 * the real edges. A superset is the safe direction — it can place an object in
 * `_shared.ts` that did not strictly need to be there, but it can never miss an
 * edge and emit a cycle.
 *
 * Everything is order-deterministic: the same bundle assembles to byte-identical
 * files, which is what lets the generated tree be compared directly in tests.
 */
import type { DecodeContext } from "./context.js";
import { CORE_MODULE } from "./context.js";
import { printExpr, printModule, type Expr, type Stmt } from "./print.js";
import type { GeneratedFile } from "./index.js";
import type { IndexedObject, RefIndex } from "./ref-index.js";
import {
  decodeObject,
  KIND_DECODERS,
  KIND_DECODERS_BY_NAME,
  type StoredObject,
} from "./kinds/index.js";

/** The file cross-referenced objects and every table share. */
const SHARED_FILE = "_shared.ts";

/** One object placed in the generated tree. */
interface Placement {
  readonly object: IndexedObject;
  readonly stored: StoredObject;
  /** Exported binding name. */
  readonly symbol: string;
  /** File path relative to the output root. */
  readonly path: string;
  /** Directory the file sits in, for relative-specifier construction. */
  readonly dir: string;
}

/**
 * Identifiers a generated file imports from the SDK, which an object symbol must
 * therefore never take.
 *
 * A Xano workspace may legally hold a table named `table` or a function named
 * `query`, and its symbol would otherwise shadow the factory the file imports to
 * build it — `const table = table({…})` is a TDZ crash, not a type error, so it
 * would ship. Reserving the names up front pushes the object to `table_table`,
 * reusing the same disambiguation the cross-kind case already applies.
 *
 * Covers the factories, the barrel's `workspace`, and the value helpers a decoded
 * expression can reach for.
 */
const RESERVED_SYMBOLS: readonly string[] = [
  // factories (KIND_DECODERS[].factory) + the barrel's own import
  "table",
  "defineFunction",
  "query",
  "apiGroup",
  "task",
  "middleware",
  "tool",
  "mcpServer",
  "agent",
  "workspaceConfig",
  "addon",
  "realtimeServer",
  "realtimeChannel",
  "realtimeMessage",
  "workspace",
  // value helpers emitted inside def literals
  "s",
  "c",
  "ref",
  "inp",
  "obj",
  "arr",
  "input",
  "expr",
  "cmp",
  "raw",
];

/** The kind slot reserved names occupy, so a real object never matches it. */
const RESERVED_KIND = "\0core";

/** Turn a Xano object name into a valid TypeScript identifier. */
export function toSymbol(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]+/g, "_").replace(/^_+|_+$/g, "");
  const safe = cleaned === "" ? "object" : cleaned;
  return /^[0-9]/.test(safe) ? `_${safe}` : safe;
}

/** The tsconfig a generated tree carries so it resolves `@sidestep/core` alone. */
function tsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2022"],
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        skipLibCheck: true,
        verbatimModuleSyntax: true,
      },
      include: ["."],
    },
    null,
    2,
  )}\n`;
}

/**
 * Relative import specifier from a file in `fromDir` to a generated file.
 * Every generated file sits at the root or exactly one directory below it, so
 * the only shapes are same-directory and up-one-then-down.
 */
function specifierFrom(fromDir: string, toPath: string): string {
  const target = toPath.replace(/\.ts$/, ".js");
  if (fromDir === ".") return `./${target}`;
  return target.startsWith(`${fromDir}/`)
    ? `./${target.slice(fromDir.length + 1)}`
    : `../${target}`;
}

/**
 * Guids do not always sit in a string by themselves.
 *
 * `f.tableRef` stores its target as a *prefixed* field-method argument —
 * `{name: "@", arg: ["dbo=<guid>"]}` — so scanning for bare guid strings misses
 * the edge entirely. That miss is not cosmetic: the reference still decodes to a
 * symbol, but the graph never learns about it, so declaration ordering does not
 * account for it and the generated file crashes on load with a
 * temporal-dead-zone error. (Found on the first real pulled workspace: a
 * `post_tag` join table declared above the `tag` table it references.)
 *
 * Taking the tail after a `=` covers that form and any future one shaped like
 * it, and costs nothing when the string is a plain guid.
 */
function guidCandidates(value: string): string[] {
  const separator = value.lastIndexOf("=");
  return separator === -1 ? [value] : [value, value.slice(separator + 1)];
}

/**
 * Every guid in `stored` that the index recognises — a superset of the object's
 * real outbound references (see the module header on why a superset is safe).
 */
function referencedGuids(stored: unknown, refs: RefIndex, into: Set<string>): Set<string> {
  if (typeof stored === "string") {
    for (const candidate of guidCandidates(stored)) {
      if (refs.lookup(candidate)) into.add(candidate);
    }
    return into;
  }
  if (Array.isArray(stored)) {
    for (const item of stored) referencedGuids(item, refs, into);
    return into;
  }
  if (stored !== null && typeof stored === "object") {
    for (const value of Object.values(stored)) referencedGuids(value, refs, into);
  }
  return into;
}

/** A decodable object, before a symbol or a file has been chosen for it. */
interface Candidate {
  readonly object: IndexedObject;
  readonly stored: StoredObject;
  readonly dir: string;
  /** Guids this object refers to. */
  readonly edges: ReadonlySet<string>;
}

/** Collect every object the decode registry can handle, in a deterministic order. */
function candidates(refs: RefIndex, payload: Record<string, unknown>): Candidate[] {
  const out: Candidate[] = [];
  for (const decoder of KIND_DECODERS) {
    if (decoder.name === "workspace") continue;
    const section = payload[decoder.payloadKey];
    if (!Array.isArray(section)) continue;
    for (const entry of section) {
      if (entry === null || typeof entry !== "object") continue;
      const stored = entry as StoredObject;
      const object = refs.lookup(typeof stored.guid === "string" ? stored.guid : "");
      // Only objects the index recognised are placed. It already reported the
      // ones it could not identify, so silence here is not silence overall.
      if (!object || object.kind !== decoder.name) continue;
      out.push({
        object,
        stored,
        dir: decoder.dir,
        edges: referencedGuids(stored, refs, new Set()),
      });
    }
  }
  return out;
}

/**
 * Assign each candidate a unique TypeScript symbol.
 *
 * A *cross-kind* collision — a `users` table and a `users` function, both legal
 * in Xano — is disambiguated by kind, which reads far better than an ordinal.
 * A same-kind collision has no such distinguishing word (three functions named
 * `my fn`, `my-fn`, and `my_fn` all sanitize alike), so it falls to ordinals.
 * Both resolve in placement order, so the same bundle always produces the same
 * symbols.
 */
function assignSymbols(list: readonly Candidate[]): string[] {
  const used = new Map<string, string>();
  for (const name of RESERVED_SYMBOLS) used.set(name, RESERVED_KIND);
  return list.map((candidate) => {
    const base = toSymbol(String(candidate.stored.name ?? ""));
    const kind = candidate.object.kind;
    let symbol = base;
    const holder = used.get(symbol);
    if (holder !== undefined && holder !== kind) symbol = `${base}_${kind}`;
    for (let n = 2; used.has(symbol); n += 1) symbol = `${base}_${n}`;
    used.set(symbol, kind);
    return symbol;
  });
}

/**
 * Choose a file for every candidate, then resolve the symbol/path each guid maps
 * to. Tables and multiply-referenced objects share `_shared.ts`.
 */
function place(refs: RefIndex, payload: Record<string, unknown>): Placement[] {
  const list = candidates(refs, payload);
  const symbols = assignSymbols(list);

  // How many *distinct other objects* refer to each guid. Self-references do not
  // count: an object referring to itself is not a cross-file edge.
  const referrers = new Map<string, number>();
  for (const candidate of list) {
    for (const guid of candidate.edges) {
      if (guid === candidate.object.guid) continue;
      referrers.set(guid, (referrers.get(guid) ?? 0) + 1);
    }
  }

  return list.map((candidate, i) => {
    const symbol = symbols[i]!;
    // Tables are shared unconditionally: nearly every statement family binds one,
    // so leaving them scattered makes the import graph unreadable even when a
    // given table happens to be referenced once.
    const shared = candidate.object.kind === "table" || (referrers.get(candidate.object.guid) ?? 0) > 1;
    return {
      object: candidate.object,
      stored: candidate.stored,
      symbol,
      dir: shared ? "." : candidate.dir,
      path: shared ? SHARED_FILE : `${candidate.dir}/${symbol}.ts`,
    };
  });
}

/**
 * The reference edges that must NOT become imports, keyed `fromPath → guid`.
 *
 * Files form a directed graph once placements are known; a depth-first walk in
 * placement order marks every edge that closes a cycle. Marking the edge that
 * *closes* the cycle (rather than an arbitrary one) means the back edge is
 * chosen deterministically, and exactly one edge per cycle is degraded.
 */
function findBackEdges(placements: readonly Placement[], edges: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const byGuid = new Map(placements.map((p) => [p.object.guid, p]));
  const byPath = new Map<string, Placement[]>();
  for (const placement of placements) {
    const group = byPath.get(placement.path) ?? [];
    group.push(placement);
    byPath.set(placement.path, group);
  }

  const back = new Set<string>();
  const state = new Map<string, "open" | "done">();

  const visit = (path: string): void => {
    state.set(path, "open");
    for (const placement of byPath.get(path) ?? []) {
      for (const guid of edges.get(placement.object.guid) ?? []) {
        const target = byGuid.get(guid);
        if (!target || target.path === path) continue;
        const status = state.get(target.path);
        if (status === "open") {
          back.add(`${path} ${guid}`);
          continue;
        }
        if (status === undefined) visit(target.path);
      }
    }
    state.set(path, "done");
  };

  for (const placement of placements) {
    if (!state.has(placement.path)) visit(placement.path);
  }
  return back;
}

/**
 * Order the placements inside one file so a binding is declared before it is
 * referenced, and report the intra-file edges that cannot be ordered.
 *
 * `const` is not hoisted, so a same-file reference to a binding declared further
 * down is a temporal-dead-zone crash at import — not a type error, and invisible
 * to a round trip that never loads the tree. Dependencies are emitted first
 * (DFS post-order); an edge closing an intra-file cycle is degraded to the same
 * `{name, guid}` literal the cross-file case uses.
 */
function orderWithinFile(
  group: readonly Placement[],
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): { ordered: Placement[]; back: Set<string> } {
  const byGuid = new Map(group.map((p) => [p.object.guid, p]));
  const ordered: Placement[] = [];
  const back = new Set<string>();
  const state = new Map<string, "open" | "done">();

  const visit = (placement: Placement): void => {
    state.set(placement.object.guid, "open");
    for (const guid of edges.get(placement.object.guid) ?? []) {
      const target = byGuid.get(guid);
      if (!target || target.object.guid === placement.object.guid) continue;
      const status = state.get(guid);
      if (status === "open") {
        back.add(`${placement.object.guid} ${guid}`);
        continue;
      }
      if (status === undefined) visit(target);
    }
    state.set(placement.object.guid, "done");
    ordered.push(placement);
  };

  for (const placement of group) {
    if (!state.has(placement.object.guid)) visit(placement);
  }
  return { ordered, back };
}

/** Decode every object in a bundle payload and assemble the generated tree. */
export function assembleProject(
  ctx: DecodeContext,
  refs: RefIndex,
  payload: Record<string, unknown>,
): GeneratedFile[] {
  const placed = place(refs, payload);
  const edges = new Map(
    placed.map((p) => [p.object.guid, referencedGuids(p.stored, refs, new Set())] as const),
  );
  const backEdges = findBackEdges(placed, edges);

  // Reorder each file's declarations so same-file references resolve, collecting
  // the intra-file edges that had to be degraded along the way. The barrel and
  // the ref map are built from the reordered list so every view agrees.
  const grouped = new Map<string, Placement[]>();
  for (const placement of placed) {
    const group = grouped.get(placement.path) ?? [];
    group.push(placement);
    grouped.set(placement.path, group);
  }
  const placements: Placement[] = [];
  const sameFileBackEdges = new Set<string>();
  for (const group of grouped.values()) {
    const { ordered, back } = orderWithinFile(group, edges);
    placements.push(...ordered);
    for (const edge of back) sameFileBackEdges.add(edge);
  }
  const byGuid = new Map(placements.map((p) => [p.object.guid, p]));

  // Several placements can share one file (`_shared.ts`), so a file's imports and
  // its declarations accumulate across placements and are printed once at the end.
  const files = new Map<string, { imports: ReturnType<DecodeContext["beginFile"]>; body: Stmt[] }>();

  for (const placement of placements) {
    const decoder = KIND_DECODERS_BY_NAME.get(placement.object.kind)!;
    let file = files.get(placement.path);
    if (!file) {
      file = { imports: ctx.beginFile(), body: [] };
      files.set(placement.path, file);
    }
    ctx.imports = file.imports;
    if (decoder.factory) file.imports.use(CORE_MODULE, decoder.factory);
    else file.imports.useType(CORE_MODULE, decoder.defType);

    const expr = ctx.inObject(`${decoder.name}:${placement.object.name}`, () =>
      decodeObject(decoder, {
        ctx,
        refs,
        stored: placement.stored,
        resolve: {
          symbolFor: (target) => {
            const found = byGuid.get(target.guid);
            if (!found) return null;
            // Same file: reference the binding directly, no import — unless the
            // declaration order could not put it first, or it is this object.
            if (found.path === placement.path) {
              if (found.symbol === placement.symbol) return null;
              return sameFileBackEdges.has(`${placement.object.guid} ${target.guid}`)
                ? null
                : found.symbol;
            }
            // The KTD-8 escape: importing this would close a cycle, so the
            // reference degrades to a `{name, guid}` literal instead.
            if (backEdges.has(`${placement.path} ${target.guid}`)) return null;
            file!.imports.use(specifierFrom(placement.dir, found.path), found.symbol);
            return found.symbol;
          },
        },
      }),
    );

    if (file.body.length > 0) file.body.push({ kind: "blank" });
    file.body.push(
      {
        kind: "comment",
        text: `${decoder.name} "${placement.object.name}" — generated from a Xano bundle.`,
      },
      {
        kind: "const",
        name: placement.symbol,
        exported: true,
        // The factory both checks the literal and runs its `const` inference, so
        // the generated symbol keeps the column/input/schema types a bare
        // `satisfies` would widen away. Kinds with no factory keep `satisfies`,
        // which still checks the literal without widening it.
        value: {
          kind: "id",
          text: decoder.factory
            ? `${decoder.factory}(${printExpr(expr)})`
            : `${printExpr(expr)} satisfies ${decoder.defType}`,
        },
      },
    );
  }

  const out: GeneratedFile[] = [];
  for (const [path, file] of files) {
    out.push({
      path,
      contents: printModule([...file.imports.toStatements(), { kind: "blank" }, ...file.body]),
    });
  }
  // Sorted so the file list itself is deterministic, not merely each file's bytes.
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  out.push({ path: "index.ts", contents: barrel(ctx, refs, payload, placements) });
  out.push({ path: "README.md", contents: readme(ctx, placements) });
  out.push({ path: "tsconfig.json", contents: tsconfig() });
  return out;
}

/** The barrel: registers every decoded object under its `register*` bucket. */
function barrel(
  ctx: DecodeContext,
  refs: RefIndex,
  payload: Record<string, unknown>,
  placements: readonly Placement[],
): string {
  const imports = ctx.beginFile();
  imports.use(CORE_MODULE, "workspace");

  // `payload.env` is hoisted out of the workspace object at export time; fold it
  // back in so the workspace decoder sees the shape its encoder produced.
  const workspaceStored: StoredObject = {
    ...((payload.workspace ?? {}) as StoredObject),
    ...(Array.isArray(payload.env) && payload.env.length > 0 ? { env: payload.env } : {}),
  };
  const workspaceName = String(workspaceStored.name ?? "workspace");
  const lines: string[] = [`workspace(${JSON.stringify(workspaceName)})`];

  if (workspaceStored.name !== undefined) {
    const decoder = KIND_DECODERS_BY_NAME.get("workspace")!;
    if (decoder.factory) imports.use(CORE_MODULE, decoder.factory);
    else imports.useType(CORE_MODULE, decoder.defType);
    const expr = ctx.inObject("workspace", () =>
      decodeObject(decoder, { ctx, refs, stored: workspaceStored, resolve: {} }),
    );
    const literal = indent(printExpr(expr));
    lines.push(
      `  .registerWorkspace(${
        decoder.factory ? `${decoder.factory}(${literal})` : `${literal} satisfies ${decoder.defType}`
      })`,
    );
  }

  for (const decoder of KIND_DECODERS) {
    if (decoder.name === "workspace") continue;
    // Register in PAYLOAD order, not placement order. `placements` is grouped by
    // file, so every `_shared.ts` member of a kind would otherwise be registered
    // ahead of the members that got their own file — silently reordering that
    // payload section on re-export. It only ever went unnoticed because the
    // shared member of each kind also happened to come first in its section.
    const members = placements
      .filter((p) => p.object.kind === decoder.name)
      .sort((a, b) => a.object.position - b.object.position);
    if (members.length === 0) continue;
    for (const member of members) {
      imports.use(`./${member.path.replace(/\.ts$/, ".js")}`, member.symbol);
    }
    lines.push(`  .${decoder.register}([${members.map((m) => m.symbol).join(", ")}])`);
  }

  return printModule([
    { kind: "comment", text: "Generated from a Xano bundle. Disposable — see README.md." },
    ...imports.toStatements(),
    { kind: "blank" },
    { kind: "exportDefault", value: { kind: "id", text: lines.join("\n") } as Expr },
  ]);
}

/**
 * The generated README.
 *
 * The three warnings are unconditional and deliberately blunt. This tree is a
 * scratch surface: regenerating it destroys hand edits, it carries schema only
 * (no seed rows, no unsupported payload sections), and deploying it runs the
 * server's clear-then-import path — a **full replace** of whatever workspace it
 * lands in. A user who reads only this file must still come away knowing not to
 * point it at a workspace holding data they care about.
 */
function readme(ctx: DecodeContext, placements: readonly Placement[]): string {
  const counts = new Map<string, number>();
  for (const placement of placements) {
    counts.set(placement.object.kind, (counts.get(placement.object.kind) ?? 0) + 1);
  }

  const lines: string[] = [
    "# Generated SideStep workspace",
    "",
    "Decoded from a Xano bundle by `sidestep … codegen`. Edit it, then deploy it to a",
    "disposable environment with `sidestep deploy`.",
    "",
    "## Read this before deploying",
    "",
    "- **This tree is disposable.** Regenerating it overwrites every file here. There is",
    "  no merge, no diff, and no preservation of hand edits — copy anything you want to",
    "  keep somewhere else first.",
    "- **Deploying is a full replace.** The import path clears the target workspace and",
    "  re-imports. Deploy this only into an ephemeral or sandbox environment — never into",
    "  a workspace holding data you care about.",
    "- **This is schema only.** Table rows are not carried, and neither are payload",
    "  sections this SDK models no kind for. A deploy recreates the structure, not the data.",
    "",
    "## What is here",
    "",
  ];
  for (const decoder of KIND_DECODERS) {
    const count = counts.get(decoder.name) ?? 0;
    if (count > 0) lines.push(`- ${count} × ${decoder.name}`);
  }
  lines.push("", "Objects referenced from more than one file, and every table, live in `_shared.ts`.", "");

  const report = ctx.report.renderMarkdown();
  lines.push(report === "" ? "Everything in the source bundle round-tripped cleanly." : report);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** Re-indent a rendered expression to sit inside the barrel's method chain. */
function indent(source: string): string {
  return source.split("\n").join("\n  ");
}
