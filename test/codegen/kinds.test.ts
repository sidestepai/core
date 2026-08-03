/**
 * U8 — per-kind decoder fidelity.
 *
 * `skeleton-roundtrip.test.ts` proves the *whole* payload re-exports equal; that
 * is the contract, but it fails as one undifferentiated assertion. This file asks
 * the same question one kind and one object at a time, so a regression names the
 * kind and the object rather than printing a whole-workspace diff.
 *
 * Three oracles, in descending order of authority:
 *
 * 1. **Engine goldens** — the ten kinds in `_capture.ts` are compared, after a
 *    full decode → write → re-export, against JSON a real Xano engine persisted.
 *    This is the only check that can catch the decoder and the encoder agreeing
 *    on a shape the engine does not.
 * 2. **Round-trip equality** — every object in the all-12-kinds sandbox.
 * 3. **Emitted source** — default elision is a readability claim the first two
 *    cannot see (a key elided and a key re-emitted at its default both
 *    round-trip), so it is asserted against the generated text directly.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalize } from "../../src/validate/normalize.js";
import { decodeBundle } from "../../src/codegen/index.js";
import type { GeneratedProject } from "../../src/codegen/index.js";
import { KIND_DECODERS } from "../../src/codegen/kinds/index.js";
import type { Bundle } from "../../src/workspace/export.js";
import { loadFixture } from "../conformance/harness.js";
import sandbox from "../../examples/sandbox/index.js";
import captureWs from "../../examples/sandbox/_capture.js";

/** Written inside the vite root so the generated tree resolves `@sidestep/core`. */
const OUT_ROOT = fileURLToPath(new URL("../.generated-kinds/", import.meta.url));

/** Decode a bundle, write the tree, import its barrel, and export again. */
async function regenerate(source: Bundle, name: string): Promise<Bundle> {
  const project = decodeBundle(source);
  const root = join(OUT_ROOT, name);
  rmSync(root, { recursive: true, force: true });
  for (const file of project.files) {
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.contents);
  }
  const mod = (await import(/* @vite-ignore */ join(root, "index.ts"))) as {
    default: { export(): Bundle };
  };
  return mod.default.export();
}

/** Objects in a payload section, keyed by name. */
function byName(payload: Record<string, unknown>, key: string): Map<string, unknown> {
  const section = payload[key];
  const entries = Array.isArray(section) ? section : [];
  return new Map(entries.map((o) => [(o as { name?: string }).name ?? "", o]));
}

describe("kind decoders — every object round-trips, per kind", () => {
  let source: Bundle;
  let regenerated: Bundle;
  let project: GeneratedProject;

  beforeAll(async () => {
    source = sandbox.export();
    project = decodeBundle(source);
    regenerated = await regenerate(source, "sandbox");
  });

  afterAll(() => rmSync(OUT_ROOT, { recursive: true, force: true }));

  // Table-driven over the decode registry itself, so a kind added without a
  // decoder — or a decoder added without coverage — shows up here.
  for (const decoder of KIND_DECODERS) {
    if (decoder.name === "workspace") continue; // singleton, asserted below
    it(`${decoder.name}: every object re-encodes normalize()-equal`, () => {
      const before = byName(source.payload as Record<string, unknown>, decoder.payloadKey);
      const after = byName(regenerated.payload as Record<string, unknown>, decoder.payloadKey);
      expect(before.size, `no ${decoder.name} objects in the sandbox to check`).toBeGreaterThan(0);
      for (const [name, original] of before) {
        expect(after.has(name), `${decoder.payloadKey} "${name}" missing after decode`).toBe(true);
        expect(normalize(after.get(name)), `${decoder.payloadKey} "${name}"`).toEqual(
          normalize(original),
        );
      }
    });
  }

  it("workspace-config round-trips, carrying its top-level env vars", () => {
    expect(normalize(regenerated.payload.workspace)).toEqual(
      normalize(source.payload.workspace),
    );
    // Workspace env vars live at top-level `payload.env`, not on the workspace
    // object, so a decoder reading only the workspace block drops them silently.
    expect(regenerated.payload.env).toEqual(source.payload.env);
    expect((source.payload.env as unknown[])?.length ?? 0).toBeGreaterThan(0);
  });

  it("leaves the engine's own workspace defaults out of the generated source", () => {
    // Oracle 3. The engine materializes every one of these on save, so a pull
    // used to carry ten lines nobody wrote and nobody can act on — and the round
    // trip above cannot see it, since a re-emitted default round-trips fine.
    const literal = project.files.find((f) => f.path === "workspace.ts")!.contents;
    const defaulted = decodeBundle({
      payload: {
        workspace: {
          name: "w",
          preferences: { allow_push: false, track_performance: true, use_internal_docs: false },
          settings: {
            ai_enabled: false,
            ai_settings: {
              providers: {
                google: { model: "", api_key: "" },
                openai: { model: "", api_key: "" },
                anthropic: { model: "", api_key: "" },
                "azure-openai": { model: "", api_key: "", base_url: "", api_version: "" },
              },
              default_provider: "free",
            },
            hide_xano_agent: false,
          },
          middleware: { query_pre: [], query_post: [], function_pre: [], function_post: [] },
          history: {
            query_enabled: true,
            query_limit: 100,
            function_enabled: false,
            function_limit: 100,
          },
          use_custom_names: false,
          defaults: { db_primary_key: "int" },
          datasources: [],
          datasource_live: { color: "#008000", show_banner: false },
        },
      },
    } as never).files.find((f) => f.path === "workspace.ts")!.contents;
    for (const key of [
      "preferences",
      "settings",
      "middleware",
      "history",
      "use_custom_names",
      "defaults",
      "datasources",
      "datasource_live",
    ]) {
      expect(defaulted, `all-default workspace still emits \`${key}\``).not.toContain(`${key}:`);
    }

    // The sandbox departs from the default on every one of them, so the same
    // keys must still be there — the elision is value-driven, not a blanket drop.
    for (const key of ["preferences", "settings", "use_custom_names", "defaults", "datasource_live"]) {
      expect(literal, `sandbox departure on \`${key}\` was dropped`).toContain(`${key}:`);
    }
    // And only the departing member of an opaque block is spelled out.
    expect(literal).toContain("settings: {\n    ai_enabled: true,\n  },");
    expect(literal).toContain("preferences: {\n    allow_push: true,\n  },");
  });

  it("emits no `guid:` on workspace-config — the one KTD-7 exemption", () => {
    // Every other kind states its guid explicitly; `WorkspaceConfigDef` declares
    // no such field, so emitting one would not even type-check.
    // The config has `workspace.ts` to itself, so the whole file is the literal
    // — no slicing out of the barrel's method chain.
    const literal = project.files.find((f) => f.path === "workspace.ts")!.contents;
    expect(literal).toContain("workspaceConfig({");
    // Match the def's OWN keys by indentation — a nested `{name, guid}`
    // middleware reference legitimately carries a guid and must not trip this.
    // Two spaces now, not four: a top-level const, no longer indented into a chain.
    expect(literal.split("\n").filter((line) => /^ {2}guid:/.test(line))).toEqual([]);
  });

  it("routes the two kinds sharing payload key `toolset` to their own registrars", () => {
    // `mcp_server` and `agent` both persist under `toolset`; tools persist under
    // `tool`. A three-way guess here would put agents in the mcp bucket.
    const barrel = project.files.find((f) => f.path === "index.ts")!.contents;
    expect(barrel).toContain(".registerMcpServers([");
    expect(barrel).toContain(".registerAgents([");
    expect(barrel).toContain(".registerTools([");
    const toolsets = byName(source.payload as Record<string, unknown>, "toolset");
    for (const object of toolsets.values()) {
      const type = (object as { type?: string }).type;
      expect(["mcp", "agent"]).toContain(type);
    }
  });

  it("reports nothing unsupported for a bundle this SDK fully models", () => {
    const unsupported = project.report
      .summarize()
      .byCategory.find((g) => g.category === "unsupported-section");
    expect(unsupported?.entries ?? []).toEqual([]);
  });
});

describe("kind decoders — engine-verified goldens", () => {
  /** `_capture.ts` object → the JSON a real engine persisted for it. */
  const GOLDENS: ReadonlyArray<readonly [kind: string, payloadKey: string, name: string, fixture: string]> = [
    ["table", "dbo", "ex_kind_products", "tables/ex_kind_products.json"],
    ["table (tableRef)", "dbo", "ex_field_table_ref", "tables/ex_field_table_ref.json"],
    ["query", "query", "ex_get_user", "query/ex_get_user.json"],
    ["query (agent run)", "query", "ex_ask_assistant", "query/ex_ask_assistant.json"],
    ["query (history)", "query", "ex_history_query", "query/ex_history_query.json"],
    ["trigger (table)", "trigger", "ex_kind_trigger_on_user_insert", "triggers/ex_kind_trigger_on_user_insert.json"],
    ["trigger (realtime)", "trigger", "ex_kind_trigger_on_message", "triggers/ex_kind_trigger_on_message.json"],
    ["trigger (workspace)", "trigger", "ex_kind_trigger_on_branch_live", "triggers/ex_kind_trigger_on_branch_live.json"],
    ["task", "task", "ex_kind_nightly_cleanup", "task/ex_kind_nightly_cleanup.json"],
    ["mcp server", "toolset", "ex_kind_mcp_server", "toolset/ex_kind_mcp_server.json"],
    ["agent", "toolset", "ex_assistant", "toolset/ex_assistant.json"],
    ["tool", "tool", "ex_kind_search_tool", "toolset/ex_kind_search_tool.json"],
    ["middleware", "middleware", "ex_kind_rate_limit", "middleware/ex_kind_rate_limit.json"],
    ["addon", "addon", "ex_kind_author_addon", "addon/ex_kind_author_addon.json"],
    // Captured through the real meta API on a disposable tenant, not hand-minted.
    ["microservice (builtin)", "microservice", "ex_kind_echo_service", "microservice/ex_kind_echo_service.json"],
    ["microservice (helm)", "microservice", "ex_kind_helm_service", "microservice/ex_kind_helm_service.json"],
  ];

  let regenerated: Bundle;

  beforeAll(async () => {
    regenerated = await regenerate(captureWs.export(), "capture");
  });

  afterAll(() => rmSync(OUT_ROOT, { recursive: true, force: true }));

  for (const [kind, payloadKey, name, fixture] of GOLDENS) {
    it(`${kind} (${name}) still matches its engine golden after a full decode`, () => {
      const object = byName(regenerated.payload as Record<string, unknown>, payloadKey).get(name);
      expect(object, `regenerated ${payloadKey} "${name}" not found`).toBeDefined();
      expect(normalize(object)).toEqual(normalize(loadFixture(fixture)));
    });
  }
});

describe("kind decoders — default elision", () => {
  let project: GeneratedProject;

  beforeAll(() => {
    project = decodeBundle(sandbox.export());
  });

  /** The generated source of the file holding a given exported symbol. */
  function sourceOf(symbol: string): string {
    const file = project.files.find((f) => f.contents.includes(`export const ${symbol} =`));
    expect(file, `no generated file exports ${symbol}`).toBeDefined();
    return file!.contents;
  }

  it("omits the boilerplate every encoder fills in from a default", () => {
    // The readability claim KTD-4 makes, stated against real generated output:
    // these keys are present in every stored object and in none of the defs that
    // did not author them. Round-tripping cannot see the difference.
    const source = sourceOf("ex_db_get_by_id");
    for (const key of ["cache:", "market_item:", "shared_workspace:", "branch:", "test:"]) {
      expect(source, `${key} should be elided at its default`).not.toContain(key);
    }
    expect(source).not.toContain('description: ""');
  });

  it("emits a block the author did customize", () => {
    // The other half of the claim: elision must be keyed on the stored value, not
    // on the key's name, or a customized block disappears. `ex_kind_public_api`
    // sets `history: false` against a defaulted-on container tier.
    expect(sourceOf("ex_kind_public_api")).toContain("history");
  });

  it("states the guid on every non-workspace def (KTD-7)", () => {
    // A pulled object's guid is the engine's own random value, not md5(type:name),
    // so an implicit guid silently repoints every reference to it.
    const source = sourceOf("ex_db_get_by_id");
    expect(source).toContain("guid:");
  });
});

describe("decodeBundle reporting", () => {
  const EMPTY_WORKSPACE = { name: "ws", description: "", canonical: "" };

  it("reports a non-empty payload section this SDK models no kind for", () => {
    // `knowledge` is a first-class engine object type SideStep declines to model.
    // The tree really is missing something a reader would expect, so it warns.
    const report = decodeBundle({
      payload: { workspace: EMPTY_WORKSPACE, knowledge: [{ name: "kb" }] },
    }).report;
    const entries = report.summarize().byCategory.find((g) => g.category === "unsupported-section");
    expect(entries?.entries.map((e) => e.detail).join()).toContain("payload.knowledge");
  });

  it("separates instance state from a gap in the pull", () => {
    // A vault secret must never be committed to a source tree, and install
    // history is a record of what was done TO the workspace rather than what it
    // is. Neither is missing from the tree — both are correctly absent — so
    // reporting them at the same volume as `knowledge` made 49 rows across the
    // survey corpus read as failures. Still reported; just not as gaps.
    const report = decodeBundle({
      payload: {
        workspace: EMPTY_WORKSPACE,
        vault: [{ name: "secret" }],
        run_install: [{ name: "r" }],
        action_package_install: [{ name: "a" }],
      },
    }).report;
    const summary = report.summarize();
    const owned = summary.byCategory.find((g) => g.category === "instance-owned");
    expect(owned?.count).toBe(3);
    expect(owned?.severity).toBe("notice");
    expect(owned?.entries.map((e) => e.detail).join()).toContain("payload.vault");
    // The load-bearing negative: nothing lands in the warning bucket.
    expect(summary.byCategory.some((g) => g.category === "unsupported-section")).toBe(false);
    expect(summary.bySeverity.warning).toBe(0);
  });

  it("reports a payload key it has never seen, rather than proceeding as if complete", () => {
    // The forward-compatibility case: Xano ships a new section and the tree would
    // otherwise be silently partial.
    const report = decodeBundle({
      payload: { workspace: EMPTY_WORKSPACE, quantum_flux: [{ name: "x" }] },
    }).report;
    const entries = report.summarize().byCategory.find((g) => g.category === "unsupported-section");
    expect(entries?.entries.map((e) => e.detail).join()).toContain("payload.quantum_flux");
  });

  it("stays quiet about an empty unsupported section", () => {
    const report = decodeBundle({
      payload: { workspace: EMPTY_WORKSPACE, vault: [], quantum_flux: [] },
    }).report;
    expect(report.summarize().byCategory).toEqual([]);
  });
});
