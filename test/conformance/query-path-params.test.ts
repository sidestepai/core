/**
 * URL path params, byte-verified against a LIVE engine capture.
 *
 * The golden was sourced by deploying `examples/sandbox/_e2e-app.ts` to a
 * disposable ephemeral, calling the endpoint, and re-exporting the workspace
 * (plan 2026-07-29-002, U8). It is the engine's own persisted form, so it is the
 * only oracle that can catch SideStep and Xano disagreeing about what a
 * `{param}` name and its inputs look like on the wire.
 *
 * What the live run proved, and what this test pins offline:
 *
 * - The engine ROUTES `echo/{slug}/n/{count}` and BINDS each segment to the
 *   input of that name — `GET …/echo/hello/n/7` answered `{"slug":"hello",
 *   "count":7}`, with `count` coerced to an int by its declared type.
 * - It does so with the path inputs stored `required: false`. That is why
 *   SideStep does not demand `required: true` on a path param: the engine's own
 *   editor leaves them unmarked, and binding does not depend on the flag.
 * - The `{param}` markers survive an export → import → export round trip
 *   verbatim. A path param is a naming convention over `name`, not a new field.
 *
 * The twin below is authored exactly as `_e2e-app.ts` authors it; the api group
 * binding matches because a group's guid derives from its name.
 */
import { describe, it, expect } from "vitest";
import "../../src/index.js";
import { normalize, loadFixture } from "./harness.js";
import { query, encodeQuery } from "../../src/kinds/query.js";
import { apiGroup } from "../../src/kinds/api-group.js";
import { input } from "../../src/inputs/input.js";
import { s } from "../../src/statements/s.js";
import { inp, ref } from "../../src/values/value.js";

const api = apiGroup({ name: "e2e", canonical: "e2e" });

const echo = query({
  name: "echo/{slug}/n/{count}",
  verb: "GET",
  apiGroup: api,
  input: { slug: input.text(), count: input.int() },
  stack: [s.set_var("slug_seen", inp("slug")), s.set_var("count_seen", inp("count"))],
  response: { slug: ref("slug_seen"), count: ref("count_seen") },
});

describe("query path params conform to the live-captured golden", () => {
  const golden = loadFixture<Record<string, unknown>>("query/ex_path_params.json");

  it("the compiled object deep-equals what the engine persisted", () => {
    expect(normalize(encodeQuery(echo))).toEqual(normalize(golden));
  });

  it("the engine stored the {param} name verbatim", () => {
    expect(golden.name).toBe("echo/{slug}/n/{count}");
  });

  it("the engine stored both path inputs unmarked — required is not part of binding", () => {
    expect((golden.input as Array<Record<string, unknown>>).map((i) => [i.name, i.type, i.required]))
      .toEqual([
        ["slug", "text", false],
        ["count", "int", false],
      ]);
  });

  it("getPath() reproduces the URL the live call actually hit", () => {
    expect(echo.getPath({ params: { slug: "hello", count: 7 } })).toBe("/api:e2e/echo/hello/n/7");
  });
});
