/**
 * The `function` object kind (KTD-2). This is the MVP's `compile()` envelope
 * logic, re-homed as the first registered kind. Behavior is unchanged — the
 * MVP golden test is the regression guard.
 */
import type { FunctionXdo } from "../types/xdo.js";
import type { FunctionDef } from "../function/define.js";
import { encodeInput } from "../inputs/input.js";
import { encodeStatement } from "../statements/statement.js";
import { encodeResponse, warnUnboundReturn } from "../responses/response.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";
import { encodeHistory } from "./history.js";
import { buildMiddlewareBlock } from "./middleware-attach.js";
import { defaultCache } from "./query.js";

/** Encode a `FunctionDef` into the flattened importable function `xdo`. */
export function encodeFunction(fn: FunctionDef): FunctionXdo {
  if (!fn.name) {
    throw new Error("function kind: `name` is required.");
  }
  warnUnboundReturn("function", fn.name, fn.stack, fn.response);
  return {
    name: fn.name,
    description: fn.description ?? "",
    docs: fn.docs ?? "",
    workspace: { id: fn.workspace ?? 0 },
    branch: { id: 0 },
    cache: defaultCache(fn.cache),
    history: encodeHistory("function", fn.history),
    middleware: buildMiddlewareBlock(fn.middleware),
    tag: encodeTags(fn.tags),
    input: Object.entries(fn.input ?? {}).map(([name, descriptor]) =>
      encodeInput(name, descriptor),
    ),
    result: encodeResponse(fn.response),
    run: (fn.stack ?? []).map(encodeStatement),
    test: [],
    market_item: { id: 0, version: 0, guid: "" },
    shared_workspace: { is_shared: false },
  };
}

export const functionKind: ObjectKind<FunctionDef, FunctionXdo> = {
  name: "function",
  payloadKey: "function",
  encode: encodeFunction,
};

registerKind(functionKind);
