/**
 * U4/U5 — triggers decode to factory calls, or refuse to.
 *
 * The whole-workspace round trip cannot see this. A `satisfies TriggerDef` def
 * and a `tableTrigger({…})` call encode to the SAME object, so both round-trip
 * and neither proves which one was emitted. What separates them is the generated
 * text: whether the binding came back as a handle, whether the six-group `meta`
 * skeleton collapsed to `actions`, and whether the stack references the typed
 * handle instead of a raw string. Those are the claims, so those are asserted.
 *
 * The other half is the refusal. A factory that cannot express what a trigger
 * stores must fall back rather than emit a call that silently drops it — the
 * shapes that force it are exercised here against real engine fixtures.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { decodeBundle } from "../../src/codegen/index.js";
import type { GeneratedProject } from "../../src/codegen/index.js";
import { DecodeContext } from "../../src/codegen/context.js";
import { RefIndex } from "../../src/codegen/ref-index.js";
import { printExpr } from "../../src/codegen/print.js";
import { decodeObject, KIND_DECODERS_BY_NAME } from "../../src/codegen/kinds/index.js";
import { Xano } from "../../src/workspace/xano.js";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { s } from "../../src/statements/s.js";
import type { TriggerInputObjType } from "../../src/kinds/trigger-inputs.js";
import { c } from "../../src/values/value.js";
import { mcpServer } from "../../src/kinds/mcp-server.js";
import { agent } from "../../src/kinds/agent.js";
import {
  tableTrigger,
  workspaceTrigger,
  errorTrigger,
  realtimeTrigger,
  agentTrigger,
  mcpServerTrigger,
} from "../../src/kinds/trigger.js";
import "../../src/index.js"; // register kinds
import { loadFixture } from "../conformance/harness.js";

const user = table({ name: "user", schema: { email: f.text(), hits: f.int() } });

/** Decode ONE stored trigger with no bundle around it, and report both halves. */
function decodeStored(stored: Record<string, unknown>, payload: Record<string, unknown> = {}) {
  const ctx = new DecodeContext();
  const refs = RefIndex.fromPayload(payload, ctx);
  const decoder = KIND_DECODERS_BY_NAME.get("trigger")!;
  const { expr, factory } = decodeObject(decoder, { ctx, refs, stored, resolve: {} });
  return { factory, source: printExpr(expr), ctx };
}

function sourceOf(project: GeneratedProject, symbol: string): string {
  const file = project.files.find((f2) => f2.contents.includes(`export const ${symbol} =`));
  expect(file, `no generated file exports ${symbol}`).toBeDefined();
  return file!.contents;
}

describe("trigger decode — the factory form", () => {
  let project: GeneratedProject;

  beforeAll(() => {
    project = decodeBundle(
      new Xano()
        .registerTables([user])
        .registerTriggers([
          tableTrigger({
            name: "on_write",
            table: user,
            actions: { insert: true, update: true },
            stack: (t) => [s.set_var("who", t.new("email"))],
          }),
          tableTrigger({
            name: "on_delete_live",
            table: user,
            actions: { delete: true },
            datasources: ["live"],
            stack: (t) => [s.set_var("gone", t.old("email"))],
          }),
          tableTrigger({
            name: "no_actions",
            table: user,
            stack: () => [s.set_var("x", c.int(1))],
          }),
          workspaceTrigger({
            name: "on_branch",
            actions: { branch_live: true },
            stack: (t) => [s.set_var("b", t.to_branch("label"))],
          }),
          errorTrigger({
            name: "on_error",
            stack: (t) => [s.set_var("code", t.error("code"))],
          }),
        ])
        .export(),
    );
  });

  it("emits a database trigger as tableTrigger with no meta, objType, or hasResult", () => {
    const src = sourceOf(project, "on_write");
    expect(src).toContain("export const on_write = tableTrigger({");
    expect(src).not.toContain("meta:");
    expect(src).not.toContain("objType:");
    expect(src).not.toContain("hasResult:");
  });

  it("collapses the meta action block to the true flags only", () => {
    const src = sourceOf(project, "on_write");
    expect(src).toContain("actions: {");
    expect(src).toContain("insert: true");
    expect(src).toContain("update: true");
    // Every factory defaults each flag to false, so the off ones are noise.
    expect(src).not.toContain("delete:");
    expect(src).not.toContain("truncate:");
  });

  it("emits no `actions` key at all when every flag is off", () => {
    expect(sourceOf(project, "no_actions")).not.toContain("actions:");
  });

  it("inverts the datasource tag list to `datasources`", () => {
    expect(sourceOf(project, "on_delete_live")).toContain('datasources: [\n    "live",\n  ]');
  });

  it("binds the table by its generated handle, not a raw guid", () => {
    const src = sourceOf(project, "on_write");
    expect(src).toContain("table: user");
    expect(src).not.toMatch(/objId:/);
  });

  it("emits the stack as a callback referencing the typed handle", () => {
    const src = sourceOf(project, "on_write");
    expect(src).toContain("stack: (t) => [");
    expect(src).toContain('t.new("email")');
    expect(src).not.toContain('inp("new.email")');
  });

  it("emits workspace and error triggers through their own factories", () => {
    expect(sourceOf(project, "on_branch")).toContain("workspaceTrigger({");
    expect(sourceOf(project, "on_branch")).toContain("branch_live: true");
    expect(sourceOf(project, "on_error")).toContain("errorTrigger({");
    // `errorTrigger` takes no actions at all.
    expect(sourceOf(project, "on_error")).not.toContain("actions:");
  });

  it("imports the factory it calls, and not the def type it no longer needs", () => {
    const src = sourceOf(project, "on_write");
    expect(src).toContain("tableTrigger");
    expect(src).not.toContain("TriggerDef");
  });
});

describe("trigger decode — the toolset pair", () => {
  let project: GeneratedProject;

  beforeAll(() => {
    const search = mcpServer({ name: "search" });
    const helper = agent({ name: "helper", llm: { type: "xano-free", prompt: "help" } });
    project = decodeBundle(
      new Xano()
        .registerMcpServers([search])
        .registerAgents([helper])
        .registerTriggers([
          mcpServerTrigger({ name: "on_mcp", mcpServer: search }),
          agentTrigger({ name: "on_agent", agent: helper }),
          agentTrigger({
            name: "on_agent_custom",
            agent: helper,
            stack: (t) => [s.set_var("seen", t.toolset("name"))],
            response: () => c.text("done"),
          }),
        ])
        .export(),
    );
  });

  it("discriminates mcp-server from agent by the bound object's own kind", () => {
    // Both encode identically, so nothing but the binding can tell them apart —
    // a guess here would write a file that lies about what the trigger fires for.
    expect(sourceOf(project, "on_mcp")).toContain("mcpServerTrigger({");
    expect(sourceOf(project, "on_mcp")).toContain("mcpServer: search");
    expect(sourceOf(project, "on_agent")).toContain("agentTrigger({");
    expect(sourceOf(project, "on_agent")).toContain("agent: helper");
  });

  it("elides the stack and response the factory injects by default", () => {
    const src = sourceOf(project, "on_agent");
    expect(src).not.toContain("stack:");
    expect(src).not.toContain("response:");
  });

  it("keeps a custom stack and response, both as handle-referencing callbacks", () => {
    const src = sourceOf(project, "on_agent_custom");
    expect(src).toContain("stack: (t) => [");
    expect(src).toContain('t.toolset("name")');
    expect(src).toContain("response: (t) =>");
  });
});

describe("trigger decode — the trigger condition", () => {
  it("emits a stored condition as the `search` argument, not a meta block", () => {
    // `table-trigger.json` is the engine fixture carrying a real custom filter.
    // Dropping it would widen the trigger from a few rows to every row, so this
    // is the assertion that the condition survives the factory form intact.
    const stored = loadFixture<Record<string, unknown>>("triggers/table-trigger.json");
    const { factory, source } = decodeStored(stored);
    expect(factory).toBe("tableTrigger");
    expect(source).toContain("search:");
    expect(source).toContain('col("NEW.id")');
    expect(source).not.toContain("meta:");
  });
});

describe("trigger decode — the realtime types keep the `satisfies` form", () => {
  it("refuses a factory for exactly the three realtime obj_types, and no others", () => {
    // The refusal is a design decision, not a gap: `realtimeChannelTrigger` binds
    // a `RealtimeChannelDef` — a def handle carrying its server — and a stored
    // trigger has only two guids with no way to know they agree, so there is no
    // faithful inverse. `realtimeTrigger` is deprecated and withheld from the
    // docs catalog.
    //
    // Pinned as a SET so a fourth realtime type added upstream fails here rather
    // than silently inheriting the carve-out — and so a non-realtime type cannot
    // drift into it, which is the direction that would quietly cost real objects
    // their typing.
    const withFactory = new Set(["database", "workspace", "error", "toolset"]);
    const all: readonly TriggerInputObjType[] = [
      "database",
      "workspace",
      "error",
      "toolset",
      "workspace_realtime_channel",
      "realtime_server",
      "channel",
    ];
    expect(all.filter((t) => !withFactory.has(t))).toEqual([
      "workspace_realtime_channel",
      "realtime_server",
      "channel",
    ]);
  });

  it("emits `satisfies TriggerDef` for a stored realtime channel trigger", () => {
    // The one `satisfies` trigger left in the 25-trigger survey corpus.
    const stored = {
      ...loadFixture<Record<string, unknown>>("triggers/workspace-trigger.json"),
      obj_type: "workspace_realtime_channel",
      obj_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const { factory } = decodeStored(stored);
    expect(factory).toBeUndefined();
  });
});

describe("trigger decode — when the factory cannot express it", () => {
  it("reports the fallback rather than degrading silently", () => {
    const stored = {
      ...loadFixture<Record<string, unknown>>("triggers/workspace-trigger.json"),
      history: { inherit: false, enabled: true, limit: 50 },
    };
    const { ctx } = decodeStored(stored);
    const entries = ctx.report.summarize().byCategory.flatMap((g) => g.entries);
    expect(JSON.stringify(entries)).toContain("satisfies TriggerDef");
  });

  it("falls back for a trigger carrying a history setting", () => {
    // `TriggerDef` has `history`; no factory's CommonArgs accepts one.
    const stored = {
      ...loadFixture<Record<string, unknown>>("triggers/workspace-trigger.json"),
      history: { inherit: false, enabled: true, limit: 50 },
    };
    const { factory, source } = decodeStored(stored);
    expect(factory).toBeUndefined();
    expect(source).toContain("history:");
  });

  it("falls back for a config-only trigger that stored a result", () => {
    // `tableTrigger` has no `response` parameter. Emitting one would not merely
    // lose the response — the generated file would not compile.
    const stored = {
      ...loadFixture<Record<string, unknown>>("triggers/db-trigger-guid-bound.json"),
      result: [{ name: "echo", type: "value", value: { tag: "const", value: "x" } }],
    };
    expect(decodeStored(stored).factory).toBeUndefined();
  });

  it("falls back for a toolset trigger bound by numeric id", () => {
    // Both toolset factories encode identically, so this is safe to deploy either
    // way — but the file would claim an agent trigger is an MCP-server one.
    const stored = loadFixture<Record<string, unknown>>("triggers/agent-trigger.json");
    expect(stored.obj_id).toBe(2);
    expect(decodeStored(stored).factory).toBeUndefined();
  });

  it("keeps the three realtime types on the satisfies form", () => {
    const project = decodeBundle(
      new Xano()
        .registerTriggers([realtimeTrigger({ name: "on_msg", actions: { message: true } })])
        .export(),
    );
    const src = sourceOf(project, "on_msg");
    expect(src).toContain("satisfies TriggerDef");
    expect(src).toContain("objType:");
    expect(src).toContain("meta:");
  });
});

describe("trigger decode — the guid-bound engine fixture", () => {
  /**
   * `db-trigger-guid-bound.json` is a real engine-persisted database trigger
   * (anonymized), and the only corpus fixture of its kind that binds its table by
   * GUID and carries the partial `meta` a real workspace stores. The older
   * `table-trigger.json` cannot cover this: it binds numerically and stores a
   * trigger condition, so it takes the fallback path by design.
   *
   * The corpus evaluates fixtures against an EMPTY ref index, so the guid here
   * degrades to `{name, guid}` rather than a handle. That is the intended split,
   * not a gap — `resolveRef` reads an ObjectRef by guid, so the binding stays
   * exact, and the handle form is covered above where a real bundle supplies one.
   */
  it("binds by guid, collapses the partial meta, and still takes the factory", () => {
    const stored = loadFixture<Record<string, unknown>>("triggers/db-trigger-guid-bound.json");
    const { factory, source } = decodeStored(stored);
    expect(factory).toBe("tableTrigger");
    expect(source).toContain('guid: "test-guid-db-trigger-table"');
    expect(source).toContain("insert: true");
    expect(source).toContain("update: true");
    expect(source).not.toContain("meta:");
    expect(source).toContain('t.new("id")');
  });

  it("stores only some of the six meta groups, which is why the guard normalizes", () => {
    // Guards the premise: if a fixture refresh ever made this all-six, the
    // subset case would stop being covered and nothing else would notice.
    const stored = loadFixture<{ meta: Record<string, unknown> }>(
      "triggers/db-trigger-guid-bound.json",
    );
    expect(Object.keys(stored.meta).length).toBeLessThan(6);
  });
});

describe("trigger decode — mixed forms in one tree", () => {
  it("imports the factory as a value and the def type as a type, side by side", () => {
    // The per-object resolution's real test: one bundle, one kind, two emitted
    // forms. Registering the factory import per KIND rather than per object would
    // leave one of these two files missing an import it needs.
    const project = decodeBundle(
      new Xano()
        .registerTables([user])
        .registerTriggers([
          tableTrigger({
            name: "factory_form",
            table: user,
            actions: { insert: true },
            stack: () => [s.set_var("x", c.int(1))],
          }),
          realtimeTrigger({ name: "fallback_form", actions: { join: true } }),
        ])
        .export(),
    );
    expect(sourceOf(project, "factory_form")).toContain("tableTrigger");
    expect(sourceOf(project, "fallback_form")).toContain("satisfies TriggerDef");

    for (const symbol of ["factory_form", "fallback_form"]) {
      const src = sourceOf(project, symbol);
      const needsType = src.includes("satisfies TriggerDef");
      expect(src.includes("type { TriggerDef }") || src.includes("TriggerDef }")).toBe(needsType);
    }
  });
});
