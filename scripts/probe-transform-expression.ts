/**
 * Empirical probe — what does `fl.transform`'s expression argument bind, and to
 * what?
 *
 * Issue #245: an author reported `fl.transform` fatal with a JavaScript body.
 * `fl.transform` does not take one. It takes Xano **Expression Engine** source,
 * evaluated on a different path from the eight lambda filters — and the engine's
 * own catalog description for it ("local data bound to the `$this` variable") is
 * WRONG, which is the sentence the SDK republished into `FILTER_SPECS`,
 * `manifest.json` and `llms.txt`. `$this` is not a binding here; it resolves to
 * null, silently.
 *
 * Shape mirrors `probe-lambda-bindings.ts`: this file declares {@link CONTRACT}
 * — the bindings the SDK claims exist — and probes every one against a live
 * engine, INCLUDING the ones it claims are absent. A disagreement fails the run.
 * So `vendor/transform-expression.json` is not a transcript to be read by hand;
 * it is a table a real engine agreed with on the day it was written.
 *
 * Two things make the answers readable:
 *
 *   - Unlike a lambda body, a bad expression does NOT always throw. Three of the
 *     JavaScript spellings an author reaches for return a plausible WRONG value
 *     with HTTP 200 (`const x = $0; return x` → the text `"const x"`). Those are
 *     recorded as their own section, because they are the reason the guard this
 *     probe justifies exists at all — a fatal error at least announces itself.
 *   - A binding case reads its verdict off the returned VALUE against a known
 *     operand, not off the status code.
 *
 * Run (maintainer step; needs a live sandbox):
 *   tsx scripts/probe-transform-expression.ts   # reads XANO_VALIDATE_* from .env
 * Writes `vendor/transform-expression.json` (the recorded contract + evidence).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspace, defineFunction, s, c, ref, input, withFilters, serializeBundle } from "../src/index.js";
import type { FilterXdo } from "../src/types/xdo.js";
import { resolveValidateConfig } from "../src/validate/config.js";
import { MetaClient } from "../src/validate/meta-client.js";

const ROOT = join(import.meta.dirname, "..");

// --- the contract under test ----------------------------------------------------

/**
 * Every identifier a `transform` expression might resolve — probed present or
 * absent, with what it must evaluate to when the operand is the int 5 and the
 * enclosing stack holds `subtotal = 7`.
 *
 * `$0` is the operand's POSITIONAL slot, and `$$` is the top of that positional
 * stack — which, at the top level of a `transform` expression, is the same slot.
 * They differ inside a nested iterating pipe, where the inner pipe pushes: see
 * the `nested.*` evidence below.
 */
const BINDINGS: Record<string, { bound: boolean; expect?: unknown; why: string }> = {
  $0: { bound: true, expect: 5, why: "the piped operand, in its positional slot" },
  $$: { bound: true, expect: 5, why: "top of the positional stack — the operand at this level" },
  $var: { bound: true, expect: 7, why: "the enclosing stack variables, by name ($var.subtotal)" },
  $input: { bound: true, why: "the enclosing function's inputs" },
  $env: { bound: true, why: "workspace environment + request settings" },
  $auth: { bound: true, why: "the authenticated caller" },
  // The four the wrong description sends an author to. None is bound here; each
  // resolves to null, and null propagates into a plausible wrong answer.
  $this: { bound: false, why: "NOT bound — the engine catalog's description is wrong (#245)" },
  $parent: { bound: false, why: "NOT bound — an iterating-pipe binding, not a transform one" },
  $index: { bound: false, why: "NOT bound — an iterating-pipe binding" },
  $result: { bound: false, why: "NOT bound — a reduce binding" },
};

/** The expression that reads each binding, and what the answer means. */
const READS: Record<string, string> = {
  $0: "$0",
  $$: "$$",
  $var: "$var.subtotal",
  $input: "$input.qty",
  $env: "$env",
  $auth: "$auth",
  $this: "$this",
  $parent: "$parent",
  $index: "$index",
  $result: "$result",
};

// --- probe plumbing ---------------------------------------------------------------

interface Case {
  id: string;
  asks: string;
  fn: ReturnType<typeof defineFunction>;
  runInput?: Record<string, unknown>;
  /** For a binding case: the identifier under test and whether it must be bound. */
  binding?: { name: string; bound: boolean; expect?: unknown };
}

const cases: Case[] = [];
let n = 0;

function add(case_: Omit<Case, "fn"> & {
  stack: Parameters<typeof defineFunction>[0]["stack"];
  input?: Parameters<typeof defineFunction>[0]["input"];
}): void {
  const { stack, input: inp, ...rest } = case_;
  cases.push({
    ...rest,
    fn: defineFunction({ name: `probe_${n++}`, ...(inp ? { input: inp } : {}), stack, response: ref("out") }),
  });
}

/**
 * A `transform` filter built WITHOUT going through `filter()`.
 *
 * `filter()` is where the guard this probe justifies lives, and the guard
 * refuses `$this` and JavaScript bodies — which are precisely the cases the
 * probe exists to measure. So the probe constructs the `FilterXdo` literal
 * directly, the same escape hatch codegen takes for a stored value it cannot
 * author. Nothing here should be copied into application code; the guard is
 * right and this file is the exception that proves it.
 */
const rawTransform = (expr: string): FilterXdo => ({
  name: "transform",
  disabled: false,
  arg: [c.text(expr)],
});

/** `transform` over the int 5, with `subtotal = 7` on the stack. */
const onInt = (expr: string): Parameters<typeof defineFunction>[0]["stack"] => [
  s.set_var("subtotal", c.int(7)),
  s.set_var("out", withFilters(c.int(5), rawTransform(expr))),
];

// --- the binding matrix ----------------------------------------------------------

for (const [name, spec] of Object.entries(BINDINGS)) {
  const needsInput = name === "$input";
  add({
    id: `binding.${name}`,
    asks: `Does ${name} resolve in a transform expression? (${spec.why})`,
    stack: onInt(READS[name]),
    ...(needsInput ? { input: { qty: input.int() }, runInput: { qty: 3 } } : {}),
    binding: { name, bound: spec.bound, expect: needsInput ? 3 : spec.expect },
  });
}

// --- what an author actually writes, and what comes back --------------------------

/** `[id, asks, expression]`, all over the int 5. */
const GRAMMAR: Array<[string, string, string]> = [
  ["arith", "Arithmetic over the operand.", "$0 * 2"],
  ["arith.dollardollar", "The same through $$.", "$$ * 2"],
  ["literal", "An expression with no operand at all.", "1 + 2"],
  ["ternary", "A conditional.", '$0 > 3 ? "big" : "small"'],
  ["concat.tilde", "Concatenation with ~ (the expression-engine spelling).", '"n=" ~ $0'],
  ["concat.dotdot", "Concatenation with .. — is it the same operator?", '$0 .. "!"'],
  ["concat.plus", "Concatenation with + on a number.", '$0 + "!"'],
  ["pipe", "A FILTER inside the expression.", "$0|add:3"],
  ["obj_literal", "Does an object literal build an object?", "{ raw: $0, doubled: $0 * 2 }"],
  ["arr_literal", "Does an array literal build an array?", "[$0, $0 * 2]"],
  ["bare_var", "Is a stack variable ALSO a bare $name? (it is — so a var named `this` would shadow)", "$subtotal"],
  // The comma hazard. Inside an object literal, a filter ARGUMENT's comma is
  // read as the key separator, so the pipe swallows the rest of the literal:
  // the piped key comes back null and every later key vanishes, with no error.
  // Parentheses settle it. A pipe with no argument is unaffected, which is what
  // makes the rule easy to learn wrong.
  ["obj_pipe.bare", "Object literal, UNPARENTHESIZED pipe with an argument.", '{ a: $0|to_text:"", b: 1 }'],
  ["obj_pipe.paren", "The same, parenthesized.", '{ a: ($0|to_text:""), b: 1 }'],
  ["obj_pipe.noarg", "A pipe with NO argument, unparenthesized.", "{ a: $0|to_text, b: 1 }"],
  ["empty", "What does an empty expression produce?", ""],
  ["null_coalesce", "How does an UNBOUND name propagate?", '$this ?? "was-null"'],
];
for (const [id, asks, expr] of GRAMMAR) {
  add({ id: `grammar.${id}`, asks, stack: onInt(expr) });
}

// --- the JavaScript spellings: which throw, and which lie -------------------------

/**
 * The failure mode that made #245 hard to diagnose. A JS body is not rejected as
 * a category — it is PARSED AS AN EXPRESSION, and three of these produce a
 * value, with HTTP 200, that has nothing to do with what was written.
 */
const JS_SPELLINGS: Array<[string, string]> = [
  ["return_this", "return $this * 2"],
  ["return_dollar0", "return $0 * 2"],
  ["arrow", "$this => $this * 2"],
  ["statements", "const x = $0; return x"],
];
for (const [id, expr] of JS_SPELLINGS) {
  add({
    id: `js.${id}`,
    asks: `JavaScript spelling \`${expr}\` — does it throw, or return a wrong value?`,
    stack: onInt(expr),
  });
}

// --- operand shapes and chain position --------------------------------------------

add({
  id: "operand.object",
  asks: "Object operand: does $0 carry a path?",
  stack: [
    s.set_var("src", c.obj({ a: 1, b: 2 })),
    s.set_var("out", withFilters(ref("src"), rawTransform("$0.a + $0.b"))),
  ],
});
add({
  id: "operand.object.this",
  asks: "The same object operand through $this — the spelling the wrong description teaches.",
  stack: [
    s.set_var("src", c.obj({ a: 1, b: 2 })),
    s.set_var("out", withFilters(ref("src"), rawTransform("$this.a"))),
  ],
});
add({
  id: "operand.array",
  asks: "Array operand through a filter chain inside the expression.",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), rawTransform('$0|sort|join:","')))],
});
add({
  id: "nested.dollardollar",
  asks: "Inside a nested iterating pipe, does $$ rebind to the element?",
  stack: [s.set_var("out", withFilters(c.array([1, 2, 3, 4]), rawTransform("$0|map:($$ * 2)")))],
});
add({
  id: "nested.dollar0",
  asks: "…and does $0 still mean the OUTER operand there?",
  stack: [s.set_var("out", withFilters(c.array([1, 2, 3, 4]), rawTransform("$0|map:($0 * 2)")))],
});
add({
  id: "chain.upstream",
  asks: "With a filter BEFORE it, is $0 the upstream filter's output?",
  stack: [s.set_var("out", withFilters(c.int(5), filter("add", c.int(1)), rawTransform("$0")))],
});
add({
  id: "chain.downstream",
  asks: "Does a filter AFTER transform see the transformed value?",
  stack: [
    s.set_var("out", withFilters(c.int(5), rawTransform("$0 * 2"), filter("add", c.int(1)))),
  ],
});
add({
  id: "chain.two_transforms",
  asks: "Two transforms in a row — does the positional stack grow, or does each start fresh?",
  stack: [
    s.set_var(
      "out",
      withFilters(c.int(5), rawTransform("$0 * 2"), rawTransform("$0 + 1")),
    ),
  ],
});

// --- `to_expr`: the same grammar, arriving on the PIPED value ----------------------

/**
 * `to_expr` takes no argument — the piped value IS the expression source. Probed
 * so the record says whether it shares `transform`'s operand binding (it cannot:
 * there is no operand left to bind) rather than leaving a reader to assume.
 */
add({
  id: "to_expr.ambient",
  asks: "to_expr: does the ambient set resolve when the SOURCE is the piped value?",
  stack: [s.set_var("subtotal", c.int(7)), s.set_var("out", withFilters(c.text("$var.subtotal * 2"), filter("to_expr")))],
});
add({
  id: "to_expr.dollar0",
  asks: "to_expr: is there a $0 operand binding at all?",
  stack: [s.set_var("out", withFilters(c.text("$0"), filter("to_expr")))],
});

// --- run ---------------------------------------------------------------------------

const verdictOf = (b: unknown): string => (b as { result?: { status?: string } } | undefined)?.result?.status ?? "?";
const resultOf = (b: unknown): unknown => (b as { result?: { result?: unknown } } | undefined)?.result?.result;

/**
 * The exception message, with the engine's internal identifiers taken out —
 * those are not ours to publish (project CLAUDE.md) and carry no information the
 * message itself does not.
 */
function exceptionOf(b: unknown): string | undefined {
  const raw = (b as { result?: { exception?: { message?: string } } } | undefined)?.result?.exception?.message;
  if (raw === undefined) return undefined;
  return raw
    .replace(/[A-Za-z_][A-Za-z0-9_]*(?:\\[A-Za-z0-9_]+)+/g, "<engine internal>")
    .replace(/\bin \/\S+ on line \d+/g, "")
    .trim();
}

const render = (v: unknown): string => (typeof v === "string" ? v : (JSON.stringify(v) ?? String(v)));

async function main(): Promise<void> {
  const ws = workspace("transform_expression_probe").registerFunctions(cases.map((c_) => c_.fn));
  const bundle = serializeBundle((ws as unknown as { export(): unknown }).export());

  const client = new MetaClient(resolveValidateConfig());
  console.error(`Importing ${cases.length} probe functions → sandbox…`);
  const imp = await client.importBundle(bundle);
  if (imp.workspaceId === undefined) throw new Error(`no workspaceId: ${imp.raw.slice(0, 300)}`);
  console.error(`workspace ${imp.workspaceId} (${imp.baseUrl}). Running…\n`);

  const evidence: Array<Record<string, unknown>> = [];
  const mismatches: string[] = [];

  for (const [i, case_] of cases.entries()) {
    const res = await client.runFunction(imp.workspaceId, `probe_${i}`, case_.runInput ?? {});
    const verdict = verdictOf(res.body);
    const value = resultOf(res.body);
    const exception = exceptionOf(res.body);
    const row: Record<string, unknown> = {
      id: case_.id,
      asks: case_.asks,
      verdict,
      ...(exception === undefined ? { value: render(value).slice(0, 400) } : { exception: exception.slice(0, 300) }),
    };

    if (case_.binding) {
      // An UNBOUND identifier resolves to null. A BOUND one resolves to
      // something that is not null — and where the expected value is known, to
      // exactly that. Anything else is the contract being wrong.
      const observed = verdict === "ok" && value !== null;
      row.bound = observed;
      row.expected = case_.binding.bound;
      if (observed !== case_.binding.bound) {
        mismatches.push(
          `${case_.binding.name}: contract says ${case_.binding.bound ? "BOUND" : "absent"}, engine says ` +
            `${observed ? "BOUND" : "absent"} (${verdict}: ${render(exception ?? value).slice(0, 120)})`,
        );
      } else if (case_.binding.expect !== undefined && verdict === "ok" && value !== case_.binding.expect) {
        mismatches.push(
          `${case_.binding.name}: expected ${render(case_.binding.expect)}, engine returned ${render(value)}`,
        );
      }
    }

    evidence.push(row);
    console.error(`${case_.id.padEnd(30)} ${verdict.padEnd(10)} ${render(exception ?? value).slice(0, 100)}`);
  }

  console.error(`\nbinding matrix: ${Object.keys(BINDINGS).length} probes, ${mismatches.length} disagreeing`);
  for (const m of mismatches) console.error(`  MISMATCH  ${m}`);

  writeFileSync(
    join(ROOT, "vendor/transform-expression.json"),
    JSON.stringify(
      {
        note:
          "Live-probed contract for `fl.transform`'s expression argument (issue #245), plus the evidence behind it. " +
          "`transform` takes Xano Expression Engine SOURCE, not a JavaScript body: the piped operand arrives in the " +
          "POSITIONAL slot `$0` (equivalently `$$` at the top level), and `$this` is NOT bound — it resolves to null. " +
          "The engine's own catalog description says otherwise and is wrong; scripts/codegen-filters.ts overrides it. " +
          "Regenerate with `tsx scripts/probe-transform-expression.ts` against a sandbox — the run fails if the " +
          "recorded contract and a real engine disagree.",
        probedAt: new Date().toISOString().slice(0, 10),
        contract: {
          bound: Object.entries(BINDINGS)
            .filter(([, s_]) => s_.bound)
            .map(([name, s_]) => ({ name, why: s_.why })),
          absent: Object.entries(BINDINGS)
            .filter(([, s_]) => !s_.bound)
            .map(([name, s_]) => ({ name, why: s_.why })),
        },
        agreed: mismatches.length === 0,
        mismatches,
        evidence,
      },
      null,
      2,
    ) + "\n",
  );
  console.error(`\nWrote vendor/transform-expression.json`);
  await client.dispose();
  if (mismatches.length) process.exit(1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
