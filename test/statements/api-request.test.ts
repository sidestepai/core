import { describe, it, expect } from "vitest";
import "../../src/index.js"; // register all statements
import { s } from "../../src/statements/s.js";
import { c, inp, filter } from "../../src/values/value.js";
import { encodeStatement } from "../../src/statements/statement.js";
import { normalize, loadFixture } from "../conformance/harness.js";

/** Pull an input entry `{value, tag}` by name from an encoded statement. */
function field(encoded: ReturnType<typeof encodeStatement>, name: string) {
  const entry = (encoded.input as Array<{ name: string; value: unknown; tag: string }>).find(
    (e) => e.name === name,
  );
  return entry && { value: entry.value, tag: entry.tag };
}

describe("s.api.request — typed wrapper (U3)", () => {
  it("byte-matches the engine golden when built from typed literals (R5)", () => {
    const encoded = encodeStatement(
      s.api.request({
        as: "api1",
        url: "https://www.xano.com",
        method: "GET",
        params: {},
        headers: [],
        timeout: 10,
        follow_location: true,
        verify_host: true,
        verify_peer: true,
        ca_certificate: "",
        certificate: "",
        certificate_pass: "",
        private_key: "",
        private_key_pass: "",
        description: "this is a test",
      }),
    );
    expect(normalize(encoded)).toEqual(normalize(loadFixture("statements/api_request.json")));
  });

  it("coerces structured literals to the correct engine tags", () => {
    const encoded = encodeStatement(
      s.api.request({
        url: "https://x",
        method: "POST",
        params: { a: 1 },
        headers: ["Content-Type: application/json"],
        timeout: 30,
        verify_peer: false,
      }),
    );
    expect(field(encoded, "url")).toEqual({ value: "https://x", tag: "const" });
    expect(field(encoded, "method")).toEqual({ value: "POST", tag: "const" });
    expect(field(encoded, "params")).toEqual({ value: '{"a":1}', tag: "const:obj" });
    expect(field(encoded, "headers")).toEqual({
      value: '["Content-Type: application/json"]',
      tag: "const:array",
    });
    expect(field(encoded, "timeout")).toEqual({ value: "30", tag: "const:int" });
    expect(field(encoded, "verify_peer")).toEqual({ value: "false", tag: "const:bool" });
  });

  it("passes a dynamic Value through unchanged for any field (R4)", () => {
    const encoded = encodeStatement(
      s.api.request({
        url: inp("endpoint"),
        method: inp("verb"),
        timeout: inp("t"),
        params: c.obj({ static: true }),
      }),
    );
    expect(field(encoded, "url")?.tag).toBe("input");
    expect(field(encoded, "method")?.tag).toBe("input");
    expect(field(encoded, "timeout")?.tag).toBe("input");
    expect(field(encoded, "params")).toEqual({ value: '{"static":true}', tag: "const:obj" });
  });

  it("encodes each accepted verb as a const text value", () => {
    for (const method of ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"] as const) {
      const encoded = encodeStatement(s.api.request({ url: "https://x", method }));
      expect(field(encoded, "method")).toEqual({ value: method, tag: "const" });
    }
  });

  it("surfaces description and output filters (R9 — Settings + Output tabs)", () => {
    const encoded = encodeStatement(
      s.api.request({
        url: "https://x",
        description: "call the thing",
        output: { customize: true, filters: [filter("json_decode")] },
      }),
    );
    expect(encoded.description).toBe("call the thing");
    expect(encoded.output).toEqual({ items: [], filters: [filter("json_decode")], customize: true });
  });

  it("omits unset fields (no phantom input entries)", () => {
    const encoded = encodeStatement(s.api.request({ url: "https://x" }));
    const names = (encoded.input as Array<{ name: string }>).map((e) => e.name);
    expect(names).toEqual(["url"]);
    expect(encoded.description).toBe("");
  });
});
