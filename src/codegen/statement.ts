/**
 * Statement dispatch.
 *
 * The order is `registered special decoder → spec-inverse from GENERATED_SPECS →
 * raw()` (KTD-5). Specials come first because several families have hand-written
 * encoders whose stored shape a naive spec inversion would mangle.
 *
 * Every arm is proof-carrying: a decoder returns a source expression only when
 * that expression demonstrably re-encodes to the stored statement, so falling
 * through costs readability and never fidelity. `raw()` is the terminal arm and
 * is exact by construction, which is why the round trip stays green no matter
 * how much of the catalog is modelled.
 */
import type { StackItemXdo } from "../types/xdo.js";
import type { Statement } from "../statements/statement.js";
import { raw } from "../statements/special/raw.js";
import { CODEGEN_MODULE, type DecodeContext } from "./context.js";
import { arr, call, lit, type Expr } from "./print.js";
import type { RefIndex, ResolveOptions } from "./ref-index.js";
import { decodeFromSpec } from "./spec-inverse.js";
import { SPECIAL_DECODERS } from "./specials/index.js";
import { withDeclineContext } from "./prove-diff.js";

/** Decode one stored statement to a source expression. */
export function decodeStatement(
  ctx: DecodeContext,
  refs: RefIndex,
  stored: StackItemXdo,
  resolve: ResolveOptions = {},
): Expr {
  // Guards inside the arms below report against this name (see `declineHere`).
  return withDeclineContext(stored.name, () => dispatch(ctx, refs, stored, resolve));
}

/** The dispatch proper: special decoder → spec inverse → `raw()`. */
function dispatch(
  ctx: DecodeContext,
  refs: RefIndex,
  stored: StackItemXdo,
  resolve: ResolveOptions,
): Expr {
  const special = SPECIAL_DECODERS.get(stored.name);
  if (special) {
    const decoded = ctx.speculate(() =>
      special({
        ctx,
        refs,
        stored,
        resolve,
        decodeStack: (run) => decodeNested(ctx, refs, run, resolve),
      }),
    );
    if (decoded) return decoded;
  }

  const fromSpec = ctx.speculate(() => decodeFromSpec(ctx, stored));
  if (fromSpec) return fromSpec;

  const name = (stored as { name?: unknown }).name;
  ctx.problem("raw-fallback", `${typeof name === "string" ? name : "(unnamed)"} has no decoder`);
  ctx.use(CODEGEN_MODULE, "raw");
  return call("raw", lit(stored));
}

/**
 * Decode a nested `run[]` for a recursive family.
 *
 * Returns the source expressions *and* the runtime statements side by side: the
 * enclosing decoder needs the latter to prove its own call, and both must
 * describe the same stack. The runtime side rebuilds each child through `raw()`
 * rather than re-deriving it, so proving an outer statement never depends on how
 * well its children decoded — a `raw()` child at depth still lets the loop or
 * conditional around it come out readable.
 */
function decodeNested(
  ctx: DecodeContext,
  refs: RefIndex,
  run: unknown,
  resolve: ResolveOptions,
): { exprs: Expr[]; statements: Statement[] } {
  const items = Array.isArray(run) ? (run as StackItemXdo[]) : [];
  return {
    exprs: items.map((item, i) =>
      ctx.at(`run[${i}]`, () => decodeStatement(ctx, refs, item, resolve)),
    ),
    statements: items.map((item) => raw(item as unknown as Record<string, unknown>)),
  };
}

/** Decode a stored `run[]` stack, tagging report entries with each index. */
export function decodeStack(
  ctx: DecodeContext,
  refs: RefIndex,
  run: unknown,
  resolve: ResolveOptions = {},
): Expr {
  const items = Array.isArray(run) ? (run as StackItemXdo[]) : [];
  return arr(
    items.map((item, i) =>
      ctx.at(`stack[${i}]`, () => decodeStatement(ctx, refs, item, resolve)),
    ),
  );
}
