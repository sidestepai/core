import { describe, it, expect } from "vitest";
import { parseInputSchema } from "../../../src/statements/schema-dsl/input-schema.js";

/**
 * U1 — harvesting the runtime input schema, the only source that carries a
 * field's legal values.
 *
 * The fixtures mirror the declaration shapes that actually occur: quoted
 * defaults, interior whitespace in the values list, nested blocks, several
 * blocks in one source, and the non-literal forms that must be skipped rather
 * than guessed at. The harvester assumes nothing about the host language — a
 * source is a stored `mvp:*` name plus one or more quoted schema blocks — so
 * these fixtures carry only that.
 */

/** The catalog names a source can resolve against. */
const KNOWN = new Set(["mvp:example", "mvp:other"]);

/** A source: a stored name, then one quoted schema block per entry. */
function source(name: string, ...blocks: string[]): string {
  const declared = blocks.map((b) => `  $schema = decode('\n${b}\n  ');`).join("\n");
  return `  function name() { return "${name}"; }\n${declared}\n`;
}

describe("parseInputSchema", () => {
  it("harvests a field's declared values", () => {
    const parsed = parseInputSchema(
      source(
        "mvp:example",
        `      url: text
      bearer_token?: text
      connection_type?=sse: enum|values(["sse","stream"])
      tool_name: text
      args?: any`,
      ),
      KNOWN,
    );
    expect(parsed).toEqual({
      name: "mvp:example",
      enums: { connection_type: ["sse", "stream"] },
    });
  });

  it("strips interior whitespace from the values list", () => {
    const parsed = parseInputSchema(
      source("mvp:example", `      service_provider?="xano": enum|values(["resend", "xano"])`),
      KNOWN,
    );
    expect(parsed!.enums.service_provider).toEqual(["resend", "xano"]);
  });

  it("keeps the declared order rather than sorting", () => {
    const parsed = parseInputSchema(
      source("mvp:example", `      method?=POST: enum|values(["POST","GET","DELETE","PUT"])`),
      KNOWN,
    );
    expect(parsed!.enums.method).toEqual(["POST", "GET", "DELETE", "PUT"]);
  });

  it("reads a quoted default containing a space", () => {
    const parsed = parseInputSchema(
      source(
        "mvp:example",
        `      auth_type?="API Key": enum|values(["Basic","Bearer","API Key"])
      return_type?=search: enum|values(["search","count"])`,
      ),
      KNOWN,
    );
    expect(parsed!.enums).toEqual({
      auth_type: ["Basic", "Bearer", "API Key"],
      return_type: ["search", "count"],
    });
  });

  it("reads a field declared with a leading `?`", () => {
    const parsed = parseInputSchema(
      source("mvp:example", `      ?tenant_deploy?=null: enum|values(["auto","manual"])`),
      KNOWN,
    );
    expect(parsed!.enums.tenant_deploy).toEqual(["auto", "manual"]);
  });

  it("harvests across every block in the source, not just the first", () => {
    // A source declares several schemas; the one carrying the constraint is not
    // necessarily first, and reaching for a particular one would bake in a
    // layout this repo does not record.
    const parsed = parseInputSchema(
      source("mvp:example", `      ctx: text`, `      mode?=a: enum|values(["a","b"])`),
      KNOWN,
    );
    expect(parsed!.enums.mode).toEqual(["a", "b"]);
  });

  it("skips a values list that is not statically knowable", () => {
    expect(
      parseInputSchema(source("mvp:example", `      entry_obj_type: enum|values(%s)`), KNOWN),
    ).toBeNull();
  });

  it("excludes `tag`, which the SDK's own Tag union already models", () => {
    const parsed = parseInputSchema(
      source(
        "mvp:example",
        `      tag?=input: enum|values(["const","input","var"])
      duplicates?=replace: enum|values(["replace","append"])`,
      ),
      KNOWN,
    );
    expect(parsed!.enums).toEqual({ duplicates: ["replace", "append"] });
  });

  it("ignores nested block fields, which are not stored input names", () => {
    const parsed = parseInputSchema(
      source(
        "mvp:example",
        `      return_type?=search: enum|values(["search","count"])
      sort[]:
        field: text
        order: enum|values(["asc","desc"])`,
      ),
      KNOWN,
    );
    expect(parsed!.enums).toEqual({ return_type: ["search", "count"] });
  });

  it("ignores non-enum field types", () => {
    const parsed = parseInputSchema(
      source(
        "mvp:example",
        `        filename: text|prevent("..")|prevent("/")
        password?: text
        password_encryption?=standard: enum|values(["standard", "AES-128", "AES-192", "AES-256"])`,
      ),
      KNOWN,
    );
    expect(parsed!.enums).toEqual({
      password_encryption: ["standard", "AES-128", "AES-192", "AES-256"],
    });
  });

  it("skips a block declared with another delimiter rather than mis-slicing it", () => {
    const src = `  function name() { return "mvp:example"; }
  $schema = decode("
      mode?=a: enum|values(["a","b"])
  ");`;
    expect(parseInputSchema(src, KNOWN)).toBeNull();
  });

  it("keeps a single deterministic entry when a field is declared twice", () => {
    const parsed = parseInputSchema(
      source(
        "mvp:example",
        `      mode?=a: enum|values(["a","b"])
      mode?=a: enum|values(["c","d"])`,
      ),
      KNOWN,
    );
    expect(parsed!.enums.mode).toEqual(["a", "b"]);
  });

  it("skips a source naming more than one known statement rather than guessing", () => {
    // Ambiguous ownership: attaching the constraint to the wrong statement
    // would narrow a signature the engine does not narrow.
    const src = source("mvp:example", `      mode?=a: enum|values(["a","b"])`) + `  "mvp:other"\n`;
    expect(parseInputSchema(src, KNOWN)).toBeNull();
  });

  it("skips a source naming no statement the catalog knows", () => {
    const parsed = parseInputSchema(
      source("mvp:not_in_catalog", `      mode?=a: enum|values(["a","b"])`),
      KNOWN,
    );
    expect(parsed).toBeNull();
  });

  it("returns null when the source declares no enum-constrained field", () => {
    expect(
      parseInputSchema(source("mvp:example", `      value1: decimal\n      value2: decimal`), KNOWN),
    ).toBeNull();
  });

  it("returns null when the source declares no schema block", () => {
    expect(parseInputSchema(`  function name() { return "mvp:example"; }`, KNOWN)).toBeNull();
  });
});
