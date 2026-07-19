import { describe, it, expect, expectTypeOf } from "vitest";
import { query, encodeQuery } from "../../src/kinds/query.js";
import { apiGroup } from "../../src/kinds/api-group.js";
import { table, tableColumns } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { ref, c, withFilters } from "../../src/values/value.js";
import { fl } from "../../src/values/generated/filters.generated.js";
import { s } from "../../src/statements/s.js";
import type { InferResponse } from "../../src/responses/infer.js";
import type { InferRow } from "../../src/kinds/table.js";

/**
 * U7 (issue #5) — spec oracle. Guards against the type-level `InferResponse`
 * derivation drifting from what the Xano engine actually derives.
 *
 * The engine builds its OpenAPI response schema by a **static walk** of
 * `result[]` + `run[]` (`x2/extensions/XS/includes/xano/xs/Stack.php:73`
 * `findVarSchema`, wired into the OpenAPI spec at
 * `x2/extensions/Api/includes/xano/helper/ApiSpec.php:416`). Xano's own SDK
 * generator consumes that spec — so mirroring the same walk is what keeps the SDK
 * premise sound.
 *
 * No live OpenAPI snapshot is vendored in this repo (the spec is produced
 * server-side). Instead {@link engineKeySet} **recomputes the engine's rule over
 * the encoded xdo** — the exact bytes sidestep ships to Xano — independently of
 * the type-level derivation. Each case then asserts the two agree. If either the
 * encoder or the type walk drifts from the engine rule, a case fails.
 *
 * `findVarSchema` rule, as recomputed here:
 *   - multiple named result items → an object keyed by those names;
 *   - a single unnamed `var` item with no filters, whose name matches a
 *     top-level `dbo_getby`/`dbo_view` statement → that statement's output
 *     columns (customized `output` list, else the full record);
 *   - anything else (filtered value, unmatched var, non-DB producer) → `null`
 *     (the engine's `json|empty_array` fallback ⇔ `InferResponse` is `unknown`).
 */

const group = apiGroup({ name: "g", canonical: "oracle1" });

const widget = table({
  name: "widget",
  schema: {
    name: f.text({ required: true }),
    size: f.int(),
  },
});

/** The table's declared column names — the engine's "full record" key set for a
 * customize:false read (the private-column exclusion the engine applies on an
 * auto-shaped read is a documented nuance `InferRow` itself carries; out of scope
 * for the routing this oracle checks). */
const widgetCols = tableColumns(widget)
  .map((col) => col.name)
  .sort();

type EncodedResultItem = { name: string; value: string; tag: string; filters?: unknown[] };
type EncodedStmt = { name: string; as?: string; output?: { customize?: boolean; items?: { name: string }[] } };

/** Recompute the engine's derived response key set from an encoded query xdo,
 * or `null` for the `json|empty_array` fallback. `fullRecordCols` supplies the
 * table's columns for a customize:false single-var read. */
function engineKeySet(
  xdo: { result: EncodedResultItem[]; run: EncodedStmt[] },
  fullRecordCols: string[],
): string[] | null {
  const result = xdo.result;
  const item = result.length === 1 ? result[0] : undefined;
  // Multiple (or zero) named items → object keyed by the item names.
  if (!item || item.name !== "") {
    return result.map((r) => r.name).sort();
  }
  if (item.tag !== "var") return null;
  if (item.filters && item.filters.length > 0) return null; // filtered → json
  const producer = xdo.run.find((st) => st.as === item.value);
  if (!producer) return null; // unmatched var → json
  if (producer.name !== "mvp:dbo_getby" && producer.name !== "mvp:dbo_view") return null;
  const out = producer.output;
  if (out?.customize && out.items) return out.items.map((i) => i.name).sort();
  return [...fullRecordCols].sort();
}

function keysOfXdo(q: Parameters<typeof encodeQuery>[0]): string[] | null {
  const xdo = encodeQuery(q) as unknown as { result: EncodedResultItem[]; run: EncodedStmt[] };
  return engineKeySet(xdo, widgetCols);
}

describe("InferResponse spec oracle — type derivation agrees with the engine rule", () => {
  it("named object response: engine keys == response names == InferResponse keys", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "named_obj",
      stack: [s.db.get({ table: widget, fieldValue: c.int(1), as: "row" })],
      response: { id: ref("row"), name: ref("row") },
    });
    expect(keysOfXdo(q)).toEqual(["id", "name"]);
    expectTypeOf<keyof InferResponse<typeof q>>().toEqualTypeOf<"id" | "name">();
  });

  it("column-narrowed single-var: engine keys == output items == InferResponse keys", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "narrowed",
      stack: [s.db.get({ table: widget, fieldValue: c.int(1), output: ["id", "name"], as: "row" })],
      response: ref("row"),
    });
    expect(keysOfXdo(q)).toEqual(["id", "name"]);
    expectTypeOf<InferResponse<typeof q>>().toEqualTypeOf<Pick<InferRow<typeof widget>, "id" | "name">>();
    expectTypeOf<keyof InferResponse<typeof q>>().toEqualTypeOf<"id" | "name">();
  });

  it("full-record single-var: engine full-record keys == InferResponse (InferRow) keys", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "full_record",
      stack: [s.db.get({ table: widget, fieldValue: c.int(1), as: "row" })],
      response: ref("row"),
    });
    expect(keysOfXdo(q)).toEqual(widgetCols);
    // InferRow keys == the declared table columns.
    expectTypeOf<InferResponse<typeof q>>().toEqualTypeOf<InferRow<typeof widget>>();
    const sampleKeys = (["id", "created_at", "name", "size"] as const).slice().sort();
    expect(sampleKeys).toEqual(widgetCols);
  });

  it("list single-var (dbo_view): engine routes to the statement; InferResponse is a row list", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "listing",
      stack: [s.db.query({ table: widget, as: "rows" })],
      response: ref("rows"),
    });
    expect(keysOfXdo(q)).toEqual(widgetCols);
    expectTypeOf<InferResponse<typeof q>>().toEqualTypeOf<InferRow<typeof widget>[]>();
  });

  it("filtered value: engine → json fallback (null) ⇔ InferResponse unknown", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "filtered",
      stack: [s.db.get({ table: widget, fieldValue: c.int(1), as: "row" })],
      response: withFilters(ref("row"), fl.first()),
    });
    expect(keysOfXdo(q)).toBeNull();
    expectTypeOf<InferResponse<typeof q>>().toEqualTypeOf<unknown>();
  });

  it("unmatched var: engine → json fallback (null) ⇔ InferResponse unknown", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "unmatched",
      stack: [s.db.get({ table: widget, fieldValue: c.int(1), as: "row" })],
      response: ref("nope"),
    });
    expect(keysOfXdo(q)).toBeNull();
    expectTypeOf<InferResponse<typeof q>>().toEqualTypeOf<unknown>();
  });
});
