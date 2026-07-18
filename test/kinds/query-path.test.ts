import { describe, it, expect, expectTypeOf } from "vitest";
import { query, encodeQuery } from "../../src/kinds/query.js";
import { apiGroup } from "../../src/kinds/api-group.js";
import { input } from "../../src/inputs/input.js";
import type { InferInput } from "../../src/inputs/infer.js";

/**
 * U3 — generic `query()` + `getPath()`. Covers path resolution, the canonical
 * fallbacks and errors, name normalization, that the value brands survive on
 * `typeof theQuery` (so `InferInput` still resolves), and that attaching
 * `getPath` did not change the encoded XDO or JSON serialization.
 */

const auth = apiGroup({ name: "auth", canonical: "auth" });

const meQuery = query({
  name: "me",
  verb: "POST",
  apiGroup: auth,
  input: {
    email: input.email({ required: true }),
    password: input.password({ required: true }),
  },
});

describe("query().getPath()", () => {
  it("returns the group-relative path from the api group handle's canonical", () => {
    expect(meQuery.getPath()).toBe("/api:auth/me");
  });

  it("normalizes a leading slash and preserves nested path segments", () => {
    const leading = query({ name: "/me", verb: "GET", apiGroup: auth });
    expect(leading.getPath()).toBe("/api:auth/me");

    const nested = query({ name: "auth/me", verb: "GET", apiGroup: auth });
    expect(nested.getPath()).toBe("/api:auth/auth/me");
  });

  it("an explicit canonical override wins over the handle's canonical", () => {
    expect(meQuery.getPath({ canonical: "v2" })).toBe("/api:v2/me");
  });

  it("throws for a bare-name apiGroup (no canonical resolvable) unless overridden", () => {
    const byName = query({ name: "me", verb: "GET", apiGroup: "auth" });
    expect(() => byName.getPath()).toThrow(/cannot resolve the api group's canonical/);
    // …but an override makes it resolvable.
    expect(byName.getPath({ canonical: "auth" })).toBe("/api:auth/me");
  });

  it("throws for an api group with an empty canonical and no seeded lock", () => {
    const empties = apiGroup({ name: "public" }); // canonical defaults to ""
    const q = query({ name: "list", verb: "GET", apiGroup: empties });
    // No fresh minting at getPath() time — canonicals are minted only at
    // `export --lock` (unique per instance across all workspaces).
    expect(() => q.getPath()).toThrow(/export --lock/);
  });

  it("throws when the query has no api group at all", () => {
    const q = query({ name: "orphan", verb: "GET" });
    expect(() => q.getPath()).toThrow(/cannot resolve/);
  });

  it("keeps the HTTP verb accessible on the handle", () => {
    expect(meQuery.verb).toBe("POST");
  });
});

describe("query() preserves input brands for InferInput", () => {
  it("typeof theQuery yields the precise request-payload type", () => {
    expectTypeOf<InferInput<typeof meQuery>>().toEqualTypeOf<{
      email: string;
      password: string;
    }>();
  });

  it("a no-input query infers an empty payload (no index-signature leak)", () => {
    const ping = query({ name: "ping", verb: "GET", apiGroup: auth });
    expect(ping.getPath()).toBe("/api:auth/ping");
    expectTypeOf<keyof InferInput<typeof ping>>().toEqualTypeOf<never>();
    const empty: InferInput<typeof ping> = {};
    void empty;
  });
});

describe("attaching getPath does not disturb encoding/serialization", () => {
  it("encodeQuery output is unchanged and carries no getPath", () => {
    const enc = encodeQuery(meQuery);
    expect(enc.name).toBe("me");
    expect(enc.verb).toBe("POST");
    expect(enc.input.map((i) => i.name)).toEqual(["email", "password"]);
    expect(Object.keys(enc)).not.toContain("getPath");
  });

  it("JSON.stringify(theQuery) drops the getPath method", () => {
    const round = JSON.parse(JSON.stringify(meQuery));
    expect(round.getPath).toBeUndefined();
    expect(round.name).toBe("me");
  });

  it("encoding the factory return equals encoding the bare def", () => {
    const bare = { name: "me", verb: "POST" as const, apiGroup: auth, input: meQuery.input };
    expect(encodeQuery(meQuery)).toEqual(encodeQuery(bare));
  });
});
