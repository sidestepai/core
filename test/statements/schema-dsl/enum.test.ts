import { describe, it, expect } from "vitest";
import { attachEnums } from "../../../src/statements/schema-dsl/enums.js";
import type { EnumIndex } from "../../../src/statements/schema-dsl/enums.js";
import type { StatementSpec } from "../../../src/statements/schema-dsl/interpret.js";
import { GENERATED_SPECS } from "../../../src/statements/generated/catalog.js";

/**
 * U2 — carrying the harvested enum constraints onto the spec catalog.
 *
 * The catalog assertions below are the ones that would go quiet if the join
 * were ever resequenced before `applySpecOverrides`, or rekeyed off the
 * authored field name instead of the stored input name. Both are real hazards:
 * the override pass synthesizes and renames input rules.
 */

/** Every rule in the committed catalog that carries an enum, as `name.storedField`. */
function committedEnumRules(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const spec of GENERATED_SPECS) {
    for (const rule of spec.rules) {
      if (rule.enum && rule.route.kind === "input") {
        out.set(`${spec.name}.${rule.route.name}`, rule.enum);
      }
    }
  }
  return out;
}

function specOf(name: string): StatementSpec {
  const spec = GENERATED_SPECS.find((s) => s.name === name);
  expect(spec, `missing spec ${name}`).toBeDefined();
  return spec!;
}

describe("attachEnums", () => {
  const index: EnumIndex = new Map([["mvp:example", { mode: ["a", "b"] }]]);

  const spec = (): StatementSpec => ({
    name: "mvp:example",
    rules: [
      { field: "as", type: "string", optional: true, route: { kind: "as" } },
      { field: "mode", type: "value", optional: true, route: { kind: "input", name: "mode" } },
      { field: "other", type: "value", optional: true, route: { kind: "input", name: "other" } },
    ],
  });

  it("attaches the values to the matching input rule", () => {
    const s = spec();
    attachEnums(s, index);
    expect(s.rules.find((r) => r.field === "mode")?.enum).toEqual(["a", "b"]);
    expect(s.rules.find((r) => r.field === "other")?.enum).toBeUndefined();
  });

  it("joins on the STORED input name, not the authored field name", () => {
    const s: StatementSpec = {
      name: "mvp:example",
      rules: [
        // Authored `alias`, stored `mode` — only the stored name may match.
        { field: "alias", type: "value", optional: true, route: { kind: "input", name: "mode" } },
        // Authored `mode`, stored `something_else` — must NOT match.
        { field: "mode", type: "value", optional: true, route: { kind: "input", name: "something_else" } },
      ],
    };
    attachEnums(s, index);
    expect(s.rules.find((r) => r.field === "alias")?.enum).toEqual(["a", "b"]);
    expect(s.rules.find((r) => r.field === "mode")?.enum).toBeUndefined();
  });

  it("never attaches to a non-input rule", () => {
    const s: StatementSpec = {
      name: "mvp:example",
      rules: [{ field: "mode", type: "string", optional: true, route: { kind: "context-plain", path: "mode" } }],
    };
    attachEnums(s, index);
    expect(s.rules[0]!.enum).toBeUndefined();
  });

  it("is idempotent", () => {
    const s = spec();
    attachEnums(s, index);
    const once = structuredClone(s);
    attachEnums(s, index);
    expect(s).toEqual(once);
  });

  it("copies the values rather than sharing the index's array", () => {
    const s = spec();
    attachEnums(s, index);
    s.rules.find((r) => r.field === "mode")!.enum!.push("mutated");
    expect(index.get("mvp:example")!.mode).toEqual(["a", "b"]);
  });

  it("is a no-op for a statement the index does not cover", () => {
    const s: StatementSpec = { name: "mvp:uncovered", rules: spec().rules };
    const before = structuredClone(s);
    attachEnums(s, index);
    expect(s).toEqual(before);
  });

  it("leaves the spec untouched given an empty index (the floor's precondition)", () => {
    const s = spec();
    const before = structuredClone(s);
    attachEnums(s, new Map());
    expect(s).toEqual(before);
  });
});

describe("the committed catalog's enum constraints", () => {
  it("carries the MCP connection_type constraint that motivated this", () => {
    const rule = specOf("mvp:mcp_call_tool").rules.find((r) => r.field === "connection_type");
    expect(rule?.enum).toEqual(["sse", "stream"]);
  });

  it("covers all three MCP surfaces, not just the one that was reported", () => {
    for (const name of ["mvp:mcp_call_tool", "mvp:mcp_list_tools", "mvp:mcp_server_details"]) {
      expect(specOf(name).rules.find((r) => r.field === "connection_type")?.enum).toEqual([
        "sse",
        "stream",
      ]);
    }
  });

  it("leaves `tool` unconstrained — it stores as `tool_name` and is free text", () => {
    const rule = specOf("mvp:mcp_call_tool").rules.find((r) => r.field === "tool");
    expect(rule?.route).toEqual({ kind: "input", name: "tool_name" });
    expect(rule?.enum).toBeUndefined();
  });

  it("reaches an input rule the OVERRIDE pass synthesized (ordering assertion)", () => {
    // `auth_type` is absent from upstream's transform schema for this statement;
    // `reshapeInputs` adds it. If the enum join ran before the overrides, this
    // rule would exist but carry no constraint.
    const rule = specOf("mvp:elasticsearch_query").rules.find((r) => r.field === "auth_type");
    expect(rule?.enum).toEqual(["Basic", "Bearer", "API Key"]);
  });

  it("reaches every synthesized auth_type across the search family", () => {
    const expected: Record<string, string[]> = {
      "mvp:elasticsearch_document": ["Basic", "Bearer", "API Key"],
      "mvp:elasticsearch_query": ["Basic", "Bearer", "API Key"],
      "mvp:elasticsearch_request": ["Basic", "Bearer", "API Key"],
      "mvp:amazon_opensearch_document": ["IAM", "master"],
      "mvp:amazon_opensearch_query": ["IAM", "master"],
      "mvp:amazon_opensearch_request": ["IAM", "master"],
    };
    for (const [name, values] of Object.entries(expected)) {
      expect(specOf(name).rules.find((r) => r.field === "auth_type")?.enum, name).toEqual(values);
    }
  });

  it("preserves the engine's declared order rather than sorting", () => {
    expect(specOf("mvp:algolia_request").rules.find((r) => r.field === "method")?.enum).toEqual([
      "POST",
      "GET",
      "DELETE",
      "PUT",
    ]);
  });

  it("keeps values with spaces and punctuation verbatim", () => {
    expect(specOf("mvp:elasticsearch_query").rules.find((r) => r.field === "auth_type")?.enum).toContain(
      "API Key",
    );
    expect(specOf("mvp:crypto_jwe_encode3").rules.find((r) => r.field === "key_algorithm")?.enum).toContain(
      "ECDH-ES+A128KW",
    );
    expect(
      specOf("mvp:zip_create_file_resource").rules.find((r) => r.field === "password_encryption")?.enum,
    ).toEqual(["standard", "AES-128", "AES-192", "AES-256"]);
  });

  it("constrains exactly the 36 known fields — no silent loss, no invented 37th", () => {
    const rules = committedEnumRules();
    expect(rules.size).toBe(36);
    // Spot-check the far ends of the set so a wholesale swap can't pass on count alone.
    expect(rules.get("mvp:datadog_metric.type")).toEqual([
      "count",
      "gauge",
      "rate",
      "histogram",
      "distribution",
    ]);
    expect(rules.get("mvp:send_email.service_provider")).toEqual(["resend", "xano"]);
    expect(rules.get("mvp:amazon_s3_upload_file.object_lock_mode")).toEqual([
      "compliance",
      "governance",
    ]);
  });

  it("never constrains a `tag` field — the SDK's Tag union already models those", () => {
    for (const key of committedEnumRules().keys()) {
      expect(key.endsWith(".tag")).toBe(false);
    }
  });

  it("only ever constrains input-routed rules", () => {
    for (const spec of GENERATED_SPECS) {
      for (const rule of spec.rules) {
        if (rule.enum) expect(rule.route.kind, `${spec.name}.${rule.field}`).toBe("input");
      }
    }
  });

  it("declares no empty or duplicated value set", () => {
    for (const [key, values] of committedEnumRules()) {
      expect(values.length, key).toBeGreaterThan(0);
      expect(new Set(values).size, key).toBe(values.length);
    }
  });
});
