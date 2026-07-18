/**
 * Hand-authored `!class` control-flow / terminal statements (U10). These carry
 * PHP transforms in the engine, so they're authored by hand and validated
 * against persisted fixtures rather than codegen'd. (`conditional` — also a
 * `!class` special — already lives in `src/statements/conditional.ts`.)
 *
 * - `return` / `die` / `debug_log`: carry a single Value in `context`.
 * - `foreach_break` / `foreach_continue` / `foreach_remove`: empty `context`.
 */
import type { Statement } from "../statement.js";
import { registerStatement } from "../statement.js";
import type { Value } from "../../values/value.js";

/** Accept either a bare `Value` or the object form `{ value }` for ergonomics. */
type ValueArg = Value | { value: Value };

/** A `Value` has a `tag`; the `{ value }` wrapper does not — use that to unwrap. */
function asValue(arg: ValueArg): Value {
  return "tag" in arg ? arg : arg.value;
}

function valueContext(arg: ValueArg) {
  const value = asValue(arg);
  return { value: value.value, tag: value.tag, filters: value.filters };
}

/** `return <value>` — terminate and return a value. */
export function returnValue(value: ValueArg): Statement {
  return { name: "mvp:return", context: valueContext(value) };
}

/** `die <value>` — terminate with an error value. */
export function die(value: ValueArg): Statement {
  return { name: "mvp:die", context: valueContext(value) };
}

/** `debug_log <value>` — emit a debug log entry. */
export function debugLog(value: ValueArg): Statement {
  return { name: "mvp:debug_log", context: valueContext(value) };
}

/** `foreach_break` — break out of the enclosing loop. */
export function foreachBreak(): Statement {
  return { name: "mvp:foreach_break", context: {} };
}

/** `foreach_continue` — continue the enclosing loop. */
export function foreachContinue(): Statement {
  return { name: "mvp:foreach_continue", context: {} };
}

/** `foreach_remove` — remove the current item from the iterated collection. */
export function foreachRemove(): Statement {
  return { name: "mvp:foreach_remove", context: {} };
}

registerStatement("mvp:return", returnValue);
registerStatement("mvp:die", die);
registerStatement("mvp:debug_log", debugLog);
registerStatement("mvp:foreach_break", foreachBreak);
registerStatement("mvp:foreach_continue", foreachContinue);
registerStatement("mvp:foreach_remove", foreachRemove);
