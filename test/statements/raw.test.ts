/**
 * U1 — `raw()` verbatim statement passthrough.
 *
 * The contract under test is *preservation*: whatever a Xano bundle stored comes
 * back out unchanged, including keys this SDK has never heard of. That is what
 * makes a pulled workspace round-trippable before any decoder exists.
 */
import { describe, it, expect } from "vitest";
import { raw } from "../../src/codegen-entry.js";
import { encodeStatement } from "../../src/statements/statement.js";
import { s } from "../../src/statements/s.js";
import { c } from "../../src/values/value.js";

/** A complete stored envelope, shaped exactly as a bundle's `run[]` entry. */
const FULL_ENVELOPE = {
  as: "result",
  name: "mvp:set_var",
  _xsid: "",
  addon: [],
  input: [],
  mocks: {},
  output: { items: [], filters: [], customize: false },
  context: { name: "result", value: { value: "1", tag: "const:int", filters: [] } },
  runtime: null,
  disabled: false,
  description: "",
  settings_registry: null,
};

/** Encode and widen — `StackItemXdo` has no index signature to probe extra keys through. */
function enc(envelope: Record<string, unknown>): Record<string, unknown> {
  return encodeStatement(raw(envelope)) as unknown as Record<string, unknown>;
}

describe("raw() statement passthrough", () => {
  it("encodes a full 12-key stored envelope byte-identical to its input", () => {
    expect(encodeStatement(raw(FULL_ENVELOPE))).toEqual(FULL_ENVELOPE);
  });

  it("preserves an unknown extra key — a statement Xano ships after this release", () => {
    const encoded = enc({
      ...FULL_ENVELOPE,
      name: "mvp:some_future_statement",
      quantum_field: { a: 1 },
    });
    expect(encoded.quantum_field).toEqual({ a: 1 });
    expect(encoded.name).toBe("mvp:some_future_statement");
  });

  it("keeps input[] entries with keys beyond the canonical 7 unfiltered", () => {
    const entry = {
      name: "encoding",
      value: "json",
      tag: "const",
      filters: [],
      ignore: false,
      expand: false,
      children: [],
      future_key: "kept",
    };
    const encoded = enc({ ...FULL_ENVELOPE, input: [entry] });
    expect(encoded.input).toEqual([entry]);
  });

  it("does not canonicalize a populated settings_registry away", () => {
    const sr = [{ name: "api_key", value: "$env.KEY" }];
    const encoded = enc({ ...FULL_ENVELOPE, settings_registry: sr });
    expect(encoded.settings_registry).toEqual(sr);
  });

  it("does not merge a default over an authored output envelope", () => {
    const output = { customize: true, items: [{ name: "id" }], filters: [], extra: 1 };
    const encoded = enc({ ...FULL_ENVELOPE, output });
    expect(encoded.output).toEqual(output);
  });

  it("preserves a lean envelope exactly, inventing no keys", () => {
    // Passthrough means passthrough. The engine omits a key at its default, so
    // completing the envelope would change the bytes on the way back in — which
    // is the one thing this function exists to prevent. Confirmed against a real
    // pulled workspace, where a nested statement stored no `context` at all.
    const encoded = encodeStatement(raw({ name: "mvp:comment", context: {} }));
    expect(encoded).toEqual({ name: "mvp:comment", context: {} });
  });

  it("keeps canonical key ORDER while carrying only the keys present", () => {
    // Ordering is still normalized so output is deterministic regardless of how
    // the input object was built; presence is not.
    const encoded = encodeStatement(
      raw({ description: "note", context: {}, name: "mvp:comment", as: "x" }),
    );
    expect(Object.keys(encoded)).toEqual(["as", "name", "context", "description"]);
  });

  it("encodes a statement whose name has no registered factory", () => {
    expect(() =>
      encodeStatement(raw({ name: "mvp:not_in_the_catalog", context: { anything: true } })),
    ).not.toThrow();
  });

  it("leaves the unregistered-name guard intact for hand-authored statements", () => {
    expect(() => encodeStatement({ name: "mvp:someTypo", context: {} })).toThrow(
      /unregistered statement/i,
    );
  });

  it("rejects a non-envelope argument with a message naming what is required", () => {
    expect(() => raw({} as never)).toThrow(/name/i);
    expect(() => raw(null as never)).toThrow(/envelope/i);
    expect(() => raw([] as never)).toThrow(/envelope/i);
    expect(() => raw({ name: "" } as never)).toThrow(/name/i);
  });

  it("encodes correctly when nested inside a conditional's run[] at depth", () => {
    const nested = { ...FULL_ENVELOPE, name: "mvp:deeply_unknown", context: { depth: 2 } };
    const encoded = encodeStatement(
      s.conditional({
        when: { left: c.int(1), op: ">", right: c.int(0) },
        then: [s.group([raw(nested)])],
      }),
    ) as unknown as { context: { if: { run: { context: { run: unknown[] } }[] } } };
    expect(encoded.context.if.run[0]!.context.run[0]).toEqual(nested);
  });

  it("is absent from the `s` namespace (KTD-10)", () => {
    expect((s as Record<string, unknown>).raw).toBeUndefined();
  });
});
