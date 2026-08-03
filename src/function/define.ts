/**
 * `defineFunction` + the in-memory `FunctionDef` model (U6).
 *
 * The authoring API is a flat declarative factory (KTD-3): data in → JSON out,
 * no hidden control-flow inference.
 */
import type { InputDescriptor } from "../inputs/input.js";
import type { Statement } from "../statements/statement.js";
import type { ResponseDef } from "../responses/response.js";
import type { MiddlewareAttach } from "../kinds/middleware-attach.js";
import type { HistoryInput } from "../kinds/history.js";
import type { CacheXdo } from "../types/xdo.js";

export type { ResponseDef };

/**
 * Like {@link QueryDef}, `FunctionDef` is generic over its `input` map `I` so a
 * consumer can recover the exact, branded input types via
 * `InferInput<typeof myFunction>`, and over its declared response shape `Res` so
 * `InferResponse<typeof myFunction>` recovers the read shape (functions share
 * the response system with queries). Both default so every bare-`FunctionDef`
 * use works unchanged; `Res` defaults to `never` (undeclared → derivation).
 */
export interface FunctionDef<
  I extends Record<string, InputDescriptor> = Record<string, InputDescriptor>,
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  S extends readonly Statement[] = readonly Statement[],
> {
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  docs?: string;
  /** Deploy-target workspace id. Defaults to 0 (binding deferred). */
  workspace?: number;
  input?: I;
  /** The statement stack, captured as the literal tuple `S` — see
   * {@link QueryDef.stack}. Enables `InferResponse`'s single-variable trace. */
  stack?: S;
  /** The response assignment — see {@link QueryDef.response}. Captured as `Resp`
   * so `InferResponse` can auto-derive object-literal keys / trace a variable. */
  response?: Resp;
  /**
   * Type-only: declare the function's response shape so
   * `InferResponse<typeof fn>` recovers it exactly (the override, taking
   * precedence over automatic derivation). The runtime value is ignored by the
   * encoder; only its type is read. See {@link QueryDef.responseShape}.
   */
  responseShape?: Res;
  /**
   * Pre/post middleware attachment. Functions have no API-Group tier — an
   * un-customized phase inherits straight from the workspace. Providing a phase
   * sets its `_customize` flag; `pre: middleware.clear()` overrides with nothing.
   */
  middleware?: MiddlewareAttach;
  /**
   * Request-history capture. Omit to inherit from the workspace (functions have
   * no container tier). A scalar: `false` off, `true` on at default depth, a
   * number = capture depth, `"all"` unlimited. Any value stops inheriting.
   * Functions default OFF. See {@link HistoryInput}.
   */
  history?: HistoryInput;
  /** Workspace tags (stored `tag: [{tag}]`), e.g. `["xano:quick-start"]`. */
  tags?: string[];
  /**
   * Response caching, in the same block a query carries — the engine reads a
   * function's `cache` through the same path (`convertFunctionToConfig` hands it
   * straight to the runtime config). Omit for the engine's default (inactive).
   *
   * Modelled because it was NOT authorable and the encoder hard-coded the
   * default: a pulled function with caching switched on re-exported with it OFF,
   * so a redeploy silently turned real caching off. See {@link QueryDef.cache}.
   */
  cache?: Partial<CacheXdo>;
}

/**
 * Validate and return a typed `FunctionDef`, preserving the exact branded `input`
 * map on the return type so `InferInput<typeof theFunction>` recovers the input
 * payload type (functions share the input system with queries).
 */
export function defineFunction<
  const I extends Record<string, InputDescriptor> = Record<never, never>,
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  const S extends readonly Statement[] = readonly Statement[],
>(def: FunctionDef<I, Res, Resp, S>): FunctionDef<I, Res, Resp, S> {
  if (!def.name || typeof def.name !== "string") {
    throw new Error("defineFunction: `name` is required and must be a non-empty string.");
  }
  return def;
}
