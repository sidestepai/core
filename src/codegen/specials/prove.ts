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
import { call, spread, type Expr } from "../print.js";
import { deepEqual } from "../field.js";
import { applyPassthrough, envelopePassthrough } from "../envelope-passthrough.js";
import { declineHere, recordProveAbort, recordProveDecline } from "../prove-diff.js";
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
  if (!factory) return declineHere(`${path}: no such factory on \`s\``);

  // `description` and `disabled` are authored in the editor but are not arguments
  // to any hand-written factory, so they are overridden on the result and spread
  // over the emitted call. See {@link envelopePassthrough}.
  const passthrough = envelopePassthrough(stored);

  let encoded: StackItemXdo;
  let entries: ReadonlyArray<readonly [string, Expr]> = passthrough.entries;
  try {
    const applied = applyPassthrough(factory(...runtime), passthrough);
    entries = applied.entries;
    encoded = encodeStatement(applied.statement);
  } catch (error) {
    recordProveAbort("special", stored.name, `factory threw: ${String(error)}`);
    // The authoring surface rejected the recovered arguments. That message is
    // written for a human and names the exact conflict, so it beats "could not
    // reproduce" by a wide margin — carried through to the fallback report.
    return ctx.declined(
      `the recovered arguments were rejected by the authoring surface — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!deepEqual(normalize(encoded), normalize(stored))) {
    recordProveDecline("special", stored.name, normalize(encoded), normalize(stored));
    return null;
  }
  ctx.use(CORE_MODULE, "s");
  const expression = call(`s.${path}`, ...sourceArgs);
  return entries.length > 0 ? spread(expression, entries) : expression;
}

// Re-exported so a decoder imports its guard recorder from the same place it
// imports `prove` — the two are halves of one contract.
export { declineHere } from "../prove-diff.js";

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

/**
 * The report line for a blank reference (`table`/`addon`/`fn`/…), worded from
 * what the bundle can actually prove.
 *
 * A blank reference has two possible causes and the bytes cannot tell them
 * apart: the target was deleted or never bound, or it was a real target the
 * export-side remap blanked because it sat outside a scoped export. But the
 * BUNDLE can tell them apart — a whole-workspace export has no outside, so the
 * second cause is impossible there and the line says so plainly rather than
 * hedging and suggesting a re-pull that cannot help. All 177 workspaces in the
 * survey corpus are whole-workspace exports, so the hedge was the wrong wording
 * every time it was shown.
 */
export function blankRefDetail(a: SpecialArgs, what: string, noun: string): string {
  const recovered = `${what}, recovered as \`${noun}: null\`; `;
  return a.refs.wholeWorkspace
    ? `${recovered}this is a whole-workspace export, so the ${noun} is not merely out of ` +
      `scope — it was deleted, or the binding was never made. Fix it upstream or bind a ${noun}`
    : `${recovered}the ${noun} was deleted or unbound, OR it sits outside this export's scope ` +
      `and was blanked on the way out — re-pull with the ${noun} in scope to tell the two apart`;
}
