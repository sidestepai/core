/**
 * Response → `result[]` mapping, shared by every response-bearing kind
 * (function, query, tool, middleware, and the response-bearing triggers).
 * Extracted from the MVP's compile.ts so kinds beyond function can reuse it.
 */
import type { ResultItemXdo } from "../types/xdo.js";
import type { Value } from "../values/value.js";

/** A single `Value` response, or a record of named result items. */
export type ResponseDef = Value | Record<string, Value>;

function isValue(x: ResponseDef): x is Value {
  return (
    typeof (x as Value).tag === "string" &&
    "value" in (x as object) &&
    "filters" in (x as object)
  );
}

/** Map a response into `result[]`: one unnamed item for a single value, or
 * one named item per key for a record. */
export function encodeResponse(response: ResponseDef | undefined): ResultItemXdo[] {
  if (response === undefined) {
    return [];
  }
  if (isValue(response)) {
    return [
      { filters: response.filters, name: "", tag: response.tag, value: response.value, _xsid: "", disabled: false },
    ];
  }
  return Object.entries(response).map(([name, value]) => ({
    filters: value.filters,
    name,
    tag: value.tag,
    value: value.value,
    _xsid: "",
    disabled: false,
  }));
}
