import { describe, it, expect } from "vitest";
import { smokeRunFunctions, type RuntimeClient } from "../../src/validate/runtime.js";

function client(over: Partial<RuntimeClient> = {}): RuntimeClient {
  return {
    runFunction: async () => ({ status: 200, ok: true, body: { result: 1 } }),
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

  it("runs each named function once, in order", async () => {
    const seen: string[] = [];
    const c = client({ runFunction: async (_ws, name) => { seen.push(name); return { status: 200, ok: true, body: {} }; } });
    await smokeRunFunctions(c, 42, ["a", "b", "c"]);
    expect(seen).toEqual(["a", "b", "c"]);
  });
});
