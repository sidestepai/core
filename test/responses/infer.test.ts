import { describe, it, expect, expectTypeOf } from "vitest";
import { query, encodeQuery } from "../../src/kinds/query.js";
import { defineFunction } from "../../src/function/define.js";
import { apiGroup } from "../../src/kinds/api-group.js";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { ref } from "../../src/values/value.js";
import type { InferResponse } from "../../src/responses/infer.js";
import type { InferRow } from "../../src/kinds/table.js";

/**
 * Issue #5 — `InferResponse<typeof query>` is the read-side round-trip
 * counterpart of `InferInput`. These are compile-time assertions (validated by
 * `tsc`, which includes `test/`); the `@ts-expect-error` cases prove the produced
 * type is real.
 *
 * U1 covers the always-correct override path (`responseShape`) and the `unknown`
 * fallback. Auto-derivation (object-literal keys, single-var trace) is U2/U5.
 */

const links = apiGroup({ name: "links", canonical: "abc123" });

const link = table({
  name: "link",
  schema: {
    slug: f.text({ required: true }),
    url: f.text({ required: true }),
    clicks: f.int(),
  },
});

// A declared list response — the link-shortener pattern.
const listLinks = query({
  verb: "GET",
  apiGroup: links,
  name: "list_links",
  stack: [],
  response: ref("rows"),
  responseShape: [] as InferRow<typeof link>[],
});

// A declared nullable response — the snippet-pastebin get() pattern.
const getLink = query({
  verb: "GET",
  apiGroup: links,
  name: "get_link",
  input: {},
  response: ref("row"),
  responseShape: null as InferRow<typeof link> | null,
});

// No declaration and no derivable shape yet (U1) → unknown.
const undeclared = query({
  verb: "GET",
  apiGroup: links,
  name: "undeclared",
  response: ref("x"),
});

// A function carrying a declared response (parity with queries).
const computeStats = defineFunction({
  name: "compute_stats",
  input: {},
  responseShape: { total: 0 } as { total: number },
});

describe("InferResponse (type-level)", () => {
  it("declared list responseShape → InferRow<typeof link>[]", () => {
    expectTypeOf<InferResponse<typeof listLinks>>().toEqualTypeOf<InferRow<typeof link>[]>();
  });

  it("declared nullable responseShape preserves `| null`", () => {
    expectTypeOf<InferResponse<typeof getLink>>().toEqualTypeOf<
      InferRow<typeof link> | null
    >();
  });

  it("undeclared, non-derivable response → unknown (U1 fallback)", () => {
    expectTypeOf<InferResponse<typeof undeclared>>().toEqualTypeOf<unknown>();
  });

  it("defineFunction carries a declared responseShape identically", () => {
    expectTypeOf<InferResponse<typeof computeStats>>().toEqualTypeOf<{ total: number }>();
  });

  it("a mismatched value is rejected against the declared response type", () => {
    const rows: InferResponse<typeof listLinks> = [
      { id: 1, created_at: 0, slug: "a", url: "u", clicks: 0 },
    ];
    void rows;
    // @ts-expect-error — a bare object is not the declared array response
    const wrong: InferResponse<typeof listLinks> = { nope: true };
    void wrong;
  });

  it("encodeQuery ignores responseShape — no such key in the encoded xdo", () => {
    const xdo = encodeQuery(listLinks) as unknown as Record<string, unknown>;
    expect("responseShape" in xdo).toBe(false);
    // The declared list endpoint still encodes its response assignment.
    expect(Array.isArray(xdo.result)).toBe(true);
  });
});
