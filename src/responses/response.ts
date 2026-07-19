/**
 * Response → `result[]` mapping, shared by every response-bearing kind
 * (function, query, tool, middleware, and the response-bearing triggers).
 * Extracted from the MVP's compile.ts so kinds beyond function can reuse it.
 */
import type { ResultItemXdo } from "../types/xdo.js";
import type { Value } from "../values/value.js";
import type { Statement } from "../statements/statement.js";

/** A single `Value` response, or a record of named result items. */
export type ResponseDef = Value | Record<string, Value>;

/**
 * Warn when a response-bearing def (query/function) has a top-level
 * `s.return(...)` (`mvp:return`) in its stack but declares no `response`. In these kinds the
 * response is driven **only** by the `response` field — `s.return` in the stack
 * does not populate it — so the def compiles cleanly into an endpoint whose
 * `result` is empty and that returns nothing, with no other signal. This is the
 * cheapest, non-breaking nudge (encoding is unchanged; see issue #1).
 *
 * Only *top-level* `mvp:return`s are flagged: a `return` nested inside a
 * `conditional`/`foreach`/`group` is a legitimate early-return and never gates
 * the declared response, so scanning the top of the stack avoids false alarms.
 */
export function warnUnboundReturn(
  kind: "query" | "function",
  name: string,
  stack: Statement[] | undefined,
  response: ResponseDef | undefined,
): void {
  if (response !== undefined) return;
  if (!stack?.some((statement) => statement?.name === "mvp:return")) return;
  console.warn(
    `sidestep: ${kind} "${name}" ends with s.return(...) but has no \`response\` field. ` +
      `A ${kind}'s response is set by the \`response:\` field only — s.return does not ` +
      `populate it, so this ${kind} returns nothing. Add \`response: <value>\` ` +
      `(e.g. \`response: ref("...")\`).`,
  );
}

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
