import { describe, it, expect } from "vitest";
import { parseInputSchema } from "../../../src/statements/schema-dsl/input-schema.js";

/**
 * U1 — harvesting the engine's runtime input schema, which is the only source
 * that carries a field's legal values. The fixtures below mirror the real
 * declaration shapes: quoted defaults, interior whitespace in the values list,
 * nested blocks, and the non-literal forms that must be skipped rather than
 * guessed at.
 */

/** Build a statement source around a runtime input schema block. */
function source(name: string, block: string, opts: { quote?: string } = {}): string {
  const q = opts.quote ?? "'";
  return `<?php
class Example extends \\xano\\xs\\Statement {
  function getName() : string {
    return "${name}";
  }

  function getInputSchema(\\xano\\xs\\statement\\Context $ctx) {
    $schema = \\xano::decode(${q}
${block}
    ${q});

    return $schema;
  }

  function getOutputSchema(\\xano\\xs\\statement\\Context $ctx) {
  }
}`;
}

describe("parseInputSchema", () => {
  it("harvests a field's declared values", () => {
    const parsed = parseInputSchema(
      source(
        "mvp:mcp_call_tool",
        `      url: text
      bearer_token?: text
      connection_type?=sse: enum|values(["sse","stream"])
      tool_name: text
      args?: any`,
      ),
    );
    expect(parsed).toEqual({
      name: "mvp:mcp_call_tool",
      enums: { connection_type: ["sse", "stream"] },
    });
  });

  it("strips interior whitespace from the values list", () => {
    const parsed = parseInputSchema(
      source("mvp:send_email", `      service_provider?="xano": enum|values(["resend", "xano"])`),
    );
    expect(parsed!.enums.service_provider).toEqual(["resend", "xano"]);
  });

  it("keeps the engine's declared order rather than sorting", () => {
    const parsed = parseInputSchema(
      source("mvp:algolia_request", `      method?=POST: enum|values(["POST","GET","DELETE","PUT"])`),
    );
    expect(parsed!.enums.method).toEqual(["POST", "GET", "DELETE", "PUT"]);
  });

  it("reads a quoted default containing a space", () => {
    const parsed = parseInputSchema(
      source(
        "mvp:elasticsearch_query",
        `      auth_type?="API Key": enum|values(["Basic","Bearer","API Key"])
      return_type?=search: enum|values(["search","count"])`,
      ),
    );
    expect(parsed!.enums).toEqual({
      auth_type: ["Basic", "Bearer", "API Key"],
      return_type: ["search", "count"],
    });
  });

  it("reads a field declared with a leading `?`", () => {
    const parsed = parseInputSchema(
      source("mvp:microservice_scaffold", `      ?tenant_deploy?=null: enum|values(["auto","manual"])`),
    );
    expect(parsed!.enums.tenant_deploy).toEqual(["auto", "manual"]);
  });

  it("skips a values list that is not statically knowable", () => {
    const parsed = parseInputSchema(
      source("mvp:workspace_multidoc_debug", `      entry_obj_type: enum|values(%s)`),
    );
    expect(parsed).toBeNull();
  });

  it("excludes `tag`, which the SDK's own Tag union already models", () => {
    const parsed = parseInputSchema(
      source(
        "mvp:set_header",
        `      tag?=input: enum|values(["const","input","var"])
      duplicates?=replace: enum|values(["replace","append"])`,
      ),
    );
    expect(parsed!.enums).toEqual({ duplicates: ["replace", "append"] });
  });

  it("ignores nested block fields, which are not stored input names", () => {
    const parsed = parseInputSchema(
      source(
        "mvp:elasticsearch_query",
        `      return_type?=search: enum|values(["search","count"])
      sort[]:
        field: text
        order: enum|values(["asc","desc"])`,
      ),
    );
    expect(parsed!.enums).toEqual({ return_type: ["search", "count"] });
  });

  it("ignores non-enum field types", () => {
    const parsed = parseInputSchema(
      source(
        "mvp:zip_create_file_resource",
        `        filename: text|prevent("..")|prevent("/")
        password?: text
        password_encryption?=standard: enum|values(["standard", "AES-128", "AES-192", "AES-256"])`,
      ),
    );
    expect(parsed!.enums).toEqual({
      password_encryption: ["standard", "AES-128", "AES-192", "AES-256"],
    });
  });

  it("skips a schema block declared with another delimiter rather than mis-slicing it", () => {
    const parsed = parseInputSchema(
      source("mvp:example", `      mode?=a: enum|values(["a","b"])`, { quote: '"' }),
    );
    expect(parsed).toBeNull();
  });

  it("keeps a single deterministic entry when a field is declared twice", () => {
    const parsed = parseInputSchema(
      source(
        "mvp:example",
        `      mode?=a: enum|values(["a","b"])
      mode?=a: enum|values(["c","d"])`,
      ),
    );
    expect(parsed!.enums.mode).toEqual(["a", "b"]);
  });

  it("does not reach into the output schema", () => {
    const src = `<?php
  function getName() : string {
    return "mvp:send_email";
  }
  function getInputSchema($ctx) {
    $schema = \\xano::decode('
      service_provider?="xano": enum|values(["resend", "xano"])
    ');
    return $schema;
  }
  function getOutputSchema($ctx) {
    return \\xano::decode('
      status?: enum|values(["success", "error"])
    ');
  }`;
    expect(parseInputSchema(src)!.enums).toEqual({ service_provider: ["resend", "xano"] });
  });

  it("returns null when the source declares no stored name", () => {
    const src = `<?php
  function getInputSchema($ctx) {
    $schema = \\xano::decode('
      mode?=a: enum|values(["a","b"])
    ');
  }`;
    expect(parseInputSchema(src)).toBeNull();
  });

  it("returns null when the source declares no runtime input schema", () => {
    expect(parseInputSchema(`<?php\n  function getName() : string { return "mvp:noop"; }`)).toBeNull();
  });

  it("returns null when the statement declares no enum-constrained field", () => {
    expect(parseInputSchema(source("mvp:math_add", `      value1: decimal\n      value2: decimal`))).toBeNull();
  });
});
