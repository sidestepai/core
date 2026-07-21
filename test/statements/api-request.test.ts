import { describe, it, expect, expectTypeOf } from "vitest";
import "../../src/index.js"; // register all statements
import { s } from "../../src/statements/s.js";
import { c, inp, ref, filter } from "../../src/values/value.js";
import { coerceObj } from "../../src/statements/special/coerce.js";
import { encodeStatement } from "../../src/statements/statement.js";
import { query } from "../../src/kinds/query.js";
import { apiGroup } from "../../src/kinds/api-group.js";
import type { InferResponse } from "../../src/responses/infer.js";
import type { ApiRequestResult } from "../../src/statements/special/api-request.js";
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

describe("params record-of-values (issues #74/#75)", () => {
  it("encodes a plain record of tagged values as a c.obj base + set filters", () => {
    // The obvious spelling that used to throw — now mirrors `response: { k: v }`.
    expect(coerceObj({ count: ref("count") })).toEqual({
      value: "{}",
      tag: "const:obj",
      filters: [
        {
          name: "set",
          disabled: false,
          arg: [
            { value: "count", tag: "const", filters: [] },
            { value: "count", tag: "var", filters: [] },
          ],
        },
      ],
    });
  });

  it("keeps literal keys in the c.obj base and lifts only the Value keys", () => {
    const encoded = coerceObj({ n: 1, count: ref("count") })!;
    expect(encoded.tag).toBe("const:obj");
    expect(encoded.value).toBe('{"n":1}'); // literal subset seeds the constant base
    expect(encoded.filters).toEqual([
      {
        name: "set",
        disabled: false,
        arg: [
          { value: "count", tag: "const", filters: [] },
          { value: "count", tag: "var", filters: [] },
        ],
      },
    ]);
  });

  it("lifts multiple Value keys in deterministic (insertion) order", () => {
    const encoded = coerceObj({ a: ref("x"), b: inp("y") })!;
    expect(encoded.filters.map((f) => ({ name: f.name, path: f.arg[0]?.value, valTag: f.arg[1]?.tag }))).toEqual([
      { name: "set", path: "a", valTag: "var" },
      { name: "set", path: "b", valTag: "input" },
    ]);
  });

  it("leaves a pure-JSON record as a plain const:obj constant (no regression)", () => {
    // Byte-identical to the pre-change behavior — no set filters.
    expect(coerceObj({ a: "b", n: 1 })).toEqual({ value: '{"a":"b","n":1}', tag: "const:obj", filters: [] });
  });

  it("passes a dynamic Value (and an explicit c.obj) through untouched", () => {
    const r = ref("whole");
    expect(coerceObj(r)).toBe(r);
    const o = c.obj({ static: true });
    expect(coerceObj(o)).toBe(o);
  });

  it("returns undefined for an absent field", () => {
    expect(coerceObj(undefined)).toBeUndefined();
  });

  it("integrates through s.api.request params (end-to-end #74 repro shape)", () => {
    const encoded = encodeStatement(
      s.api.request({ url: "https://x", method: "POST", params: { count: ref("count") } }),
    );
    expect(field(encoded, "params")).toEqual({ value: "{}", tag: "const:obj" });
  });

  it("still throws loudly for a value nested inside a sub-object (flat-only boundary)", () => {
    // Documented boundary (KTD-3): not silently dropped — the #42 guard fires.
    expect(() => coerceObj({ a: { b: ref("x") } })).toThrow(/tagged value/);
  });

  it("encodes an empty record as an empty const:obj constant", () => {
    expect(coerceObj({})).toEqual({ value: "{}", tag: "const:obj", filters: [] });
  });

  it("does NOT mistake a plain record with `tag`/`value` keys for a tagged Value", () => {
    // The passthrough uses the strict `isTaggedValue` (real Tag + filters[]), so a
    // params object that merely reuses `tag`/`value` as data keys is encoded as a
    // constant — not returned verbatim as a bogus node.
    expect(coerceObj({ tag: "sale", value: "50" })).toEqual({
      value: '{"tag":"sale","value":"50"}',
      tag: "const:obj",
      filters: [],
    });
  });

  it("keeps array params as an array constant (not object-ified), preserving #42", () => {
    // Preserves the pre-change path exactly: c.obj JSON-stringifies the array
    // (`"[1,2]"`, tag const:obj); an array holding a Value still throws #42.
    expect(coerceObj([1, 2] as unknown as object)).toEqual({ value: "[1,2]", tag: "const:obj", filters: [] });
    expect(() => coerceObj([ref("x")] as unknown as object)).toThrow(/tagged value/);
  });

  it("throws on a dotted top-level key carrying a Value (nested-path ambiguity)", () => {
    // The engine `set` filter would split "a.b" into a nested path, diverging from
    // the flat encoding a literal-valued key gets — fail loud instead.
    expect(() => coerceObj({ "a.b": ref("x") })).toThrow(/nested path/);
    expect(() => coerceObj({ "items[0]": ref("x") })).toThrow(/nested path/);
    // The same dotted key with a plain value stays flat (pre-existing behavior).
    expect(coerceObj({ "a.b": 1 })).toEqual({ value: '{"a.b":1}', tag: "const:obj", filters: [] });
  });
});

describe("SSL/mTLS interdependency validation (build-time, static-only)", () => {
  it("rejects a certificate without a private key", () => {
    expect(() => s.api.request({ url: "https://x", certificate: "PEM" })).toThrow(/private_key/);
  });

  it("rejects a private key without a certificate", () => {
    expect(() => s.api.request({ url: "https://x", private_key: "KEY" })).toThrow(/certificate/);
  });

  it("rejects a ca_certificate with verify_peer disabled", () => {
    expect(() => s.api.request({ url: "https://x", ca_certificate: "CA", verify_peer: false })).toThrow(
      /verify_peer/,
    );
  });

  it("accepts a certificate + private_key pair", () => {
    expect(() => s.api.request({ url: "https://x", certificate: "PEM", private_key: "KEY" })).not.toThrow();
  });

  it("accepts a ca_certificate with verify_peer defaulted (omitted → true)", () => {
    expect(() => s.api.request({ url: "https://x", ca_certificate: "CA" })).not.toThrow();
  });

  it("does NOT reject a dynamic certificate Value (indeterminate → skip)", () => {
    // A bound Value can't be statically proven empty; never block valid usage.
    expect(() => s.api.request({ url: "https://x", certificate: inp("cert") })).not.toThrow();
  });

  it("does NOT reject when verify_peer is a dynamic Value", () => {
    expect(() =>
      s.api.request({ url: "https://x", ca_certificate: "CA", verify_peer: inp("vp") }),
    ).not.toThrow();
  });

  it("applies the same validation to stream.from_request and webflow.request", () => {
    expect(() => s.stream.from_request({ url: "https://x", certificate: "PEM" })).toThrow(/private_key/);
    expect(() => s.webflow.request({ path: "/x", certificate: "PEM" })).toThrow(/private_key/);
  });
});

describe("HTTP-request sibling wrappers (envelope broadening)", () => {
  it("stream.from_request encodes url + coerced fields", () => {
    const encoded = encodeStatement(
      s.stream.from_request({ as: "s1", url: "https://x", method: "POST", timeout: 5 }),
    );
    expect(encoded.name).toBe("mvp:streaming_api_request");
    expect(encoded.as).toBe("s1");
    expect(field(encoded, "url")).toEqual({ value: "https://x", tag: "const" });
    expect(field(encoded, "method")).toEqual({ value: "POST", tag: "const" });
    expect(field(encoded, "timeout")).toEqual({ value: "5", tag: "const:int" });
  });

  it("webflow.request encodes path (not url)", () => {
    const encoded = encodeStatement(s.webflow.request({ path: "/sites", method: "GET", headers: ["A: b"] }));
    expect(encoded.name).toBe("mvp:connect_webflow_api_request");
    expect(field(encoded, "path")).toEqual({ value: "/sites", tag: "const" });
    expect(field(encoded, "headers")).toEqual({ value: '["A: b"]', tag: "const:array" });
    expect(field(encoded, "url")).toBeUndefined();
  });

  it("api.microservice encodes host/path and coerces required fields", () => {
    const encoded = encodeStatement(
      s.api.microservice({
        as: "m1",
        host: "svc",
        path: "/health",
        method: "GET",
        params: {},
        headers: [],
        timeout: 3,
        follow_location: true,
      }),
    );
    expect(encoded.name).toBe("mvp:microservice_request");
    expect(field(encoded, "host")).toEqual({ value: "svc", tag: "const" });
    expect(field(encoded, "params")).toEqual({ value: "{}", tag: "const:obj" });
    expect(field(encoded, "follow_location")).toEqual({ value: "true", tag: "const:bool" });
  });

  it("passes dynamic Values through on siblings", () => {
    const encoded = encodeStatement(s.stream.from_request({ url: inp("u"), method: inp("m") }));
    expect(field(encoded, "url")?.tag).toBe("input");
    expect(field(encoded, "method")?.tag).toBe("input");
  });
});

describe("api.request result typing (InferResponse)", () => {
  const grp = apiGroup({ name: "g", canonical: "apireq-oracle" });

  it("resolves a ref to the {request, response} envelope", () => {
    const q = query({
      verb: "GET",
      apiGroup: grp,
      name: "callit",
      stack: [s.api.request({ url: "https://x", as: "api1" })],
      response: ref("api1"),
    });
    expect(q).toBeDefined();
    expectTypeOf<InferResponse<typeof q>>().toEqualTypeOf<ApiRequestResult>();
  });

  it("webflow.request and api.microservice bind the same envelope", () => {
    const wf = query({
      verb: "GET",
      apiGroup: grp,
      name: "wf",
      stack: [s.webflow.request({ path: "/sites", as: "r" })],
      response: ref("r"),
    });
    expect(wf).toBeDefined();
    expectTypeOf<InferResponse<typeof wf>>().toEqualTypeOf<ApiRequestResult>();

    const ms = query({
      verb: "GET",
      apiGroup: grp,
      name: "ms",
      stack: [
        s.api.microservice({
          host: "svc",
          path: "/p",
          method: "GET",
          params: {},
          headers: [],
          timeout: 5,
          follow_location: true,
          as: "r",
        }),
      ],
      response: ref("r"),
    });
    expect(ms).toBeDefined();
    expectTypeOf<InferResponse<typeof ms>>().toEqualTypeOf<ApiRequestResult>();
  });

  it("status is a number and result is unknown on the resolved type", () => {
    const q = query({
      verb: "GET",
      apiGroup: grp,
      name: "shape",
      stack: [s.api.request({ url: "https://x", as: "api1" })],
      response: ref("api1"),
    });
    expect(q).toBeDefined();
    expectTypeOf<InferResponse<typeof q>["response"]["status"]>().toEqualTypeOf<number>();
    expectTypeOf<InferResponse<typeof q>["response"]["result"]>().toEqualTypeOf<unknown>();
  });
});
