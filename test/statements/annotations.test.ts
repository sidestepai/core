/**
 * `disabled` + `description` on every statement.
 *
 * They are stack-item annotations rather than statement arguments — `disabled`
 * is Xano's "disable step" (the step stays in the stack; the run engine skips
 * it) and `description` is the note shown beside it. The engine writes both on
 * essentially every stored statement, so every factory has to accept them: it
 * used to be that only a handful declared `description` and none declared
 * `disabled`, and authoring either meant spreading over a built statement.
 *
 * The generated arm is exhaustive BY CONSTRUCTION: arguments are derived from
 * each spec's own rules, so a statement added to the catalog later is covered
 * the day it lands rather than the day someone remembers to list it here.
 */
import { describe, it, expect } from "vitest";
import "../../src/index.js";
import { GENERATED_SPECS } from "../../src/statements/generated/specs.generated.js";
import { getStatementFactory, encodeStatement } from "../../src/statements/statement.js";
import { encodeFromSpec } from "../../src/statements/schema-dsl/interpret.js";
import type { Statement } from "../../src/statements/statement.js";
import { s } from "../../src/statements/s.js";
import { c, col, inp } from "../../src/values/value.js";
import { expr } from "../../src/statements/expression.js";
import { die, debugLog } from "../../src/statements/special/control-flow.js";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";

const NOTE = "why this step exists";

/** Arguments satisfying a spec's declared rules — enough to build, nothing more. */
function argsFor(spec: (typeof GENERATED_SPECS)[number]): Record<string, unknown> {
  const a: Record<string, unknown> = {};
  for (const rule of spec.rules) {
    if (rule.optional || rule.default !== undefined) continue;
    a[rule.field] =
      rule.type === "string"
        ? "x"
        : rule.type === "comparison"
          ? expr(c.text("a"), "=", c.text("a"))
          : // An enum-constrained field only accepts one of its declared members.
            c.text(rule.enum ? rule.enum[0]! : "x");
  }
  return a;
}

/** The two members as the engine stores them, read back off the encoded envelope. */
function encoded(stmt: Statement): { disabled: unknown; description: unknown } {
  const e = encodeStatement(stmt) as unknown as Record<string, unknown>;
  return { disabled: e.disabled, description: e.description };
}

describe("statement annotations — generated catalog", () => {
  it("every generated statement honours `disabled` and `description`", () => {
    const dropped: string[] = [];
    for (const spec of GENERATED_SPECS) {
      const stmt = encodeFromSpec(spec, { ...argsFor(spec), disabled: true, description: NOTE });
      const e = encoded(stmt);
      if (e.disabled !== true || e.description !== NOTE) dropped.push(spec.name);
    }
    expect(dropped, `statements that dropped an annotation: ${dropped.join(", ")}`).toEqual([]);
  });

  it("covers the whole catalog, so this cannot silently stop testing anything", () => {
    expect(GENERATED_SPECS.length).toBeGreaterThan(150);
  });

  it("omitting them leaves the engine defaults", () => {
    const stmt = getStatementFactory("mvp:redis_keys")({ search: c.text("*") });
    expect(encoded(stmt)).toEqual({ disabled: false, description: "" });
  });
});

const users = table({ name: "user", schema: { id: f.int(), name: f.text() } });

/**
 * The hand-authored specials, which the generated arm cannot reach. Positional
 * factories take a trailing options argument; object-arg ones take the two
 * members inline.
 */
const SPECIALS: Array<[string, () => Statement]> = [
  ["set_var", () => s.set_var("v", c.text("x"), { disabled: true, description: NOTE })],
  ["update_var", () => s.update_var("v", c.text("x"), { disabled: true, description: NOTE })],
  ["return", () => s.return(c.text("x"), { disabled: true, description: NOTE })],
  // `mvp:die` / `mvp:debug_log` are authored through the generated namespace;
  // the positional hand-authored pair is the DECODE surface for the same names.
  ["debug.stop", () => s.debug.stop({ value: c.text("x"), disabled: true, description: NOTE })],
  ["debug.log", () => s.debug.log({ value: c.text("x"), disabled: true, description: NOTE })],
  ["die (positional)", () => die(c.text("x"), { disabled: true, description: NOTE })],
  ["debugLog (positional)", () => debugLog(c.text("x"), { disabled: true, description: NOTE })],
  ["foreach_break", () => s.foreach_break({ disabled: true, description: NOTE })],
  ["foreach_continue", () => s.foreach_continue({ disabled: true, description: NOTE })],
  ["foreach_remove", () => s.foreach_remove({ disabled: true, description: NOTE })],
  ["comment", () => s.comment("hi", { disabled: true, description: NOTE })],
  ["placeholder", () => s.placeholder("todo", { disabled: true, description: NOTE })],
  [
    "conditional",
    () =>
      s.conditional({
        when: expr(c.text("a"), "=", c.text("a")),
        then: [],
        else: [],
        disabled: true,
        description: NOTE,
      }),
  ],
  [
    "foreach",
    () => s.foreach({ list: c.text("x"), as: "row", body: [], disabled: true, description: NOTE }),
  ],
  [
    "for",
    () => s.for({ as: "i", count: c.int(1), body: [], disabled: true, description: NOTE }),
  ],
  [
    "while",
    () =>
      s.while({
        when: expr(c.text("a"), "=", c.text("a")),
        body: [],
        disabled: true,
        description: NOTE,
      }),
  ],
  ["group", () => s.group([], { disabled: true, description: NOTE })],
  [
    "try_catch",
    () => s.try_catch({ try: [], catch: [], finally: [], disabled: true, description: NOTE }),
  ],
  [
    "precondition",
    () =>
      s.precondition({
        expr: expr(c.text("a"), "=", c.text("a")),
        disabled: true,
        description: NOTE,
      }),
  ],
  ["throw", () => s.throw({ value: c.text("x"), disabled: true, description: NOTE })],
  [
    "api.request",
    () => s.api.request({ url: "https://x.test", disabled: true, description: NOTE }),
  ],
  [
    "db.query",
    () => s.db.query({ table: users, as: "rows", disabled: true, description: NOTE }),
  ],
  [
    "db.get",
    () =>
      s.db.get({
        table: users,
        fieldValue: inp("id"),
        as: "row",
        disabled: true,
        description: NOTE,
      }),
  ],
  [
    "db.add",
    () =>
      s.db.add({
        table: users,
        data: [{ name: "name", value: c.text("n") }],
        disabled: true,
        description: NOTE,
      }),
  ],
  [
    "db.edit",
    () =>
      s.db.edit({
        table: users,
        fieldValue: inp("id"),
        data: [{ name: "name", value: c.text("n") }],
        disabled: true,
        description: NOTE,
      }),
  ],
  [
    "db.has",
    () => s.db.has({ table: users, fieldValue: inp("id"), disabled: true, description: NOTE }),
  ],
  [
    "db.del",
    () => s.db.del({ table: users, fieldValue: inp("id"), disabled: true, description: NOTE }),
  ],
  [
    "db.add_or_edit",
    () =>
      s.db.add_or_edit({
        table: users,
        fieldValue: inp("id"),
        data: [{ name: "name", value: c.text("n") }],
        disabled: true,
        description: NOTE,
      }),
  ],
  [
    "db.bulk.delete",
    () =>
      s.db.bulk.delete({
        table: users,
        where: expr(col("id"), "=", c.int(1)),
        disabled: true,
        description: NOTE,
      }),
  ],
  [
    "db.bulk.patch",
    () => s.db.bulk.patch({ table: users, items: c.array([]), disabled: true, description: NOTE }),
  ],
  ["db.truncate", () => s.db.truncate({ table: users, disabled: true, description: NOTE })],
  ["security.create_guid", () => s.security.create_guid({ disabled: true, description: NOTE })],
  ["util.get_raw_input", () => s.util.get_raw_input({ disabled: true, description: NOTE })],
  ["util.post_process", () => s.util.post_process([], { disabled: true, description: NOTE })],
  [
    "db.get_by_id",
    () => s.db.get_by_id({ table: users, id: inp("id"), disabled: true, description: NOTE }),
  ],
  [
    "security.create_auth_token",
    () =>
      s.security.create_auth_token({
        table: users,
        id: c.int(1),
        disabled: true,
        description: NOTE,
      }),
  ],
  [
    "ai.agent.run",
    () => s.ai.agent.run({ agent: "a", disabled: true, description: NOTE }),
  ],
];

describe("statement annotations — hand-authored specials", () => {
  it.each(SPECIALS)("%s honours both", (_name, build) => {
    expect(encoded(build())).toEqual({ disabled: true, description: NOTE });
  });
});
