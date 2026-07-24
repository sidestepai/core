import { describe, it, expect } from "vitest";
import "../../src/index.js"; // load all kind + statement registrations
import { computeCoverage, formatCoverage, IMPLEMENTED_KINDS, IMPLEMENTED_STATEMENTS, TOTAL_STATEMENTS } from "./coverage.js";
import { normalize, loadFixture } from "./harness.js";
import { encodeStatement, getStatementFactory } from "../../src/statements/statement.js";
import type { Authored } from "../../src/statements/schema-dsl/interpret.js";
import { mathAdd, bitwiseAnd, bitwiseOr, bitwiseXor, objectKeys, objectValues, objectEntries } from "../../src/statements/generated/catalog.js";
import { returnValue, die, debugLog, foreachBreak, foreachContinue, foreachRemove } from "../../src/statements/special/control-flow.js";
import { forLoop, foreachLoop, whileLoop, group } from "../../src/statements/special/loops.js";
import { setVar } from "../../src/statements/set-var.js";
import { expr, conditional } from "../../src/statements/conditional.js";
import { arrayMap, arrayUnion, getRawInput, expectToThrow } from "../../src/statements/special/misc.js";
import { aiAgentRun, cloudJob, cloudJobAwait, cloudJobStatus } from "../../src/statements/special/ai-cloud.js";
import {
  dbBulkAdd,
  dbBulkPatch,
  dbBulkUpdate,
  dbBulkDelete,
  dbExternalQuery,
} from "../../src/statements/special/db.js";
import { apiCall } from "../../src/statements/special/calls.js";
import { agent, table, f, query, apiGroup, input } from "../../src/index.js";
import { obj } from "../../src/values/obj.js";
import { c, inp, ref, col, filter, withFilters } from "../../src/values/value.js";

/** Table def reused by the bulk rows — its dbo guid derives from `name`. */
const capUsers = table({ name: "cap_users", schema: { name: f.text({}) } });
const capRows = () =>
  withFilters(c.text('[{"name":"a"},{"name":"b"}]'), [filter("json_decode")]);

/** Query target reused by the api_call row — api.call resolves it to context.id. */
const capApiTarget = query({
  name: "cap_target",
  verb: "GET",
  apiGroup: apiGroup({ name: "cap_grp", canonical: "cap-grp" }),
  input: { q: input.text({ required: false }) },
});

/** Agent def reused by the call_agent row — its toolset guid derives from `canonical`. */
const capAssistant = agent({
  name: "cap_assistant",
  canonical: "cap-assistant-agent",
  llm: {
    type: "xano-free",
    systemPrompt: "You are helpful.",
    prompt: "Answer: {{ $args.question }}",
    maxSteps: 5,
  },
});

/** Build a generated statement by name (for families without an ergonomic factory). */
const stmt = (name: string, authored: Authored) => encodeStatement(getStatementFactory(name)(authored));
const objArg = () =>
  withFilters(c.text('{"first_name":"first","last_name":"last"}'), [filter("json_decode")]);
/** A decoded `[1,2,3]` array value — shared by the array_merge/map/union rows. */
const intArr = () => withFilters(c.text("[1,2,3]"), [filter("json_decode")]);
/** The "unset object" tagged value (`const:obj` with empty string) — no c.* constructor emits this form. */
const emptyObj = () => ({ value: "", tag: "const:obj", filters: [] });

/**
 * Centralized statement conformance table: fixture → authoring expression.
 * (set_var conformance is proven by the function golden test against the real
 * schema:function fixture; the standalone transform-temp/mvp:set_var artifact
 * carries test-harness fields and is intentionally not used here.)
 *
 * NOTE: the 22 "vendored-but-unwired" statement fixtures the worklist once
 * flagged (db_*, switch, try_catch, function_run, post_process, array_find,
 * update_var, db_view_*) are NOT re-wired here — each is already byte-verified in
 * its domain suite (db.test.ts, branch.test.ts, db-query-shape.test.ts,
 * calls.test.ts, substacks.test.ts, set-var.test.ts, generated.test.ts). This
 * central corpus is for the generic declaratives that lack a domain-test home.
 *
 * @TODO(byte-verify): the debug-loop worklist. Source dir:
 *   cloud-client/extensions/MVP/includes/xano/test/script/data/transform-temp/mvp:<name>.json
 *   Each needs: vendor the json into test/fixtures/statements/ + add a {fixture,build}
 *   row here with the right authoring args (read the golden for inputs).
 *
 *   DONE — vendored from source (wired below): bitwise_or, bitwise_xor,
 *     array_merge, object_entries, sleep, foreach_continue, foreach_remove,
 *     create_image, create_video, create_audio, create_attachment,
 *     create_file_resource, csv_stream, crypto_jwe_decode2, crypto_jws_decode2,
 *     crypto_jws_encode2, generate_pass, check_pass, vault_sign_url, algolia_request.
 *
 *   DONE — live-captured via `sidestep validate --capture` (wired below): while,
 *     group, conditional, array_map, array_union, get_input, test_expect_to_throw,
 *     call_agent, cloud_job, cloud_job_await, cloud_job_status, db_bulk_add,
 *     db_bulk_patch, db_bulk_update, db_bulk_delete, db_external_query, api_call.
 *     (The openai agent_settings golden is asserted in test/kinds/agent.test.ts.)
 *
 *   REDUNDANT (golden is an already-tested stored name — skip): get_record and
 *     direct_query/direct_query-arg vendor as mvp:dbo_getby / mvp:dbo_direct_query,
 *     already covered by db_get / db_direct_query in db.test.ts.
 *
 *   STILL OPEN:
 *   - zip_{add,create,delete,extract,view}_file_resource, create_var_from_file_resource
 *     — the source goldens are degenerate (empty context while the spec needs
 *     non-optional fields); capture non-trivial authorings before wiring.
 *   - array_every / object_values-array / return-null-text — share array_find's
 *     numeric inline-array-filter-arg value-layer gap (generated.test.ts asserts
 *     only the compare slice).
 *   - f.tableRef — DONE. The persisted TABLE-object readback is captured and
 *     byte-verified whole-object in test/conformance/kinds-corpus.test.ts
 *     (fixture tables/ex_field_table_ref.json), alongside every other authored
 *     kind (query/trigger/task/toolset/tool/middleware/addon). See that file
 *     and src/validate/kinds.ts.
 *   - action / action_package — EXCLUDED: need an action-identity model first.
 */
const STATEMENT_CORPUS: Array<{ fixture: string; build: () => unknown }> = [
  { fixture: "math_add", build: () => encodeStatement(mathAdd("x1", c.int(1))) },
  { fixture: "bitwise_and", build: () => encodeStatement(bitwiseAnd("x9", c.int(123))) },
  { fixture: "object_keys", build: () => encodeStatement(objectKeys("x2", objArg())) },
  { fixture: "object_values", build: () => encodeStatement(objectValues("x2", objArg())) },
  { fixture: "object_entries", build: () => encodeStatement(objectEntries("x2", objArg())) },
  // Value-spread mutations (mirror bitwise_and): name + context-spread value.
  { fixture: "bitwise_or", build: () => encodeStatement(bitwiseOr("x9", c.int(123))) },
  { fixture: "bitwise_xor", build: () => encodeStatement(bitwiseXor("x9", c.int(123))) },
  {
    fixture: "array_merge",
    build: () =>
      stmt("mvp:array_merge", {
        name: "crypto1",
        value: intArr(),
      }),
  },
  { fixture: "sleep", build: () => stmt("mvp:sleep", { value: c.int(60) }) },
  // File-resource creators (value-spread source + access + nested filename).
  {
    fixture: "create_image",
    build: () => stmt("mvp:create_image", { as: "x4", value: inp("file"), filename: c.text("") }),
  },
  {
    fixture: "create_video",
    build: () => stmt("mvp:create_video", { as: "x4", value: inp("file"), filename: c.text("") }),
  },
  {
    fixture: "create_audio",
    build: () => stmt("mvp:create_audio", { as: "x4", value: inp("file"), filename: c.text("") }),
  },
  {
    fixture: "create_attachment",
    build: () =>
      stmt("mvp:create_attachment", { as: "x4", value: inp("file"), filename: c.text("") }),
  },
  {
    fixture: "create_file_resource",
    build: () =>
      stmt("mvp:create_file_resource", {
        as: "ret",
        filename: c.text("abc.txt"),
        filedata: c.text("abc123"),
      }),
  },
  // CSV stream: var source spread into context + full input trio (separator/enclosure/escape).
  {
    fixture: "csv_stream",
    build: () =>
      stmt("mvp:csv_stream", {
        as: "stream1",
        value: ref("test1"),
        separator: c.text(","),
        enclosure: c.text('"'),
        escape_char: c.text('"'),
      }),
  },
  // Crypto JWE/JWS decode + JWS encode (input-target trio; siblings of crypto_jwe_encode3).
  {
    fixture: "crypto_jwe_decode2",
    build: () =>
      stmt("mvp:crypto_jwe_decode2", {
        as: "crypto5",
        token: c.text(""),
        key: c.text(""),
        check_claims: emptyObj(),
        key_algorithm: c.text("A256KW"),
        content_algorithm: c.text("A256CBC-HS512"),
        timeDrift: c.int(0),
      }),
  },
  {
    fixture: "crypto_jws_decode2",
    build: () =>
      stmt("mvp:crypto_jws_decode2", {
        as: "crypto7",
        token: c.text(""),
        key: c.text(""),
        check_claims: emptyObj(),
        signature_algorithm: c.text("HS256"),
        timeDrift: c.int(0),
      }),
  },
  {
    fixture: "crypto_jws_encode2",
    build: () =>
      stmt("mvp:crypto_jws_encode2", {
        as: "crypto6",
        headers: emptyObj(),
        claims: emptyObj(),
        key: c.text(""),
        signature_algorithm: c.text("HS256"),
        ttl: c.int(0),
      }),
  },
  // Password generate/check + vault URL signing (input-target).
  {
    fixture: "generate_pass",
    build: () =>
      stmt("mvp:generate_pass", {
        as: "x3",
        character_count: c.int(12),
        require_lowercase: c.bool(true),
        require_uppercase: c.bool(true),
        require_digit: c.bool(true),
        require_symbol: c.bool(false),
        symbol_whitelist: c.text(""),
      }),
  },
  {
    fixture: "check_pass",
    build: () =>
      stmt("mvp:check_pass", { as: "x1", text_password: ref("test1"), hash_password: ref("stream1") }),
  },
  {
    fixture: "vault_sign_url",
    build: () => stmt("mvp:vault_sign_url", { as: "x5", pathname: c.text(""), ttl: c.int(30) }),
  },
  {
    fixture: "algolia_request",
    build: () =>
      stmt("mvp:algolia_request", {
        as: "ret",
        application_id: c.text("abc123"),
        api_key: c.text("MY_KEY"),
        url: c.text("https://test.com"),
        method: c.text("POST"),
        payload: withFilters(
          { value: "{}", tag: "const:obj", filters: [] },
          [filter("set", c.text("q"), c.text("abc"))],
        ),
      }),
  },
  // Foreach body control-flow signals (no context, no output) — siblings of foreach_break.
  { fixture: "foreach_continue", build: () => encodeStatement(foreachContinue()) },
  { fixture: "foreach_remove", build: () => encodeStatement(foreachRemove()) },
  // Generated declarative families proven byte-exact (U9): value-spread + output,
  // the as/no-as default-emission split, and a no-output statement.
  { fixture: "array_push", build: () => stmt("mvp:array_push", { name: "x1", value: c.int(123) }) },
  { fixture: "array_pop", build: () => stmt("mvp:array_pop", { name: "mylist", as: "test" }) },
  { fixture: "array_pop-no-as", build: () => stmt("mvp:array_pop", { name: "mylist" }) },
  { fixture: "uuid4", build: () => stmt("mvp:uuid4", { as: "x5" }) },
  // Input-target statements proven byte-exact (field-type/envelope unit):
  // rich envelope + full input entry (delete_file), medium envelope + lean
  // input entries (lambda), and numeric int coercion in input entries (crypto ttl).
  { fixture: "delete_file", build: () => stmt("mvp:delete_file", { pathname: c.text("abc") }) },
  // External API Request: proves the object/array/bool/int input-tag split
  // (params→const:obj, headers→const:array, verify/follow→const:bool,
  // timeout→const:int) and the authored `description` envelope key (U2).
  {
    fixture: "api_request",
    build: () =>
      stmt("mvp:api_request", {
        as: "api1",
        url: c.text("https://www.xano.com"),
        method: c.text("GET"),
        params: c.obj({}),
        headers: c.array([]),
        timeout: c.int(10),
        follow_location: c.bool(true),
        verify_host: c.bool(true),
        verify_peer: c.bool(true),
        ca_certificate: c.text(""),
        certificate: c.text(""),
        certificate_pass: c.text(""),
        private_key: c.text(""),
        private_key_pass: c.text(""),
        description: "this is a test",
      }),
  },
  {
    fixture: "lambda",
    build: () => stmt("mvp:lambda", { as: "x1", code: c.text(""), timeout: c.int(10) }),
  },
  {
    fixture: "crypto_jwe_encode3",
    build: () =>
      stmt("mvp:crypto_jwe_encode3", {
        as: "crypto4",
        headers: emptyObj(),
        claims: emptyObj(),
        key: c.text(""),
        key_algorithm: c.text("A256KW"),
        content_algorithm: c.text("A256CBC-HS512"),
        ttl: c.int(0),
      }),
  },
  // Control-flow block specials (U10): nested run[] stacks, lean envelope.
  {
    fixture: "for",
    build: () =>
      encodeStatement(forLoop({ as: "index", count: c.int(10), body: [setVar("x3", inp("email"))] })),
  },
  {
    fixture: "foreach",
    build: () =>
      encodeStatement(
        foreachLoop({
          as: "item",
          list: intArr(),
          body: [setVar("x2", c.int(123))],
        }),
      ),
  },
  // Block-body loops proven byte-exact against live captures (U4): while carries a
  // comparison `expr` + nested run[]; group is a bare `{run}` envelope.
  {
    fixture: "while",
    build: () =>
      encodeStatement(whileLoop({ when: expr(ref("x1"), "<", c.int(10)), body: [setVar("x1", c.int(1))] })),
  },
  { fixture: "group", build: () => encodeStatement(group([setVar("x2", c.int(2))])) },
  // conditional with an elif chain + else, proven byte-exact against a live
  // capture (unified-expression-parity plan): the engine always persists
  // `context.elif:{run:[…conditional_elif…]}`, each elif a `{expr, if:{run}}` leaf.
  {
    fixture: "conditional",
    build: () =>
      encodeStatement(
        conditional({
          when: expr(ref("n"), ">", c.int(10)),
          then: [setVar("bucket", c.text("high"))],
          elif: [
            { when: expr(ref("n"), ">", c.int(3)), then: [setVar("bucket", c.text("mid"))] },
            { when: expr(ref("n"), ">", c.int(0)), then: [setVar("bucket", c.text("low"))] },
          ],
          else: [setVar("bucket", c.text("none"))],
        }),
      ),
  },
  // `!class` misc specials proven byte-exact against live captures (U5): the
  // array map/union field remaps (collection/transform_value; left/right),
  // get_input's default input pair, and expect.to_throw's nested run[].
  {
    fixture: "array_map",
    build: () =>
      encodeStatement(
        arrayMap({
          source: intArr(),
          as: "x1",
          transform: ref("$this"),
        }),
      ),
  },
  {
    fixture: "array_union",
    build: () =>
      encodeStatement(
        arrayUnion({
          source: intArr(),
          with: intArr(),
          as: "x2",
        }),
      ),
  },
  { fixture: "get_input", build: () => encodeStatement(getRawInput({ as: "x3" })) },
  {
    fixture: "test_expect_to_throw",
    build: () => encodeStatement(expectToThrow({ body: [setVar("x4", c.int(1))] })),
  },
  // AI agent run + cloud jobs proven byte-exact against live captures (U6).
  // call_agent doubles as the obj() rendered-string proof: its object-literal
  // `args` render into a `const:expr` value the golden pins.
  {
    fixture: "call_agent",
    build: () =>
      encodeStatement(
        aiAgentRun({ agent: capAssistant, args: obj({ question: inp("question") }), as: "answer" }),
      ),
  },
  {
    fixture: "cloud_job",
    build: () =>
      encodeStatement(cloudJob({ image: c.text("alpine"), command: c.text("echo hi"), await: c.int(60) })),
  },
  {
    fixture: "cloud_job_await",
    build: () => encodeStatement(cloudJobAwait({ ids: ref("job"), timeout: c.int(30) })),
  },
  { fixture: "cloud_job_status", build: () => encodeStatement(cloudJobStatus({ id: ref("job") })) },
  // DB bulk ops + external SQL proven byte-exact against live captures (U7):
  // context.dbo.id + lean input[items]; bulk.delete's context.search; external
  // query's {code,response_type,connection_string_flex,arg} with NO context.parser.
  {
    fixture: "db_bulk_add",
    build: () => encodeStatement(dbBulkAdd({ table: capUsers, items: capRows(), as: "r1" })),
  },
  {
    fixture: "db_bulk_patch",
    build: () => encodeStatement(dbBulkPatch({ table: capUsers, items: capRows(), as: "r2" })),
  },
  {
    fixture: "db_bulk_update",
    build: () => encodeStatement(dbBulkUpdate({ table: capUsers, items: capRows(), as: "r3" })),
  },
  {
    fixture: "db_bulk_delete",
    build: () =>
      encodeStatement(
        dbBulkDelete({ table: capUsers, where: expr(col("name"), "=", c.text("x")), as: "r4" }),
      ),
  },
  {
    fixture: "db_external_query",
    build: () =>
      encodeStatement(
        dbExternalQuery({
          engine: "postgres",
          connectionString: c.text("postgres://localhost/db"),
          sql: "SELECT 1",
          responseType: "list",
        }),
      ),
  },
  // api.call proven byte-exact against a live capture (U9): context.token is a
  // TAGGED {value,tag,filters} value (not a bare scalar), + token_ignore_expiration.
  {
    fixture: "api_call",
    build: () =>
      encodeStatement(
        apiCall({
          api: capApiTarget,
          auth: { token: c.text("mytoken"), ignoreExpiration: true },
          as: "resp",
        }),
      ),
  },
  { fixture: "return-null", build: () => encodeStatement(returnValue(c.null())) },
  { fixture: "die", build: () => encodeStatement(die(c.int(123))) },
  { fixture: "debug_log", build: () => encodeStatement(debugLog(c.int(123))) },
  { fixture: "foreach_break", build: () => encodeStatement(foreachBreak()) },
];

describe("conformance corpus — statement fixtures deep-equal", () => {
  for (const { fixture, build } of STATEMENT_CORPUS) {
    it(`${fixture} conforms to its persisted fixture`, () => {
      expect(normalize(build())).toEqual(normalize(loadFixture(`statements/${fixture}.json`)));
    });
  }
});

describe("coverage report (1:1 measured, not asserted)", () => {
  it("every implemented kind and statement is actually registered", () => {
    const r = computeCoverage();
    console.log("\nsidestep coverage:\n" + formatCoverage(r) + "\n");
    expect(r.kinds.missing).toEqual([]);
    expect(r.statements.missing).toEqual([]);
  });

  it("meets the current implementation floor", () => {
    const r = computeCoverage();
    expect(r.kinds.implemented).toBe(IMPLEMENTED_KINDS.length);
    expect(r.statements.implemented).toBe(IMPLEMENTED_STATEMENTS.length);
    expect(r.kinds.implemented).toBeGreaterThanOrEqual(11);
    expect(r.statements.implemented).toBe(TOTAL_STATEMENTS); // all 214 surfaces reachable
  });
});
