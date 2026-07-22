import { describe, it, expect } from "vitest";
import { s } from "../../src/statements/s.js";
import { encodeStatement } from "../../src/statements/statement.js";
import { obj } from "../../src/values/obj.js";
import { inp, c } from "../../src/values/value.js";

/**
 * `s.ai.agent.run` (#89) — the brand it now carries is phantom, so the emitted
 * `mvp:call_agent` bytes must be identical to the pre-brand form. These runtime
 * tests guard the wire shape; the type-level assertions live in
 * `test/responses/agent-run-infer.test.ts`.
 */
describe("s.ai.agent.run — encode parity (brand is phantom)", () => {
  it("emits the same mvp:call_agent shape regardless of the brand", () => {
    const stmt = s.ai.agent.run({ agent: "assistant", args: obj({ question: inp("question") }), as: "answer" });
    const encoded = encodeStatement(stmt) as unknown as Record<string, unknown>;
    expect(encoded.name).toBe("mvp:call_agent");
    expect(encoded.as).toBe("answer");
    // context targets the toolset guid; input carries the args entry.
    expect(encoded.context).toHaveProperty("toolset");
    const input = encoded.input as Array<{ name: string }>;
    expect(input.map((e) => e.name)).toEqual(["args"]);
  });

  it("resultShape is a type-only witness — never present in the emitted statement", () => {
    const withShape = s.ai.agent.run({
      agent: "assistant",
      as: "answer",
      resultShape: {} as { sentiment: string },
    });
    const withoutShape = s.ai.agent.run({ agent: "assistant", as: "answer" });
    expect(JSON.stringify(withShape)).not.toContain("resultShape");
    expect(JSON.stringify(withShape)).not.toContain("sentiment");
    // Same wire output with or without the witness.
    expect(encodeStatement(withShape)).toEqual(encodeStatement(withoutShape));
  });

  it("still encodes with no `as` and with allowToolExecution/version", () => {
    const stmt = s.ai.agent.run({
      agent: "assistant",
      args: c.obj({ q: "hi" }),
      allowToolExecution: c.bool(true),
      version: c.int(2),
    });
    const encoded = encodeStatement(stmt) as unknown as Record<string, unknown>;
    expect(encoded.as).toBe("");
    const input = encoded.input as Array<{ name: string }>;
    expect(input.map((e) => e.name)).toEqual(["args", "allow_tool_execution", "version"]);
  });
});
