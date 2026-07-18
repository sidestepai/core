/**
 * `tags` def-field on the core kinds (query, table, api_group, function) —
 * stored as `tag: [{tag}]` via the shared `encodeTags` (same wire shape the
 * addon/middleware/task/toolset kinds already emit).
 */
import { describe, it, expect } from "vitest";
import "../../src/index.js"; // register kinds + statements
import { encodeQuery, query } from "../../src/kinds/query.js";
import { encodeTable, table } from "../../src/kinds/table.js";
import { encodeApiGroup, apiGroup } from "../../src/kinds/api-group.js";
import { encodeFunction } from "../../src/kinds/function.js";
import { defineFunction } from "../../src/function/define.js";
import { encodeTrigger, trigger } from "../../src/kinds/trigger.js";

const TAGS = ["xano:quick-start"];
const WIRE = [{ tag: "xano:quick-start" }];

describe("tags on core kinds → stored tag: [{tag}]", () => {
  it("query", () => {
    const enc = encodeQuery(query({ name: "q", verb: "GET", tags: TAGS }));
    expect(enc.tag).toEqual(WIRE);
  });

  it("table", () => {
    const enc = encodeTable(table({ name: "t", schema: [], tags: TAGS }));
    expect(enc.tag).toEqual(WIRE);
  });

  it("api group", () => {
    const enc = encodeApiGroup(apiGroup({ name: "g", tags: TAGS }));
    expect(enc.tag).toEqual(WIRE);
  });

  it("function", () => {
    const enc = encodeFunction(defineFunction({ name: "fn", tags: TAGS }));
    expect(enc.tag).toEqual(WIRE);
  });

  it("trigger", () => {
    const enc = encodeTrigger(
      trigger.table({ name: "t", objId: 1, actions: { insert: true }, tags: TAGS }),
    );
    expect(enc.tag).toEqual(WIRE);
  });

  it("omitted tags still emit an empty tag array on every kind", () => {
    expect(encodeQuery(query({ name: "q", verb: "GET" })).tag).toEqual([]);
    expect(encodeTable(table({ name: "t", schema: [] })).tag).toEqual([]);
    expect(encodeApiGroup(apiGroup({ name: "g" })).tag).toEqual([]);
    expect(encodeFunction(defineFunction({ name: "fn" })).tag).toEqual([]);
  });
});
