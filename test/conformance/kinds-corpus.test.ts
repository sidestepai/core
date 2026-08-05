/**
 * Whole-object conformance corpus for authored KINDS (sibling of
 * `corpus.test.ts`, which covers statements). Each row asserts that the SDK's
 * compiled payload object for a kind deep-equals the real engine-persisted
 * golden after `normalize()` — the same byte-fidelity oracle the statement
 * corpus uses, now applied to tables, queries, triggers, tasks, toolsets,
 * tools, middleware, and addons.
 *
 * These goldens were sourced live via `sidestep validate --capture` against a
 * disposable instance (plan 2026-07-22-008). The single authored input is the
 * curated capture harness `examples/sandbox/_capture.ts` — the same maintained
 * example objects that produced the goldens — exported ONCE here and matched by
 * name per kind. Because the capture round-trip already proved
 * `normalize(export) == normalize(fetched)` for these objects, this offline test
 * reproduces that equality deterministically with no network.
 *
 * A row failing is the usual fork (see the `xano-fixtures` skill): a missing
 * `normalize()` strip rule (Branch A) or a genuine encoder divergence (Branch B).
 * The per-kind normalize rules these goldens required are unit-tested in
 * `test/validate/normalize.test.ts`.
 */
import { describe, it, expect } from "vitest";
import "../../src/index.js"; // load all kind + statement registrations
import { normalize, loadFixture } from "./harness.js";
import captureWs from "../../examples/sandbox/_capture.js";

/** Export the curated capture workspace once; match compiled objects by name. */
const payload = captureWs.export().payload as Record<string, Array<Record<string, unknown>>>;
const compiled = (key: string, name: string): Record<string, unknown> | undefined =>
  (payload[key] ?? []).find((o) => o.name === name);

/** fixture = persisted golden path; (payloadKey, name) locate the compiled twin. */
const KIND_CORPUS: Array<{ kind: string; payloadKey: string; name: string; fixture: string }> = [
  // U1 — dbo, incl. the flagged f.tableRef persisted table-object readback.
  { kind: "table (tableRef)", payloadKey: "dbo", name: "ex_field_table_ref", fixture: "tables/ex_field_table_ref.json" },
  { kind: "table", payloadKey: "dbo", name: "ex_kind_products", fixture: "tables/ex_kind_products.json" },
  // U2 — query (plain + agent-invoking).
  { kind: "query", payloadKey: "query", name: "ex_get_user", fixture: "query/ex_get_user.json" },
  { kind: "query (agent run)", payloadKey: "query", name: "ex_ask_assistant", fixture: "query/ex_ask_assistant.json" },
  // Customized (inherit:false) request-history — the authored history byte-verify golden.
  { kind: "query (history)", payloadKey: "query", name: "ex_history_query", fixture: "query/ex_history_query.json" },
  // U3 — trigger: table (obj_id = table guid), realtime (response), workspace (numeric obj_id dropped).
  { kind: "trigger (table)", payloadKey: "trigger", name: "ex_kind_trigger_on_user_insert", fixture: "triggers/ex_kind_trigger_on_user_insert.json" },
  { kind: "trigger (realtime)", payloadKey: "trigger", name: "ex_kind_trigger_on_message", fixture: "triggers/ex_kind_trigger_on_message.json" },
  { kind: "trigger (workspace)", payloadKey: "trigger", name: "ex_kind_trigger_on_branch_live", fixture: "triggers/ex_kind_trigger_on_branch_live.json" },
  // U4 — task (schedule with a timestamp canonicalized by normalize).
  { kind: "task", payloadKey: "task", name: "ex_kind_nightly_cleanup", fixture: "task/ex_kind_nightly_cleanup.json" },
  // workflow_test — the envelope (active/datasource/docs/tag/run). Captured by
  // authoring the object on a real engine and reading back its exported bundle,
  // which is what pins `active: true` as the default and confirms the kind
  // carries no middleware/history block.
  { kind: "workflow_test", payloadKey: "workflow_test", name: "ex_kind_workflow_test", fixture: "workflow-test/ex_kind_workflow_test.json" },
  // U5 — toolset (mcp server + agent) and the nested-but-top-level-surfaced tool.
  { kind: "toolset (mcp server)", payloadKey: "toolset", name: "ex_kind_mcp_server", fixture: "toolset/ex_kind_mcp_server.json" },
  { kind: "toolset (agent)", payloadKey: "toolset", name: "ex_assistant", fixture: "toolset/ex_assistant.json" },
  { kind: "tool", payloadKey: "tool", name: "ex_kind_search_tool", fixture: "toolset/ex_kind_search_tool.json" },
  // U6 — middleware.
  { kind: "middleware", payloadKey: "middleware", name: "ex_kind_rate_limit", fixture: "middleware/ex_kind_rate_limit.json" },
  // U7 — addon (context is its body; the engine-default query context is normalized away).
  { kind: "addon", payloadKey: "addon", name: "ex_kind_author_addon", fixture: "addon/ex_kind_author_addon.json" },
  // Realtime objects — promoted from schema-derived to engine-captured once the
  // workspace archive began carrying realtime sections. All five matched their
  // schema-derived predecessor exactly on the first capture, so the encoders were
  // already right; what changed is that the goldens are now evidence of that
  // rather than a restatement of it.
  { kind: "realtime server", payloadKey: "realtime_server", name: "ex_kind_chat_server", fixture: "realtime/realtime_server_chat.json" },
  { kind: "channel (static)", payloadKey: "channel", name: "lobby", fixture: "realtime/channel_lobby.json" },
  { kind: "channel (path params)", payloadKey: "channel", name: "rooms/{room_id}", fixture: "realtime/channel_rooms.json" },
  { kind: "message", payloadKey: "message", name: "send", fixture: "realtime/message_send.json" },
  { kind: "message (deliver_to)", payloadKey: "message", name: "typing", fixture: "realtime/message_typing.json" },
];

/**
 * SCHEMA-DERIVED goldens — a weaker oracle, kept in its own table so no reader
 * mistakes one for an engine-persisted fixture.
 *
 * Minted from the encoders rather than captured, so they pin the wire shape against
 * refactors but cannot catch the encoder and the engine disagreeing — compared
 * against the encoder that produced them, they are self-consistent by construction.
 *
 * Down to the two LIFECYCLE TRIGGERS. The five realtime objects were promoted into
 * `KIND_CORPUS` once the workspace archive began carrying realtime sections.
 *
 * These two cannot follow them yet, and the reason is specific rather than a pending
 * chore: `normalize()` deliberately PRESERVES a trigger's guid-string `obj_id`,
 * because that is what proves the trigger points at the right object. The
 * ephemeral-environment capture path re-mints every guid in the engine's own format
 * rather than preserving the md5 SideStep derives, so a golden captured there would
 * pin a guid the compiled side can never produce. Capturing these needs a path that
 * preserves supplied guids.
 *
 * Their `meta` IS engine-verified regardless — it came from a live capture, and that
 * is how the six-group skeleton bug was found.
 */
const SCHEMA_DERIVED_CORPUS: Array<{ kind: string; payloadKey: string; name: string; fixture: string }> = [
  { kind: "trigger (realtime server)", payloadKey: "trigger", name: "ex_kind_trigger_on_chat_connect", fixture: "triggers/ex_kind_trigger_on_chat_connect.json" },
  { kind: "trigger (channel)", payloadKey: "trigger", name: "ex_kind_trigger_on_room_join", fixture: "triggers/ex_kind_trigger_on_room_join.json" },
  { kind: "trigger (channel deliver)", payloadKey: "trigger", name: "ex_kind_trigger_on_room_deliver", fixture: "triggers/ex_kind_trigger_on_room_deliver.json" },
];

describe("conformance corpus — kind objects deep-equal their persisted fixture", () => {
  for (const { kind, payloadKey, name, fixture } of KIND_CORPUS) {
    it(`${kind} (${name}) conforms to its persisted golden`, () => {
      const obj = compiled(payloadKey, name);
      expect(obj, `compiled ${payloadKey} "${name}" not found in export`).toBeDefined();
      expect(normalize(obj)).toEqual(normalize(loadFixture(fixture)));
    });
  }
});

describe("conformance corpus — realtime lifecycle triggers match their SCHEMA-DERIVED golden", () => {
  for (const { kind, payloadKey, name, fixture } of SCHEMA_DERIVED_CORPUS) {
    it(`${kind} (${name}) matches its schema-derived golden`, () => {
      const obj = compiled(payloadKey, name);
      expect(obj, `compiled ${payloadKey} "${name}" not found in export`).toBeDefined();
      expect(normalize(obj)).toEqual(normalize(loadFixture(fixture)));
    });
  }

  it("covers both lifecycle trigger types, with every realtime OBJECT promoted", () => {
    // The guard that makes a forgotten golden fail loudly rather than silently
    // shrinking coverage. Two directions now: the annex must hold nothing but
    // triggers, and the three realtime object kinds must sit in the ENGINE-captured
    // corpus — a change that quietly demoted one back into the annex would
    // otherwise still read as passing coverage.
    const covered = new Set(SCHEMA_DERIVED_CORPUS.map((r) => r.payloadKey));
    expect([...covered].sort()).toEqual(["trigger"]);
    const promoted = new Set(KIND_CORPUS.map((r) => r.payloadKey));
    for (const key of ["realtime_server", "channel", "message"]) {
      expect(promoted.has(key), `${key} must stay engine-captured`).toBe(true);
    }
    const triggerTypes = SCHEMA_DERIVED_CORPUS.filter((r) => r.payloadKey === "trigger").map(
      (r) => (compiled("trigger", r.name) as { obj_type?: string }).obj_type,
    );
    // Two `channel` rows: join (gating) and deliver (gating, per recipient). Their
    // envelopes differ only inside `meta.channel.action`, which is exactly the field
    // a hand-minted golden is most likely to get wrong.
    expect(triggerTypes.sort()).toEqual(["channel", "channel", "realtime_server"]);
  });
});
