/**
 * Structural specials (U10) — the statement surfaces shipped without a persisted
 * golden yet (db bulk/query/transaction/external, call-family tail, ai/cloud,
 * array map/union, comment/placeholder/raw-input/post-process/realtime/auth/
 * expect.to_throw). These assert reachability through `s`, correct stored names,
 * and the key envelope/context shape — to be upgraded to byte-equal deep-equals
 * once fixtures are vendored.
 */
import { describe, it, expect } from "vitest";
import { s } from "../../src/statements/s.js";
import { generated } from "../../src/statements/generated/factories.generated.js";
import { encodeStatement } from "../../src/statements/statement.js";
import { deriveGuid } from "../../src/refs/guid.js";
import { c, col, auth, inp, filter, withFilters } from "../../src/values/value.js";
import { expr } from "../../src/statements/conditional.js";
import { and } from "../../src/statements/special/db-search.js";

const T = { name: "user" };

describe("structural db specials", () => {
  it("db.bulk.* reference the table via context.dbo.id with full input entries", () => {
    const enc = encodeStatement(s.db.bulk.add({ table: T, items: c.array([]), allowIdField: true }));
    expect(enc.name).toBe("mvp:dbo_bulkadd");
    expect((enc.context as { dbo: { id: string } }).dbo.id).toBe(deriveGuid("dbo", T.name));
    expect(enc.output).toEqual({ items: [], filters: [], customize: false });
    expect(enc.input).toEqual([
      { name: "allow_id_field", value: "true", tag: "const:bool", filters: [], ignore: false, expand: false, children: [] },
      { name: "items", value: "[]", tag: "const:array", filters: [], ignore: false, expand: false, children: [] },
    ]);
    expect(s.db.bulk.delete({ table: T }).name).toBe("mvp:dbo_bulkdelete");
    expect(s.db.bulk.patch({ table: T, items: c.array([]) }).name).toBe("mvp:dbo_bulkpatch");
    expect(s.db.bulk.update({ table: T, items: c.array([]) }).name).toBe("mvp:dbo_bulkupdate");
  });

  it("db.bulk.delete encodes the where DSL through context.search (same shape as db.query)", () => {
    // The modern where DSL (expr/cmp/and/or) must produce the operand-based
    // {expression:[…]} search, identical to db.query — not a raw passthrough.
    const enc = encodeStatement(
      s.db.bulk.delete({
        table: T,
        where: and(
          expr(col("chirp"), "=", inp("chirp_id")),
          expr(col("user"), "=", auth("id")),
        ),
        as: "deleted",
      }),
    );
    expect(enc.name).toBe("mvp:dbo_bulkdelete");
    expect((enc.context as { dbo: { id: string } }).dbo.id).toBe(deriveGuid("dbo", T.name));
    // A single top-level and() group folds into one group node in expression[].
    const search = (enc.context as { search: { expression: unknown[] } }).search;
    expect(search.expression).toHaveLength(1);
    expect((search.expression[0] as { type: string }).type).toBe("group");
    const inner = (search.expression[0] as { group: { expression: unknown[] } }).group.expression;
    expect(inner).toHaveLength(2);
    expect((inner[0] as { statement: { op: string } }).statement.op).toBe("=");
  });

  it("db.bulk.delete with no where omits context.search (deletes all rows)", () => {
    const enc = encodeStatement(s.db.bulk.delete({ table: T }));
    expect(enc.context).not.toHaveProperty("search");
  });

  it("db.query (dbo_view) emits filter under context.search + a list return, not the old keys", () => {
    const enc = encodeStatement(s.db.query({ table: T, where: c.text("id > 0") }));
    expect(enc.name).toBe("mvp:dbo_view");
    // Filter rides context.search (raw Value escape hatch passes through) — the
    // engine never reads the old context.where key (issue #41).
    expect(enc.context).toHaveProperty("search");
    expect(enc.context).not.toHaveProperty("where");
    expect(enc.context).not.toHaveProperty("additional_where");
    expect(enc.context).not.toHaveProperty("sort");
    expect(enc.context).not.toHaveProperty("paging");
    expect(enc.context).not.toHaveProperty("output");
    // sort/paging live under context.return.list, always present for a list read.
    expect((enc.context as { return: { type: string } }).return.type).toBe("list");
  });

  it("db.transaction nests an encoded run[] stack", () => {
    const enc = encodeStatement(
      s.db.transaction({ body: [s.db.del({ table: T, fieldValue: c.int(1) })] }),
    );
    expect(enc.name).toBe("mvp:db_transaction");
    expect((enc.context as { run: unknown[] }).run).toHaveLength(1);
  });

  it("db.external.<engine>.direct_query carries code + connection_string_flex", () => {
    const enc = encodeStatement(
      s.db.external.snowflake.direct_query({ sql: "select 1", connectionString: c.text("sf://") }),
    );
    expect(enc.name).toBe("mvp:dbo_external_snowflake_query");
    expect((enc.context as { code: string }).code).toBe("select 1");
    expect((enc.context as { connection_string_flex: unknown }).connection_string_flex).toBeDefined();
  });
});

describe("structural call-family tail", () => {
  it("service.function.run shares mvp:function and resolves the fn guid", () => {
    const enc = encodeStatement(s.service.function.run({ fn: { name: "f" } }));
    expect(enc.name).toBe("mvp:function");
    expect((enc.context as { function: { id: string } }).function.id).toBe(deriveGuid("function", "f"));
  });

  it("action.call / action.package.call / workflow_test.call resolve refs", () => {
    expect(s.action.call({ action: { name: "a" } }).name).toBe("mvp:action");
    expect(s.action.package.call({ action: { name: "a" } }).name).toBe("mvp:action_package");
    const wft = encodeStatement(s.workflow_test.call({ workflowTest: { name: "t" }, datasource: "live" }));
    expect(wft.name).toBe("mvp:workspace_run_workflow_test");
    expect((wft.context as { datasource: string }).datasource).toBe("live");
  });
});

describe("structural ai/cloud specials", () => {
  it("ai.agent.run resolves the agent into context.toolset.id + top-level runtime", () => {
    const enc = encodeStatement(s.ai.agent.run({ agent: { name: "asst" }, runtimeMode: "shared" }));
    expect(enc.name).toBe("mvp:call_agent");
    expect((enc.context as { toolset: { id: unknown } }).toolset.id).toBeDefined();
    expect((enc.runtime as { mode: string }).mode).toBe("shared");
  });

  it("cloud.job statements carry their blocks in input[] (not context)", () => {
    const job = encodeStatement(s.cloud.job({ image: c.text("alpine") }));
    expect(job.name).toBe("mvp:cloud_job");
    expect(job.context).toEqual({});
    expect(job.input).toEqual([
      { name: "image", value: "alpine", tag: "const", filters: [], ignore: false, expand: false, children: [] },
    ]);
    expect(s.cloud.job.await({ ids: c.array([]), timeout: c.int(60) }).name).toBe("mvp:cloud_job_await");
    expect(s.cloud.job.status({ id: c.int(1) }).name).toBe("mvp:cloud_job_status");
  });
});

describe("structural array + misc specials", () => {
  it("array.map stores source as context.collection (+output_type)", () => {
    const enc = encodeStatement(s.array.map({ source: c.array([1]) }));
    expect(enc.name).toBe("mvp:array_map");
    expect((enc.context as { collection: unknown }).collection).toBeDefined();
    expect((enc.context as { output_type: string }).output_type).toBe("value");
  });

  it("array.union stores source as context.left, with as context.right", () => {
    const enc = encodeStatement(s.array.union({ source: c.array([1]), with: c.array([2]) }));
    expect(enc.name).toBe("mvp:array_union");
    expect((enc.context as { left: unknown }).left).toBeDefined();
    expect((enc.context as { right: unknown }).right).toBeDefined();
  });

  it("comment and placeholder are reachable", () => {
    expect(encodeStatement(s.comment("note")).description).toBe("note");
    expect((encodeStatement(s.placeholder("todo")).context as { name: string }).name).toBe("todo");
  });

  it("util.get_input and util.get_raw_input share mvp:get_input", () => {
    expect(s.util.get_input().name).toBe("mvp:get_input");
    expect(s.util.get_raw_input().name).toBe("mvp:get_input");
  });

  it("realtime_event nests auth.dbo_id (table guid) + auth.row_id", () => {
    const enc = encodeStatement(
      s.api.realtime_event({ channel: c.text("c"), data: c.obj({}), authTable: T, authId: c.int(1) }),
    );
    expect(enc.name).toBe("mvp:realtime_event");
    const auth = (enc.context as { auth: { dbo_id: string; row_id: unknown } }).auth;
    expect(auth.dbo_id).toBe(deriveGuid("dbo", T.name));
    expect(auth.row_id).toBeDefined();
  });

  // `realtime.publish` — the CURRENT-layer send statement. Its `server` crosses no
  // reference boundary (the engine resolves it by NAME, not guid) while `authTable`
  // does, and every optional key must stay absent when unset.
  it("realtime.publish emits the server NAME, not its guid", () => {
    const enc = encodeStatement(
      s.realtime.publish({ server: { name: "chat" }, channel: c.text("rooms/42"), data: c.obj({}) }),
    );
    expect(enc.name).toBe("mvp:realtime_publish");
    const ctx = enc.context as { realtime_server: { value: string; tag: string } };
    expect(ctx.realtime_server).toEqual({ value: "chat", tag: "const", filters: [] });
    expect(ctx.realtime_server.value).not.toBe(deriveGuid("realtime_server", "chat"));
  });

  it("realtime.publish accepts a bare server name and a computed one identically", () => {
    const fromName = encodeStatement(
      s.realtime.publish({ server: "chat", channel: c.text("lobby"), data: c.obj({}) }),
    ).context as Record<string, unknown>;
    const fromHandle = encodeStatement(
      s.realtime.publish({ server: { name: "chat" }, channel: c.text("lobby"), data: c.obj({}) }),
    ).context as Record<string, unknown>;
    expect(fromName).toEqual(fromHandle);

    const computed = encodeStatement(
      s.realtime.publish({ server: inp("server_name"), channel: c.text("lobby"), data: c.obj({}) }),
    ).context as { realtime_server: { value: string; tag: string } };
    expect(computed.realtime_server.tag).toBe("input");
    expect(computed.realtime_server.value).toBe("server_name");
  });

  it("realtime.publish omits message and auth entirely when unset", () => {
    const enc = encodeStatement(
      s.realtime.publish({ server: "chat", channel: c.text("lobby"), data: c.obj({ a: 1 }) }),
    );
    expect(Object.keys(enc.context as object).sort()).toEqual(["channel", "data", "realtime_server"]);
  });

  it("realtime.publish resolves authTable to a table guid and keeps row_id separate", () => {
    const enc = encodeStatement(
      s.realtime.publish({
        server: "chat",
        channel: c.text("lobby"),
        data: c.obj({}),
        message: c.text("post"),
        authTable: T,
        authId: c.int(7),
      }),
    );
    const ctx = enc.context as { message: { value: string }; auth: { dbo_id: string; row_id: { value: string } } };
    expect(ctx.message.value).toBe("post");
    expect(ctx.auth.dbo_id).toBe(deriveGuid("dbo", T.name));
    expect(ctx.auth.row_id.value).toBe("7");
  });

  it("realtime.publish writes an auth block with only the half that was supplied", () => {
    const idOnly = encodeStatement(
      s.realtime.publish({ server: "chat", channel: c.text("lobby"), data: c.obj({}), authId: c.int(7) }),
    ).context as { auth: Record<string, unknown> };
    expect(Object.keys(idOnly.auth)).toEqual(["row_id"]);

    const tableOnly = encodeStatement(
      s.realtime.publish({ server: "chat", channel: c.text("lobby"), data: c.obj({}), authTable: T }),
    ).context as { auth: Record<string, unknown> };
    expect(Object.keys(tableOnly.auth)).toEqual(["dbo_id"]);
  });

  it("realtime.publish preserves a filter chain on data", () => {
    const enc = encodeStatement(
      s.realtime.publish({
        server: "chat",
        channel: c.text("lobby"),
        data: withFilters(c.text('{"a":1}'), [filter("json_decode")]),
      }),
    );
    expect((enc.context as { data: { filters: unknown[] } }).data.filters).toHaveLength(1);
  });

  // The engine is FAIL-SOFT: a bad publish logs server-side and returns, so the author
  // never sees it. These two references are the only loud failure available to the SDK.
  it("realtime.publish throws when the server is missing or blank", () => {
    expect(() => s.realtime.publish({ server: "", channel: c.text("lobby"), data: c.obj({}) })).toThrow(/server/);
    expect(() =>
      s.realtime.publish({ server: undefined as never, channel: c.text("lobby"), data: c.obj({}) }),
    ).toThrow(/server/);
  });

  it("realtime.publish throws when the channel is missing or blank", () => {
    expect(() => s.realtime.publish({ server: "chat", channel: c.text(""), data: c.obj({}) })).toThrow(/channel/);
    expect(() => s.realtime.publish({ server: "chat", channel: undefined as never, data: c.obj({}) })).toThrow(
      /channel/,
    );
  });

  it("create_auth_token puts the table guid in the dbtable input entry", () => {
    const enc = encodeStatement(
      s.security.create_auth_token({ table: T, id: c.int(1), extras: c.obj({}), expiration: c.int(3600) }),
    );
    expect(enc.name).toBe("mvp:create_auth");
    const dbtable = (enc.input as Array<{ name: string; value: string }>).find((e) => e.name === "dbtable");
    expect(dbtable?.value).toBe(deriveGuid("dbo", T.name));
  });

  it("expect.to_throw nests the run[] stack", () => {
    const enc = encodeStatement(s.expect.to_throw({ body: [s.return(c.null())] }));
    expect(enc.name).toBe("mvp:test_expect_to_throw");
    expect((enc.context as { run: unknown[] }).run).toHaveLength(1);
  });

  // Issue #21: the typed `precondition`/`throw` overrides must delegate to the
  // generated factories byte-for-byte — they only narrow/annotate the arg types.
  it("precondition encodes with a status-bearing error_type (delegates to the generated factory)", () => {
    const enc = encodeStatement(
      s.precondition({ error_type: "badrequest", error: c.text("url must start with http://") }),
    );
    expect(enc.name).toBe("mvp:precondition");
    const raw = encodeStatement(
      generated.precondition({ error_type: "badrequest", error: c.text("url must start with http://") }),
    );
    expect(enc).toEqual(raw);
  });

  it("throw override encodes identically to the generated factory", () => {
    const enc = encodeStatement(s.throw({ value: c.text("boom") }));
    expect(enc.name).toBe("mvp:throw_error");
    expect(enc).toEqual(encodeStatement(generated.throw({ value: c.text("boom") })));
  });
});
