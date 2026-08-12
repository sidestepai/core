/**
 * Empirical probe — what is actually in scope inside a lambda body, per surface?
 *
 * Issue #221 reports that `fl.reduce`'s body cannot see `$acc`. Nothing in this
 * SDK ever stated which identifiers a lambda body DOES see, so an author guesses,
 * the guess is wrong, and the first signal is a wrong value at runtime. Before an
 * authoring surface (`lam.*`) is built on that contract, the contract itself has
 * to be a recorded, re-checkable fact rather than a belief.
 *
 * Shape: this file declares {@link CONTRACT} — the binding set per surface — and
 * then probes EVERY surface × EVERY candidate binding on a live engine, including
 * the combinations it claims are absent. A disagreement fails the run. So the
 * committed `vendor/lambda-bindings.json` is not a transcript to be interpreted
 * by hand; it is a table that a real engine agreed with on the day it was
 * written, and re-running is how it stays true.
 *
 * Two things make the answers readable:
 *
 *   - A lambda body that throws does NOT fail the request — the engine returns
 *     the diagnostic TEXT as the value with HTTP 200. So a case's verdict is read
 *     off the returned value, not the status code. Every binding case therefore
 *     runs the same `typeof X !== "undefined"` predicate, and each surface has its
 *     own reader for how that predicate comes back (a `filter` body returns
 *     survivors, `findIndex` an index, and so on). Reading an identifier the
 *     surface does not bind is not a throw at all — it reads as unset — so the
 *     predicate, not the error, is what settles a binding.
 *   - The load-bearing question is whether a stack variable is ALSO injected as a
 *     bare `$name` identifier. If it were, a whitelist guard (any `$identifier`
 *     outside the contract is an author error) would be unsound, so that is
 *     probed directly rather than inferred.
 *
 * Also probes the leading-optional argument slotting (#221 "Related"): what the
 * engine does when a filter's optional-by-spec LEADING argument is omitted and
 * the next argument slides into its slot.
 *
 * Run (maintainer step; needs a live sandbox):
 *   tsx scripts/probe-lambda-bindings.ts     # reads XANO_VALIDATE_* from .env
 * Writes `vendor/lambda-bindings.json` (the recorded contract + its evidence).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspace, defineFunction, s, c, ref, input, withFilters, filter, serializeBundle } from "../src/index.js";
import type { Value } from "../src/index.js";
import { resolveValidateConfig } from "../src/validate/config.js";
import { MetaClient } from "../src/validate/meta-client.js";
import { calcSignatureJson } from "../src/workspace/export.js";

const ROOT = join(import.meta.dirname, "..");

// --- the contract under test ----------------------------------------------------

/** In scope at every lambda surface: ambient request state and two host objects. */
const AMBIENT = ["$env", "$input", "$var", "$auth", "console", "crypto"] as const;

/** Every identifier any surface might bind — probed at all of them, present or not. */
const CANDIDATES = [...AMBIENT, "$this", "$index", "$parent", "$result"] as const;

/** The array-iterating filters: one body run per element. */
const ITERATORS = ["map", "filter", "some", "every", "find", "findIndex"] as const;

/**
 * Surface → the identifiers bound in a body at that surface. The claim; the run
 * is the check.
 */
const CONTRACT: Record<string, readonly string[]> = {
  // The lambda STATEMENT runs once, over no element and no piped value.
  "s.lambda": [...AMBIENT],
  // `fl.lambda` runs once over the piped value, which it binds as `$this`.
  "fl.lambda": [...AMBIENT, "$this"],
  // The iterating filters bind the element, its position, and the whole array.
  ...Object.fromEntries(ITERATORS.map((n) => [n, [...AMBIENT, "$this", "$index", "$parent"]])),
  // `reduce` adds the accumulator — the binding #221 called `$acc`.
  reduce: [...AMBIENT, "$this", "$index", "$parent", "$result"],
};

// --- probe plumbing ---------------------------------------------------------------

/** One probe: a named function plus what its answer settles. */
interface Case {
  id: string;
  surface: string;
  asks: string;
  fn: ReturnType<typeof defineFunction>;
  runInput?: Record<string, unknown>;
  /** For a binding case: the identifier under test, and whether it should be bound. */
  binding?: { name: string; expected: boolean; read: (value: unknown) => boolean | null };
  /** The exact value the engine must return. A difference fails the run. */
  expect?: unknown;
}

const cases: Case[] = [];
let n = 0;

function add(case_: Omit<Case, "fn"> & { stack: Parameters<typeof defineFunction>[0]["stack"]; input?: Parameters<typeof defineFunction>[0]["input"] }): void {
  const { stack, input: inp, ...rest } = case_;
  cases.push({
    ...rest,
    fn: defineFunction({ name: `probe_${n++}`, ...(inp ? { input: inp } : {}), stack, response: ref("out") }),
  });
}

/** `[1,2,3,4]` — the array every iterating-filter case runs over. */
const nums = () => c.array([1, 2, 3, 4]);

/** The one body every binding case runs: true exactly when the identifier is bound. */
const isBound = (name: string) => c.text(`const t = typeof ${name};\nreturn (t !== "undefined");`);

/**
 * How each surface reports the predicate's answer. Returns null when the engine's
 * reply is not one of the two shapes the surface can produce — a body that threw,
 * say — so an unreadable answer is never silently scored as a verdict.
 */
const READERS: Record<string, (v: unknown) => boolean | null> = {
  // Runs once, returns the boolean itself.
  "s.lambda": (v) => (typeof v === "boolean" ? v : null),
  "fl.lambda": (v) => (typeof v === "boolean" ? v : null),
  // Returns one boolean per element.
  map: (v) => (Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "boolean") ? v.every(Boolean) : null),
  // Keeps the elements the predicate accepted: all four, or none.
  filter: (v) => (Array.isArray(v) ? (v.length === 4 ? true : v.length === 0 ? false : null) : null),
  some: (v) => (typeof v === "boolean" ? v : null),
  every: (v) => (typeof v === "boolean" ? v : null),
  // The first accepted element (1), or nothing.
  find: (v) => (v === 1 ? true : v === null ? false : null),
  // The first accepted index (0), or the not-found sentinel.
  findIndex: (v) => (v === 0 ? true : v === -1 ? false : null),
  // The predicate's own value becomes the accumulator, so the last one wins.
  reduce: (v) => (typeof v === "boolean" ? v : null),
};

/**
 * The SDK refuses a lambda body that names a `$identifier` the surface does not
 * bind, or that declares module syntax — the whole point of those guards, and
 * the reason this probe cannot author its own bodies directly. It has to: half
 * the binding matrix is "is `$index` bound HERE?", and `top_level_import` asks
 * what the engine does with the syntax the SDK rejects. An answer only exists if
 * the body reaches the engine.
 *
 * So a probed body is authored as a placeholder that every guard accepts, and
 * the real text is put back in the exported bundle ({@link restoreBodies}). One
 * escape rather than one per guard, and it stays correct as guards are added.
 * Nothing else in the SDK is bypassed, and the guards themselves are covered by
 * the unit tests.
 */
const parked = new Map<string, string>();

/** A guard-clean stand-in for `code`, registered for restoration at export. */
function park(code: Value): Value {
  const real = String((code as { value: unknown }).value);
  // A bare string literal: valid as a lambda body AND as an expression, so one
  // placeholder clears every surface's guard.
  const placeholder = `"ZZ_PARKED_${parked.size}_ZZ"`;
  parked.set(placeholder, real);
  return { ...code, value: placeholder } as Value;
}

/** The stack that runs `code` at `surface`, ending in `set_var("out", …)`. */
function stackFor(surface: string, code: Value): Parameters<typeof defineFunction>[0]["stack"] {
  const body = park(code);
  if (surface === "s.lambda") return [s.set_var("subtotal", c.int(7)), s.lambda({ as: "out", code: body })];
  if (surface === "fl.lambda") {
    return [s.set_var("subtotal", c.int(7)), s.set_var("out", withFilters(c.int(5), filter("lambda", body)))];
  }
  if (surface === "reduce") {
    return [s.set_var("subtotal", c.int(7)), s.set_var("out", withFilters(nums(), filter("reduce", c.int(0), body)))];
  }
  return [s.set_var("subtotal", c.int(7)), s.set_var("out", withFilters(nums(), filter(surface, body)))];
}

// --- binding matrix: every surface × every candidate ---------------------------------

for (const surface of Object.keys(CONTRACT)) {
  for (const name of CANDIDATES) {
    add({
      id: `${surface}::${name}`,
      surface,
      asks: `Is ${name} bound at ${surface}?`,
      stack: stackFor(surface, isBound(name)),
      binding: { name, expected: CONTRACT[surface].includes(name), read: READERS[surface] },
    });
  }
  // `$acc` — the name #221 guessed — is not in the candidate set because it is
  // not a binding anywhere; probe it explicitly at every surface so the record
  // says so rather than implying it.
  add({
    id: `${surface}::$acc`,
    surface,
    asks: `Is $acc bound at ${surface}? (the name #221 guessed)`,
    stack: stackFor(surface, isBound("$acc")),
    binding: { name: "$acc", expected: false, read: READERS[surface] },
  });
}

// --- what the bindings actually CONTAIN ------------------------------------------------

add({
  id: "reduce.sums",
  surface: "reduce",
  asks: "Does $result accumulate — does [1,2,3,4] reduce to 10?",
  stack: [s.set_var("out", withFilters(nums(), filter("reduce", c.int(0), c.text("return $result + $this"))))],
});
add({
  id: "reduce.$index.values",
  surface: "reduce",
  asks: "Is $index the element position (0+1+2+3 = 6)?",
  stack: [s.set_var("out", withFilters(nums(), filter("reduce", c.int(0), c.text("return $result + $index"))))],
});
add({
  id: "reduce.$parent.value",
  surface: "reduce",
  asks: "Is $parent the whole piped array?",
  stack: [s.set_var("out", withFilters(nums(), filter("reduce", c.int(0), c.text("return JSON.stringify($parent)"))))],
});
add({
  id: "map.$this.value",
  surface: "map",
  asks: "Is $this the element (doubling [1,2,3,4] gives [2,4,6,8])?",
  stack: [s.set_var("out", withFilters(nums(), filter("map", c.text("return $this * 2"))))],
});
add({
  id: "fl.lambda.$this.value",
  surface: "fl.lambda",
  asks: "Is $this the piped value in fl.lambda (5 * 2 = 10)?",
  stack: [s.set_var("out", withFilters(c.int(5), filter("lambda", c.text("return $this * 2"))))],
});
add({
  id: "s.lambda.$var.value",
  surface: "s.lambda",
  asks: "Does $var carry the stack variables by name?",
  stack: [s.set_var("subtotal", c.int(7)), s.lambda({ as: "out", code: c.text("return $var.subtotal") })],
});
add({
  id: "s.lambda.$input.value",
  surface: "s.lambda",
  asks: "Does $input carry the function input?",
  stack: [s.lambda({ as: "out", code: c.text("return $input.qty") })],
  input: { qty: input.int() },
  runInput: { qty: 3 },
});

// --- the load-bearing question: is a stack variable ALSO a bare $name? ----------------

for (const surface of ["s.lambda", "fl.lambda", "map"]) {
  add({
    id: `${surface}.bare_var`,
    surface,
    asks: "LOAD-BEARING: is a stack variable injected as a bare $name (or a bare name) identifier?",
    stack: stackFor(
      surface,
      c.text(
        'return JSON.stringify({ dollarName: typeof $subtotal, bareName: typeof subtotal, viaVar: $var.subtotal })',
      ),
    ),
  });
}

// --- how the body itself behaves --------------------------------------------------------

const behaviors: Array<[string, string, string]> = [
  ["unknown_dollar.typeof", "Does `typeof $nope` throw, or report undefined?", "return typeof $nope"],
  ["unknown_dollar.read", "What happens when an unbound $identifier is READ?", "return $nope + 1"],
  ["top_level_import", "Is a top-level import a syntax error?", "import { join } from 'node:path'; return typeof join"],
  ["top_level_export", "Is a top-level export a syntax error?", "export const x = 1; return 1"],
  // #265: whether a LITERAL specifier resolves is a property of the instance,
  // not of the platform, so these four are recorded together and read together.
  // An instance that BUNDLES the body resolves every literal specifier ahead of
  // time against a filesystem where none of them exist, and answers every one of
  // these with a BUILD-time `Could not resolve "…"`. An instance that transpiles
  // resolves at run time, so the first three succeed and only `import_unresolvable`
  // fails — with the RUNTIME's own wording (`Module not found "file:///…"`).
  // Which wording comes back is therefore the discriminator, and it is why a
  // success here must never be written down as "dependencies are reached with
  // `import()`". Reachable on both: the globals below.
  ["dynamic_import", "Does a literal import('node:…') resolve? (#265: instance-dependent)", "const m = await import('node:path'); return typeof m.join"],
  ["dynamic_import.npm", "Does a literal import('npm:…') resolve? (#265)", "const m = await import('npm:lodash'); return typeof m"],
  ["require.literal", "Does a literal require('…') resolve? (#265)", "const m = await require('lodash'); return typeof m.map"],
  ["import_unresolvable", "DISCRIMINATOR: which layer answers a specifier that cannot exist — the bundler (build time) or the runtime (run time)?", "const m = await import('./zz-no-such-module-265.js'); return typeof m"],
  ["require", "Is require() available?", "return typeof require"],
  ["ts_syntax.annotation", "Does a TypeScript type annotation survive?", "const x: number = 1; return x"],
  ["ts_syntax.as", "Does a TypeScript `as` cast survive?", "const x = 1 as number; return x"],
  ["ts_syntax.interface", "Does a TypeScript interface declaration survive?", "interface P { a: number }\nconst p: P = { a: 1 }; return p.a"],
  ["await_toplevel", "Is top-level await allowed?", "const v = await Promise.resolve(9); return v"],
  ["no_return", "What does a body with no return produce?", "1 + 1"],
  ["empty_body", "What does an empty body produce?", ""],
  ["console.captured", "Does console.log break the body?", "console.log('probe'); return 'after-log'"],
  // Every key, not a slice: this list is what `LAMBDA_MODULE_GLOBALS` documents
  // as the portable dependency route (#265), and a unit test checks the two
  // against each other. A truncated record would silently under-document it.
  ["globalThis", "Which globals are reachable?", "return Object.keys(globalThis).join(',')"],
];
for (const [id, asks, code] of behaviors) {
  add({ id: `s.lambda.${id}`, surface: "s.lambda", asks, stack: stackFor("s.lambda", c.text(code)) });
  add({ id: `fl.lambda.${id}`, surface: "fl.lambda", asks, stack: stackFor("fl.lambda", c.text(code)) });
}

// --- one body text, two surfaces (#247) -------------------------------------------------

/**
 * Every case above already runs its body at `s.lambda` and then at `fl.lambda`
 * with BYTE-IDENTICAL text, and that is deliberate.
 *
 * The engine compiles a body once and caches the compiled form keyed on its
 * text. It used to capture the calling surface's bindings into that compiled
 * form, so the surface that ran a given text FIRST decided which identifiers
 * existed for the other: a filter body first compiled for a statement call had
 * no `$this` at all, reported `typeof $this` as `"undefined"` with the value
 * sitting in the payload, and took the wrong branch of the ordinary
 * `typeof x !== "undefined"` guard — with no error, so it read as bad data.
 * That was #247, misfiled at the time as a quoting quirk because the probe
 * order made it look quote-sensitive; the real discriminator was which surface
 * compiled first, and with more than one engine replica it only landed when
 * both calls hit the same one.
 *
 * Fixed engine-side. These two cases are the regression check: they are CHECKED
 * rather than merely recorded, so the run fails if a compiled body ever again
 * answers for the wrong surface. Do not "fix" them by making the two surfaces
 * use different text — identical text is the whole point.
 */
const SHARED_TEXT: Array<[string, string, string, unknown, unknown]> = [
  // id, code, asks, expected at s.lambda, expected at fl.lambda
  ["shared_text.typeof", "return typeof $this", "One body text at both surfaces: what does `typeof $this` report?", "undefined", "number"],
  [
    "shared_text.guard",
    'return typeof $this !== "undefined"',
    "One body text at both surfaces: does the ordinary defensive guard answer for ITS OWN surface?",
    false,
    true,
  ],
];
for (const [id, code, asks, atStatement, atFilter] of SHARED_TEXT) {
  add({ id: `s.lambda.${id}`, surface: "s.lambda", asks, stack: stackFor("s.lambda", c.text(code)), expect: atStatement });
  add({ id: `fl.lambda.${id}`, surface: "fl.lambda", asks, stack: stackFor("fl.lambda", c.text(code)), expect: atFilter });
}

// --- fl.transform: same contract at all? (#221 "Related", deferred by the plan) ----------

add({
  id: "fl.transform.$this",
  surface: "fl.transform",
  asks: "Does fl.transform take an XanoScript expression over $this rather than a JS body?",
  stack: [s.set_var("out", withFilters(c.int(5), filter("transform", park(c.text("$this")))))],
});
add({
  id: "fl.transform.js_body",
  surface: "fl.transform",
  asks: "Does fl.transform accept a JS lambda body at all?",
  stack: [s.set_var("out", withFilters(c.int(5), filter("transform", park(c.text("return $this * 2")))))],
});

// --- leading-optional argument slotting (#221 "Related") ----------------------------------

/**
 * Each of these declares a LEADING argument the upstream spec marks optional,
 * followed by one the spec marks required. `filter()` drops an omitted argument
 * positionally, so omitting the leading one slides the next into its slot. Probed
 * two ways per filter: the short call an author would write today, and the full
 * call with every slot filled.
 */
const SLOTTING: Array<{
  name: string;
  short: Value[];
  full: Value[];
  base: () => Value;
}> = [
  { name: "reduce", base: () => nums(), short: [c.text("return $result + $this")], full: [c.int(0), c.text("return $result + $this")] },
  { name: "array_fill", base: () => c.text("x"), short: [c.int(3)], full: [c.int(0), c.int(3)] },
  {
    name: "encrypt",
    base: () => c.text("secret"),
    short: [c.text("0123456789abcdef0123456789abcdef"), c.text("0123456789abcdef")],
    full: [c.text("aes-256-ctr"), c.text("0123456789abcdef0123456789abcdef"), c.text("0123456789abcdef")],
  },
  {
    name: "decrypt",
    base: () => c.text("secret"),
    short: [c.text("0123456789abcdef0123456789abcdef"), c.text("0123456789abcdef")],
    full: [c.text("aes-256-ctr"), c.text("0123456789abcdef0123456789abcdef"), c.text("0123456789abcdef")],
  },
  {
    name: "crypto_jws_encode",
    base: () => c.text('{"sub":"u1"}'),
    short: [c.text('"0123456789abcdef0123456789abcdef"')],
    full: [c.text("{}"), c.text('"0123456789abcdef0123456789abcdef"'), c.text("HS256")],
  },
  {
    name: "crypto_jws_decode",
    base: () => c.text("not.a.token"),
    short: [c.text('"0123456789abcdef0123456789abcdef"')],
    full: [c.text("{}"), c.text('"0123456789abcdef0123456789abcdef"'), c.text("HS256")],
  },
  {
    name: "crypto_jwe_encode",
    base: () => c.text('{"sub":"u1"}'),
    short: [c.text('"0123456789abcdef0123456789abcdef"')],
    full: [c.text("{}"), c.text('"0123456789abcdef0123456789abcdef"'), c.text("A128KW"), c.text("A128CBC-HS256")],
  },
  {
    name: "crypto_jwe_decode",
    base: () => c.text("not.a.token"),
    short: [c.text('"0123456789abcdef0123456789abcdef"')],
    full: [c.text("{}"), c.text('"0123456789abcdef0123456789abcdef"'), c.text("A128KW"), c.text("A128CBC-HS256")],
  },
];

for (const spec of SLOTTING) {
  add({
    id: `slotting.${spec.name}.short`,
    surface: "slotting",
    asks: `${spec.name}: leading spec-optional argument omitted — does the engine accept the call?`,
    stack: [s.set_var("out", withFilters(spec.base(), filter(spec.name, ...spec.short)))],
  });
  // The arity ladder: the same call with 0, 1, 2 … arguments. The engine reports
  // a short call as "too few arguments", so the smallest rung that does NOT say
  // that is the number of arguments it actually requires — which is the number
  // the generated signature must require, whatever the spec's `optional` flags
  // claim. Derived from execution rather than from any declared metadata.
  for (let k = 0; k <= spec.full.length; k++) {
    add({
      id: `arity.${spec.name}.${k}`,
      surface: "arity",
      asks: `${spec.name}: is a ${k}-argument call accepted?`,
      stack: [s.set_var("out", withFilters(spec.base(), filter(spec.name, ...spec.full.slice(0, k))))],
    });
  }
}

// An explicit null in the omitted leading slot is the other way KTD5 could have
// gone. Hand-built, because `filter()` drops an omitted argument rather than
// nulling it.
cases.push({
  id: "slotting.reduce.null_leading",
  surface: "slotting",
  asks: "Can a null placeholder stand in for an omitted leading argument?",
  fn: defineFunction({
    name: `probe_${n++}`,
    stack: [
      s.set_var("out", {
        ...nums(),
        filters: [{ name: "reduce", disabled: false, arg: [null as unknown as Value, c.text("return $result + $this")] }],
      } as Value),
    ],
    response: ref("out"),
  }),
});

// --- run -------------------------------------------------------------------------------

/** The engine's own verdict for a run (`ok` / `exception`), when it reports one. */
function verdictOf(body: unknown): string {
  return (body as { result?: { status?: string } } | undefined)?.result?.status ?? "?";
}

/** The value the function returned. */
function resultOf(body: unknown): unknown {
  return (body as { result?: { result?: unknown } } | undefined)?.result?.result;
}

/**
 * The exception message, when the run threw rather than returned — with the
 * engine's internal identifiers taken out.
 *
 * An arity error names the internal callable it came from. That naming is not
 * ours to publish (project CLAUDE.md R10) and it is not the part that carries
 * information: "N passed and at least M expected" is the whole answer. Redacting
 * at the point of capture means the committed record can never carry it, rather
 * than relying on nobody pasting one in later.
 */
function exceptionOf(body: unknown): string | undefined {
  const raw = (body as { result?: { exception?: { message?: string } } } | undefined)?.result?.exception?.message;
  if (raw === undefined) return undefined;
  // An arity error is the one message this probe reads programmatically, and it
  // is mostly internal naming. Reduce it to its two informative numbers.
  const arity = raw.match(/Too few arguments.*?(\d+) passed and at least (\d+) expected/s);
  if (arity) return `Too few arguments: ${arity[1]} passed, at least ${arity[2]} expected`;
  if (/Too few arguments/i.test(raw)) return "Too few arguments";
  // Anything else: drop namespaced names, member calls, and file paths.
  return raw
    .replace(/[A-Za-z_][A-Za-z0-9_]*(?:\\[A-Za-z0-9_]+)+/g, "<engine internal>")
    .replace(/(<engine internal>|[A-Za-z_][A-Za-z0-9_]*)(::\{[^}]*\}[^\s,]*|::[A-Za-z0-9_]+\(\))/g, "<engine internal>")
    .replace(/\bin \/\S+ on line \d+/g, "")
    .trim();
}

/** True when the engine refused the call for having too few arguments. */
function isArityError(message: string | undefined): boolean {
  return message !== undefined && /Too few arguments/i.test(message);
}

function render(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
}

/**
 * Puts back every body {@link park} parked, and re-signs — the bundle carries a
 * signature over its payload, so the swap has to happen on the tree before it is
 * serialized rather than on the JSON text.
 */
function restoreBodies(exported: unknown): string {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return parked.get(node) ?? node;
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  const restored = walk(exported) as Record<string, unknown>;
  // The signature covers the payload the swap just rewrote, so drop the stale
  // one and re-sign rather than shipping a signature over the placeholders.
  delete restored.sig;
  return serializeBundle({ ...restored, sig: calcSignatureJson(restored) } as never);
}

async function main(): Promise<void> {
  const ws = workspace("lambda_binding_probe").registerFunctions(cases.map((c_) => c_.fn));
  const bundle = restoreBodies((ws as unknown as { export(): unknown }).export());

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
      surface: case_.surface,
      asks: case_.asks,
      verdict,
      // 400 chars keeps a recorded answer readable — except the global list,
      // where the WHOLE list is the answer: it is what `LAMBDA_MODULE_GLOBALS`
      // documents as the portable dependency route (#265), and a unit test
      // checks that list against this row. Truncating it here would fail a
      // correctly documented global for sitting past the cut.
      ...(exception === undefined
        ? { value: render(value).slice(0, case_.id.endsWith("globalThis") ? 4000 : 400) }
        : { exception: exception.slice(0, 300) }),
    };

    if (case_.binding) {
      const observed = verdict === "ok" ? case_.binding.read(value) : null;
      row.bound = observed;
      row.expected = case_.binding.expected;
      if (observed !== case_.binding.expected) {
        mismatches.push(
          `${case_.id}: contract says ${case_.binding.expected ? "BOUND" : "absent"}, engine says ${
            observed === null ? `UNREADABLE (${verdict}: ${render(exception ?? value).slice(0, 120)})` : observed ? "BOUND" : "absent"
          }`,
        );
      }
    }
    if (case_.expect !== undefined) {
      row.expected = render(case_.expect);
      if (verdict !== "ok" || value !== case_.expect) {
        mismatches.push(
          `${case_.id}: expected ${render(case_.expect)}, engine says ${render(exception ?? value).slice(0, 120)}`,
        );
      }
    }
    evidence.push(row);
    if (!case_.binding) console.error(`${case_.id.padEnd(34)} ${verdict.padEnd(10)} ${render(exception ?? value).slice(0, 120)}`);
  }

  const bindingRows = evidence.filter((r) => "bound" in r);
  console.error(`\nbinding matrix: ${bindingRows.length} probes, ${mismatches.length} disagreeing with the contract`);
  for (const m of mismatches) console.error(`  MISMATCH  ${m}`);

  // Read the arity ladder: the smallest argument count the engine did not refuse
  // as "too few". That count is how many arguments the generated signature has to
  // require, regardless of which of them the upstream spec flags optional.
  //
  // REPORTED, NOT WRITTEN. `vendor/filters-leading-required.json` is owned by
  // `probe-filter-arity.ts`, which asks the same question of EVERY filter (#246);
  // this probe only ladders the handful in {@link SLOTTING}, so writing the file
  // from here would silently drop the rest and under-require them in codegen.
  // A disagreement below means one of the two probes needs re-running.
  const minArgs: Record<string, number> = {};
  for (const spec of SLOTTING) {
    const rungs = evidence.filter((r) => String(r.id).startsWith(`arity.${spec.name}.`));
    const accepted = rungs
      .filter((r) => !isArityError(r.exception as string | undefined))
      .map((r) => Number(String(r.id).split(".").pop()));
    minArgs[spec.name] = accepted.length ? Math.min(...accepted) : spec.full.length;
  }
  const recorded = JSON.parse(readFileSync(join(ROOT, "vendor/filters-leading-required.json"), "utf8")) as {
    minArgs: Record<string, number>;
  };
  console.error(`\nengine-required argument counts (vs vendor/filters-leading-required.json):`);
  for (const [name, k] of Object.entries(minArgs)) {
    const was = recorded.minArgs[name];
    console.error(`  ${name.padEnd(20)} ${k}${was === k ? "" : `   DIFFERS from recorded ${was ?? "(absent)"}`}`);
    if (was !== k) mismatches.push(`arity ${name}: engine requires ${k}, vendor/filters-leading-required.json records ${was ?? "nothing"}`);
  }

  writeFileSync(
    join(ROOT, "vendor/lambda-bindings.json"),
    JSON.stringify(
      {
        note:
          "Live-probed lambda binding contract, per surface, plus the evidence behind it. `contract` is what the SDK enforces and documents; `evidence` is what a real engine answered. Regenerate with `tsx scripts/probe-lambda-bindings.ts` against a sandbox — the run fails if the two disagree.",
        probedAt: new Date().toISOString().slice(0, 10),
        ambient: AMBIENT,
        contract: CONTRACT,
        agreed: mismatches.length === 0,
        mismatches,
        evidence,
      },
      null,
      2,
    ) + "\n",
  );
  console.error(`\nWrote vendor/lambda-bindings.json`);
  await client.dispose();
  if (mismatches.length) process.exit(1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
