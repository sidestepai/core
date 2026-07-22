import { describe, it, expect } from "vitest";
import { smokeRunFunctions, resolveCanonical, assertResponse, type RuntimeClient } from "../../src/validate/runtime.js";
import type { InvokeResult, ApiGroupSummary } from "../../src/validate/meta-client.js";

function client(over: Partial<RuntimeClient> = {}): RuntimeClient {
  return {
    runFunction: async () => ({ status: 200, ok: true, body: { result: 1 } }),
    listApigroups: async () => [],
    invokeApi: async () => ({ status: 200, ok: true, body: {} }),
    ...over,
  };
}

describe("smokeRunFunctions", () => {
  it("reports ran:true with the result body on success", async () => {
    const res = await smokeRunFunctions(client(), 42, ["f"]);
    expect(res).toEqual([{ name: "f", ran: true, status: 200, detail: { result: 1 } }]);
  });

  it("reports ran:false with the engine detail on error", async () => {
    const c = client({ runFunction: async () => ({ status: 400, ok: false, body: { message: "precondition failed", logs: ["x"] } }) });
    const res = await smokeRunFunctions(c, 42, ["f"]);
    expect(res[0]).toMatchObject({ name: "f", ran: false, status: 400 });
    expect(res[0]!.detail).toMatchObject({ message: "precondition failed" });
  });

  it("passes per-function inputs when provided", async () => {
    const seen: unknown[] = [];
    const c = client({ runFunction: async (_ws, _name, input) => { seen.push(input); return { status: 200, ok: true, body: {} }; } });
    await smokeRunFunctions(c, 42, ["sum"], { sum: { a: 1, b: 2 } });
    expect(seen).toEqual([{ a: 1, b: 2 }]);
  });
});

describe("resolveCanonical", () => {
  const groups: ApiGroupSummary[] = [
    { id: 1, name: "public", canonical: "abc" },
    { id: 2, name: "admin", canonical: "def" },
  ];

  it("matches a named group's canonical", async () => {
    expect(await resolveCanonical(client({ listApigroups: async () => groups }), 42, "admin")).toBe("def");
  });

  it("returns the sole group's canonical when unnamed", async () => {
    const one = client({ listApigroups: async () => [groups[0]!] });
    expect(await resolveCanonical(one, 42)).toBe("abc");
  });

  it("is undefined when unnamed and ambiguous", async () => {
    expect(await resolveCanonical(client({ listApigroups: async () => groups }), 42)).toBeUndefined();
  });

  it("is undefined when a named group is absent", async () => {
    expect(await resolveCanonical(client({ listApigroups: async () => groups }), 42, "nope")).toBeUndefined();
  });
});

describe("assertResponse", () => {
  const ok: InvokeResult = { status: 200, ok: true, body: { a: 1, b: "x" } };

  it("passes when status and body match", () => {
    expect(assertResponse(ok, { status: 200, body: { a: 1, b: "x" } })).toEqual({ pass: true, failures: [] });
  });

  it("reports a status mismatch", () => {
    const r = assertResponse(ok, { status: 201 });
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/status: expected 201, got 200/);
  });

  it("reports body field mismatches with paths", () => {
    const r = assertResponse(ok, { body: { a: 2, b: "x" } });
    expect(r.pass).toBe(false);
    expect(r.failures.some((f) => /body \$\.a: expected 2, got 1/.test(f))).toBe(true);
  });
});
