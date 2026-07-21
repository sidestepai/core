import { describe, it, expect } from "vitest";
import "../../src/index.js"; // load all kind + statement registrations
import { computeCoverage, formatCoverage, IMPLEMENTED_KINDS, IMPLEMENTED_STATEMENTS, TOTAL_STATEMENTS } from "./coverage.js";
import { normalize, loadFixture } from "./harness.js";
import { encodeStatement, getStatementFactory } from "../../src/statements/statement.js";
import type { Authored } from "../../src/statements/schema-dsl/interpret.js";
import { mathAdd, bitwiseAnd, objectKeys, objectValues } from "../../src/statements/generated/catalog.js";
import { returnValue, die, debugLog, foreachBreak } from "../../src/statements/special/control-flow.js";
import { forLoop, foreachLoop } from "../../src/statements/special/loops.js";
import { setVar } from "../../src/statements/set-var.js";
import { c, inp, filter, withFilters } from "../../src/values/value.js";

/** Build a generated statement by name (for families without an ergonomic factory). */
const stmt = (name: string, authored: Authored) => encodeStatement(getStatementFactory(name)(authored));
const objArg = () =>
  withFilters(c.text('{"first_name":"first","last_name":"last"}'), [filter("json_decode")]);

/**
 * Centralized statement conformance table: fixture → authoring expression.
 * (set_var conformance is proven by the function golden test against the real
 * schema:function fixture; the standalone transform-temp/mvp:set_var artifact
 * carries test-harness fields and is intentionally not used here.)
 *
 * @TODO(byte-verify): PERSISTED goldens that EXIST in the corpus but are NOT yet
 *   wired into this table — the debug-loop worklist. Source dir:
 *   cloud-client/extensions/MVP/includes/xano/test/script/data/transform-temp/mvp:<name>.json
 *   Each needs: vendor the json into test/fixtures/statements/ + add a {fixture,build}
 *   row here with the right authoring args (read the golden for inputs).
 *
 *   Declarative (generated factory exists — should be quick, mirror bitwise_and):
 *     bitwise_or, bitwise_xor, array_every, array_merge, object_entries,
 *     object_values-array, return-null-text, conditional, sleep, get_record,
 *     generate_pass, check_pass, algolia_request, csv_stream,
 *     crypto_jwe_decode2, crypto_jws_decode2, crypto_jws_encode2,
 *     create_image, create_video, create_audio, create_attachment,
 *     create_file_resource, create_var_from_file_resource, vault_sign_url,
 *     zip_add/create/delete/extract/view_*_file_resource (5),
 *     direct_query, direct_query-arg, foreach_continue, foreach_remove.
 *   Each promotion either passes (great) or exposes a real encoder bug to fix —
 *   that's the debug loop. Wiring these is the single highest-leverage next step.
 */
const STATEMENT_CORPUS: Array<{ fixture: string; build: () => unknown }> = [
  { fixture: "math_add", build: () => encodeStatement(mathAdd("x1", c.int(1))) },
  { fixture: "bitwise_and", build: () => encodeStatement(bitwiseAnd("x9", c.int(123))) },
  { fixture: "object_keys", build: () => encodeStatement(objectKeys("x2", objArg())) },
  { fixture: "object_values", build: () => encodeStatement(objectValues("x2", objArg())) },
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
        headers: { value: "", tag: "const:obj", filters: [] },
        claims: { value: "", tag: "const:obj", filters: [] },
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
          list: withFilters(c.text("[1,2,3]"), [filter("json_decode")]),
          body: [setVar("x2", c.int(123))],
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
