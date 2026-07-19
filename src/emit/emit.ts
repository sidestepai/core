/**
 * Emit artifacts as strings: a single compiled function (U8) or the aggregate
 * workspace bundle from a `Xano` registry (U12). These are pure and browser-safe
 * — the `node:fs` writers live in `./write.js` so importing a def graph never
 * pulls in `fs`.
 */
import { compile } from "../function/compile.js";
import type { FunctionDef } from "../function/define.js";
import { encodeQuery } from "../kinds/query.js";
import type { QueryDef } from "../kinds/query.js";
import { encodeTable } from "../kinds/table.js";
import type { TableDef } from "../kinds/table.js";
import type { Xano } from "../workspace/xano.js";
import type { Bundle } from "../workspace/export.js";

/**
 * Encode a single def to its pretty-printed JSON envelope, dispatching on the
 * def's kind so each is encoded correctly:
 *   - a `query()` (has `verb`) → the query envelope (`input`/`result`/`run`),
 *   - a `table()` (has `schema`) → the `dbo` payload (its real columns/indexes),
 *   - anything else → a `function` envelope (the historical default).
 *
 * Before this dispatch, `emit()` force-compiled every def as a function, so
 * `emit(myTable)` produced a misleading function-shaped envelope with no schema
 * (it looked like the table had no columns). A `table()` still needs
 * {@link emitBundle} + registration for its guid/lock wiring — this single-def
 * form is a sanity-check view of the encoding, not a substitute for export.
 */
export function emit(
  def: FunctionDef | QueryDef | TableDef,
  opts: { indent?: number } = {},
): string {
  const indent = opts.indent ?? 2;
  if ("schema" in def && def.schema !== undefined) {
    return JSON.stringify(encodeTable(def), null, indent);
  }
  if ("verb" in def && def.verb !== undefined) {
    return JSON.stringify(encodeQuery(def), null, indent);
  }
  return JSON.stringify(compile(def), null, indent);
}

/** Pretty-print an already-built bundle (the CLI's lock path builds it itself). */
export function serializeBundle(bundle: Bundle, opts: { indent?: number } = {}): string {
  return JSON.stringify(bundle, null, opts.indent ?? 2);
}

/** Pretty-print the aggregate `packageExport` bundle from a `Xano` registry. */
export function emitBundle(xano: Xano, opts: { indent?: number } = {}): string {
  return serializeBundle(xano.export(), opts);
}
