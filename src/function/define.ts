/**
 * `defineFunction` + the in-memory `FunctionDef` model (U6).
 *
 * The authoring API is a flat declarative factory (KTD-3): data in → JSON out,
 * no hidden control-flow inference.
 */
import type { InputDescriptor } from "../inputs/input.js";
import type { Statement } from "../statements/statement.js";
import type { ResponseDef } from "../responses/response.js";

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
> {
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  docs?: string;
  /** Deploy-target workspace id. Defaults to 0 (binding deferred). */
  workspace?: number;
  input?: I;
  stack?: Statement[];
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
  /** Workspace tags (stored `tag: [{tag}]`), e.g. `["xano:quick-start"]`. */
  tags?: string[];
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
>(def: FunctionDef<I, Res, Resp>): FunctionDef<I, Res, Resp> {
  if (!def.name || typeof def.name !== "string") {
    throw new Error("defineFunction: `name` is required and must be a non-empty string.");
  }
  return def;
}
