/**
 * Middleware kind (U8) → payload key `middleware`. Function-like
 * (input/run/result) plus `result_type` (merge|replace) and `exception`
 * (silent|rethrow|critical). Validated against `cloud-client: …/process/
 * schema:middleware`.
 */
import type { ResultItemXdo, StackItemXdo, InputXdo } from "../types/xdo.js";
import { encodeStatement } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { encodeResponse } from "../responses/response.js";
import type { ResponseDef } from "../responses/response.js";
import { encodeInput } from "../inputs/input.js";
import type { InputDescriptor } from "../inputs/input.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags, defaultHistory } from "./common.js";

export type ResultStrategy = "merge" | "replace";
export type ExceptionPolicy = "silent" | "rethrow" | "critical";

export interface MiddlewareDef {
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  docs?: string;
  resultStrategy?: ResultStrategy;
  exceptionPolicy?: ExceptionPolicy;
  tags?: string[];
  input?: Record<string, InputDescriptor>;
  stack?: Statement[];
  response?: ResponseDef;
}

export interface MiddlewareXdo {
  name: string;
  description: string;
  docs: string;
  result_type: ResultStrategy;
  exception: ExceptionPolicy;
  history: { inherit: boolean; enabled: boolean; limit: number };
  tag: Array<{ tag: string }>;
  shared_workspace: { is_shared: boolean };
  input: InputXdo[];
  result: ResultItemXdo[];
  run: StackItemXdo[];
  test: unknown[];
}

export function encodeMiddleware(def: MiddlewareDef): MiddlewareXdo {
  if (!def.name) throw new Error("middleware: `name` is required.");
  return {
    name: def.name,
    description: def.description ?? "",
    docs: def.docs ?? "",
    result_type: def.resultStrategy ?? "merge",
    exception: def.exceptionPolicy ?? "silent",
    history: defaultHistory("middleware"),
    tag: encodeTags(def.tags),
    shared_workspace: { is_shared: false },
    input: Object.entries(def.input ?? {}).map(([name, d]) => encodeInput(name, d)),
    result: encodeResponse(def.response),
    run: (def.stack ?? []).map(encodeStatement),
    test: [],
  };
}

export const middlewareKind: ObjectKind<MiddlewareDef, MiddlewareXdo> = {
  name: "middleware",
  payloadKey: "middleware",
  encode: encodeMiddleware,
};
registerKind(middlewareKind);

export function middleware(def: MiddlewareDef): MiddlewareDef {
  return def;
}
