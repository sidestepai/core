import { describe, it, expect } from "vitest";
import { Xano } from "../../src/workspace/xano.js";
import {
  phpJsonEncode,
  calcSignatureJson,
  buildBundle,
  PAYLOAD_ARRAY_KEYS,
} from "../../src/workspace/export.js";
import { compile } from "../../src/function/compile.js";
import { deriveGuid } from "../../src/refs/guid.js";
import { defineFunction } from "../../src/function/define.js";
import { setVar } from "../../src/statements/set-var.js";
import { c, ref } from "../../src/values/value.js";

const fn = defineFunction({ name: "f", stack: [setVar("x1", c.int(1))], response: ref("x1") });
// At workspace export, referenceable objects gain a deterministic guid (refs/guid.ts);
// a standalone `compile(fn)` has none, so the bundle form is `compile(fn)` + guid.
const exportedFn = { ...compile(fn), guid: deriveGuid("function", "f") };

describe("Xano.export() bundle", () => {
  it("emits a packageExport bundle with the function under payload.function", () => {
    const bundle = new Xano().registerFunctions([fn]).export();
    expect(bundle.app).toBe("xano");
    expect(bundle.version).toBe("1.03");
    expect(bundle.type).toBe("workspace");
    expect(bundle.payload.function).toEqual([exportedFn]);
    expect(typeof bundle.sig).toBe("string");
    expect(bundle.sig.length).toBeGreaterThan(0);
  });

  it("empty workspace exports a well-formed bundle with empty payload arrays", () => {
    const bundle = new Xano().export();
    for (const key of PAYLOAD_ARRAY_KEYS) {
      expect(bundle.payload[key]).toEqual([]);
    }
    // The workspace always carries a guid (the workspace-import path requires it);
    // with no name registered it derives deterministically from "workspace".
    expect(bundle.payload.workspace).toEqual({ guid: expect.any(String) });
    expect((bundle.payload.workspace as { guid: string }).guid).not.toBe("");
    expect(bundle.payload.partial).toBe(false);
  });

  it("uses engine singular payload keys (function, dbo), not friendly aliases", () => {
    const bundle = new Xano().registerFunctions([fn]).export();
    expect(bundle.payload).toHaveProperty("function");
    expect(bundle.payload).toHaveProperty("dbo");
    expect(bundle.payload).not.toHaveProperty("functions");
    expect(bundle.payload).not.toHaveProperty("tables");
  });

  it("generic register() routes a single def through its kind", () => {
    const bundle = new Xano().register("function", fn).export();
    expect(bundle.payload.function).toEqual([exportedFn]);
  });

  it("export round-trips through JSON.parse", () => {
    const bundle = new Xano().registerFunctions([fn]).export();
    expect(JSON.parse(JSON.stringify(bundle))).toEqual(bundle);
  });
});

describe("sig (Migrate::calcSignatureJson replica)", () => {
  it("phpJsonEncode matches the engine's \\xano::json_encode flags", () => {
    // The engine signs with JSON_HEX_QUOT|HEX_TAG|HEX_AMP|HEX_APOS|
    // UNESCAPED_SLASHES|UNESCAPED_UNICODE: '/' and non-ASCII stay RAW, while
    // " < > & ' become UPPERCASE \uXXXX. Verified byte-for-byte against a live
    // engine import. (Earlier this asserted the inverse, which the engine
    // rejected as "Invalid workspace signature".)
    expect(phpJsonEncode({ a: "x/y" })).toBe('{"a":"x/y"}');
    expect(phpJsonEncode({ a: "café" })).toBe('{"a":"café"}');
    expect(phpJsonEncode({ a: "can't <b> & \"q\"" })).toBe(
      '{"a":"can\\u0027t \\u003Cb\\u003E \\u0026 \\u0022q\\u0022"}',
    );
    // Control chars keep PHP's short escapes; a raw 0x1f -> lowercase \u001f.
    expect(phpJsonEncode({ a: "a" + String.fromCharCode(0x1f) })).toBe('{"a":"a\\u001f"}');
    expect(phpJsonEncode({ a: "x\ty\n" })).toBe('{"a":"x\\ty\\n"}');
  });

  it("calcSignatureJson is deterministic and key-order independent", () => {
    const a = calcSignatureJson({ app: "xano", version: "1.03", type: "workspace", payload: {} });
    const b = calcSignatureJson({ payload: {}, type: "workspace", version: "1.03", app: "xano" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_.-]+$/); // websafe base64 (+/= -> -_.)
  });

  it("calcSignatureJson preserves padding as '.' (engine base64_encodewebsafe)", () => {
    // Verified byte-for-byte against the engine's Migrate::calcSignatureJson;
    // the trailing '.' is the padding '=' mapped by strtr('+/=', '-_.').
    const sig = calcSignatureJson({ app: "xano", version: "1.03", type: "workspace", payload: {} });
    expect(sig).toBe("zmJNmZLe56nuEQ4brAmvr2ncgeo.");
  });

  it("buildBundle attaches a sig computed over the unsigned bundle", () => {
    const bundle = buildBundle({ sections: {} });
    const recomputed = calcSignatureJson({
      app: bundle.app,
      version: bundle.version,
      type: bundle.type,
      payload: bundle.payload,
    });
    expect(bundle.sig).toBe(recomputed);
  });
});
