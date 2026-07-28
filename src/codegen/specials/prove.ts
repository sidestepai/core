/**
 * The specials decoders' shared machinery.
 *
 * Every hand-written encoder has a hand-written inverse here, and each one is
 * held to the same contract as the spec arm: build a candidate, call the very
 * `s.<path>` factory the generated source will call, re-encode, and compare
 * against the stored statement. A decoder that guesses wrong produces `raw()`
 * output, never wrong output.
 *
 * That is what makes it safe to write these from the stored shape rather than
 * from a specification. The encoders carry non-obvious details — `nestedValueFields`
 * omitting an empty `filters`, an empty `settings_registry` canonicalized to
 * `null` — and getting one subtly wrong is caught here instead of on a user's
 * workspace.
 */
import type { StackItemXdo } from "../../types/xdo.js";
import { s } from "../../statements/s.js";
import { encodeStatement, type Statement } from "../../statements/statement.js";
import { normalize } from "../../validate/normalize.js";
import { CORE_MODULE, type DecodeContext } from "../context.js";
import { call, lit, spread, type Expr } from "../print.js";
import { deepEqual } from "../field.js";
import type { RefIndex, ResolveOptions } from "../ref-index.js";

/** What a special decoder is handed. */
export interface SpecialArgs {
  readonly ctx: DecodeContext;
  readonly refs: RefIndex;
  readonly stored: StackItemXdo;
  readonly resolve: ResolveOptions;
  /** Decode a nested `run[]` back through the full dispatch (for recursive families). */
  readonly decodeStack: (run: unknown) => { exprs: Expr[]; statements: Statement[] };
}

/** A decoder for one stored statement name. Returns null to fall through. */
export type SpecialDecoder = (args: SpecialArgs) => Expr | null;

/** Resolve a dotted `s.` path to its callable leaf. */
function leafOf(path: string): ((...args: unknown[]) => Statement) | null {
  const leaf = path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node === null || node === undefined ? undefined : (node as Record<string, unknown>)[key],
      s,
    );
  return typeof leaf === "function" ? (leaf as (...args: unknown[]) => Statement) : null;
}

/**
 * Emit `s.<path>(...)` only if calling it with `runtime` reproduces `stored`.
 *
 * `runtime` and `sourceArgs` are parallel: the former is what the factory is
 * actually called with, the latter is what the generated file will read. They
 * must describe the same call — which is exactly what the comparison verifies,
 * because the source is evaluated back through the same factory in tests.
 */
export function prove(
  ctx: DecodeContext,
  stored: StackItemXdo,
  path: string,
  runtime: readonly unknown[],
  sourceArgs: readonly Expr[],
): Expr | null {
  const factory = leafOf(path);
  if (!factory) return null;

  // A per-statement `description` is persisted by the engine and common in real
  // workspaces, but **no hand-written statement factory takes one** — only the
  // declarative specs route it as a field. Without this, every annotated
  // statement in a pulled workspace would fall through to `raw()`, which is a
  // large and entirely avoidable readability loss. `Statement.description` is
  // part of the type, so overriding it on the factory's result is exact, and the
  // comparison below still has to agree.
  const description = (stored as { description?: unknown }).description;
  const annotated = typeof description === "string" && description !== "";

  let encoded: StackItemXdo;
  try {
    const built = factory(...runtime);
    encoded = encodeStatement(annotated ? { ...built, description } : built);
  } catch {
    return null;
  }
  if (!deepEqual(normalize(encoded), normalize(stored))) return null;
  ctx.use(CORE_MODULE, "s");
  const expression = call(`s.${path}`, ...sourceArgs);
  return annotated ? spread(expression, [["description", lit(description)]]) : expression;
}

/** Read a dotted path out of a stored object. */
export function getPath(root: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node === null || node === undefined ? undefined : (node as Record<string, unknown>)[key],
      root,
    );
}
