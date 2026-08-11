import { describe, it, expect, expectTypeOf } from "vitest";
import "../../src/index.js"; // register all statements
import { s } from "../../src/statements/s.js";
import { c, inp, ref } from "../../src/values/value.js";
import { generated } from "../../src/statements/generated/factories.generated.js";
import { encodeStatement } from "../../src/statements/statement.js";
import { query } from "../../src/kinds/query.js";
import { apiGroup } from "../../src/kinds/api-group.js";
import type { InferResponse } from "../../src/responses/infer.js";
import type { IpLookupResult } from "../../src/statements/special/ip-lookup.js";

/**
 * #226 — `s.util.ip_lookup` binds a NESTED geolocation object that neither the
 * signature nor the old `type: "object"` descriptor described, so the natural
 * flat guess resolved to null and failed two steps later against a column name.
 * The typed override adds the shape brand; these pin that the bytes did not move
 * and that a dotted `ref` now traces to the real shape.
 */
describe("s.util.ip_lookup — typed override (#226)", () => {
  it("emits bytes identical to the generated factory", () => {
    const typed = encodeStatement(s.util.ip_lookup({ as: "geo", value: c.text("151.101.1.69") }));
    const raw = encodeStatement(generated.util.ip_lookup({ as: "geo", value: c.text("151.101.1.69") }));
    expect(typed).toEqual(raw);
    expect(typed.name).toBe("mvp:ipaddress_lookup");
  });

  it("keeps the engine's `ip` input name and passes a dynamic Value through", () => {
    const encoded = encodeStatement(s.util.ip_lookup({ as: "geo", value: inp("addr") }));
    const entries = encoded.input as Array<{ name: string; tag: string }>;
    expect(entries[0]?.name).toBe("ip");
    expect(entries[0]?.tag).toBe("input");
  });

  it("carries the annotations through the override", () => {
    const encoded = encodeStatement(
      s.util.ip_lookup({ value: c.text("8.8.8.8"), disabled: true, description: "note" }),
    );
    expect(encoded.disabled).toBe(true);
    expect(encoded.description).toBe("note");
  });
});

describe("s.util.ip_lookup result typing (InferResponse)", () => {
  const grp = apiGroup({ name: "g", canonical: "iplookup-oracle" });

  const q = query({
    verb: "GET",
    apiGroup: grp,
    name: "geo",
    stack: [s.util.ip_lookup({ as: "geo", value: c.text("151.101.1.69") })],
    response: ref("geo"),
  });

  it("resolves a bare ref to the nested record (nullable at the top)", () => {
    expect(q).toBeDefined();
    expectTypeOf<InferResponse<typeof q>>().toEqualTypeOf<IpLookupResult | null>();
  });

  it("resolves the CORRECT coordinate path to a nullable number", () => {
    const lat = query({
      verb: "GET",
      apiGroup: grp,
      name: "lat",
      stack: [s.util.ip_lookup({ as: "geo", value: c.text("151.101.1.69") })],
      response: ref("geo.location.latitude"),
    });
    expect(lat).toBeDefined();
    expectTypeOf<InferResponse<typeof lat>>().toEqualTypeOf<number | null>();
  });

  it("resolves place names to nullable strings, and `city` to the OBJECT it is", () => {
    const names = query({
      verb: "GET",
      apiGroup: grp,
      name: "names",
      stack: [s.util.ip_lookup({ as: "geo", value: c.text("151.101.1.69") })],
      response: { city: ref("geo.city.name"), country: ref("geo.country.name"), whole: ref("geo.city") },
    });
    expect(names).toBeDefined();
    expectTypeOf<InferResponse<typeof names>>().toEqualTypeOf<{
      city: string | null;
      country: string | null;
      whole: { name: string | null } | null;
    }>();
  });

  it("the flat guess that started #226 does NOT resolve — it bottoms out at unknown", () => {
    const flat = query({
      verb: "GET",
      apiGroup: grp,
      name: "flat",
      stack: [s.util.ip_lookup({ as: "geo", value: c.text("151.101.1.69") })],
      response: { latitude: ref("geo.latitude"), city: ref("geo.city.name") },
    });
    expect(flat).toBeDefined();
    expectTypeOf<InferResponse<typeof flat>>().toEqualTypeOf<{
      latitude: unknown;
      city: string | null;
    }>();
  });
});
