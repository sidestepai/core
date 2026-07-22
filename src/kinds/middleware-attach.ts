/**
 * Middleware **attachment** (U-mw) — the pre/post hooks a host primitive runs
 * around its own stack. Distinct from the middleware *object* (`middleware.ts`,
 * the reusable logic unit) and from the inline `middleware.call` statement
 * (`mvp:workspace_run_middleware`, a stack call).
 *
 * An attachment entry is an ordinary stack item whose statement is
 * **`mvp:middleware`** with `context.middleware.id` = the target middleware's
 * guid (the engine remaps guid→local id on import). Verified against the live
 * xdo corpus: `cloud-client …/process/schema:function/minimal/DEV-4553.json`
 * shows each `middleware.pre[]` entry carrying the full 12-key `StackItemXdo`
 * envelope (`query.yaml` types `pre[]`/`post[]` as `mvp_stackitem`, the same as
 * the main `run[]` stack). So entries flow through `encodeStatement` — never a
 * hand-built minimal literal.
 *
 * Inheritance is the engine's job (`Middleware::getMiddlewareForObject`), not
 * ours: SideStep only emits each tier's list plus the `pre_customize`/
 * `post_customize` override flags. Presence-driven: providing a phase's list
 * sets that phase's `_customize` flag (override); omitting it leaves the flag
 * `false` (inherit from the parent tier). An explicit empty list (`pre: []`, or
 * `middleware.clear()`) is "override with nothing — stop inheriting".
 */
import type { StackItemXdo } from "../types/xdo.js";
import { encodeStatement, registerStatement } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { resolveRef } from "../refs/guid.js";
import type { ObjectRef } from "../refs/guid.js";
import { emptyMiddleware } from "./common.js";
import type { MiddlewareBlock } from "./common.js";

/**
 * A single pre/post attachment. Either a bare middleware reference (a
 * `middleware()` def handle or its name) or a `{ middleware, active }` object
 * when the entry needs to be authored-but-disabled (`active: false` ⇒ stored
 * `disabled: true`, so the engine skips it while keeping it in the list).
 */
export type MiddlewareAttachEntry =
  | ObjectRef
  | { middleware: ObjectRef; active?: boolean };

/**
 * The attachment authoring shape shared by every host primitive
 * (query/function/task/tool/api-group). Each phase is an ordered list resolved
 * **independently**: a host can override `pre` while inheriting `post`.
 */
export interface MiddlewareAttach {
  pre?: MiddlewareAttachEntry[];
  post?: MiddlewareAttachEntry[];
}

/** Normalize an entry to its `{ ref, active }` parts. */
function parseEntry(entry: MiddlewareAttachEntry): { ref: ObjectRef; active?: boolean } {
  // The `{ middleware, active }` wrapper is the only non-ObjectRef form; a string
  // or a `{ name, guid? }` def handle is already an ObjectRef.
  if (typeof entry === "object" && "middleware" in entry) {
    return { ref: entry.middleware, active: entry.active };
  }
  return { ref: entry };
}

/**
 * The `mvp:middleware` attachment statement factory (pre-encode `Statement`).
 * Registered so `encodeStatement` accepts it. `context.middleware.id` resolves
 * to the target's guid via the shared reference resolver, so a rename
 * round-trips through the identity/lock layer.
 */
function middlewareAttachStatement(args: { middleware: ObjectRef; active?: boolean }): Statement {
  return {
    name: "mvp:middleware",
    context: { middleware: { id: resolveRef("middleware", args.middleware) } },
    ...(args.active === false ? { disabled: true } : {}),
  };
}
registerStatement("mvp:middleware", middlewareAttachStatement);

/** Encode one attachment entry into the full stored `StackItemXdo` envelope. */
export function encodeMiddlewareEntry(entry: MiddlewareAttachEntry): StackItemXdo {
  const { ref, active } = parseEntry(entry);
  return encodeStatement(middlewareAttachStatement({ middleware: ref, active }));
}

/**
 * Build the object-level {@link MiddlewareBlock} from an authoring
 * {@link MiddlewareAttach}. Omitted → the empty block (both `_customize:false`,
 * both lists `[]`) byte-identical to {@link emptyMiddleware}, so a host with no
 * middleware emits exactly as before. A phase present (even an empty array)
 * sets that phase's `_customize` flag.
 */
export function buildMiddlewareBlock(attach?: MiddlewareAttach): MiddlewareBlock {
  if (!attach) return emptyMiddleware();
  return {
    pre_customize: attach.pre !== undefined,
    post_customize: attach.post !== undefined,
    pre: encodeMiddlewareList(attach.pre),
    post: encodeMiddlewareList(attach.post),
  };
}

/**
 * Encode a bare list of attachment entries into stored stack items. Used by the
 * workspace tier, whose `{objType}_{phase}` map holds the same entries but with
 * no per-phase `_customize` flag (workspace is the terminal fallback).
 */
export function encodeMiddlewareList(entries?: MiddlewareAttachEntry[]): StackItemXdo[] {
  return (entries ?? []).map(encodeMiddlewareEntry);
}

/**
 * An explicit empty override — the readable spelling of `[]`. `pre: clear()`
 * means "customize this phase, run no middleware" (stop inheriting the parent
 * tier's chain), as opposed to omitting the phase (inherit).
 */
export function clear(): MiddlewareAttachEntry[] {
  return [];
}
