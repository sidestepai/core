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
 * `InferInput<typeof myFunction>`. The default keeps every bare-`FunctionDef` use
 * working unchanged.
 */
export interface FunctionDef<I extends Record<string, InputDescriptor> = Record<string, InputDescriptor>> {
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  docs?: string;
  /** Deploy-target workspace id. Defaults to 0 (binding deferred). */
  workspace?: number;
  input?: I;
  stack?: Statement[];
  response?: ResponseDef;
  /** Workspace tags (stored `tag: [{tag}]`), e.g. `["xano:quick-start"]`. */
  tags?: string[];
}

/**
 * Validate and return a typed `FunctionDef`, preserving the exact branded `input`
 * map on the return type so `InferInput<typeof theFunction>` recovers the input
 * payload type (functions share the input system with queries).
 */
export function defineFunction<const I extends Record<string, InputDescriptor> = Record<never, never>>(
  def: FunctionDef<I>,
): FunctionDef<I> {
  if (!def.name || typeof def.name !== "string") {
    throw new Error("defineFunction: `name` is required and must be a non-empty string.");
  }
  return def;
}
