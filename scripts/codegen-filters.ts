/**
 * Filter-catalog codegen. XanoScript values carry a `filters[]` pipeline (the
 * `value | to_upper | concat:","` chain); this generates a typed, discoverable
 * authoring surface `fl.*` over it so every filter is reachable by name and the
 * well-specified ones carry named, typed arguments.
 *
 * Two-stage, like the statement codegen:
 *   1. `--refresh` distills the three upstream sources of truth into the
 *      committed `vendor/filters.json` (offline snapshot):
 *        - the language server's filter-name list — the full set of ~365 filter
 *          names applicable to a variable (authoritative membership);
 *        - the language server's hover docs — one-line descriptions;
 *        - the engine's filter schema — structured arg metadata (named/typed
 *          args, result, group) for the ~49 it documents richly.
 *      Each is located by its own env var; there are no defaults, because the
 *      layout of those checkouts is not this repo's to record.
 *   2. always: emit `src/values/generated/filters.generated.ts` from that JSON.
 *
 * Run:
 *   npm run codegen:filters            # regenerate the TS from vendor/filters.json
 *   npm run codegen:filters -- --refresh   # re-distill upstream → vendor/filters.json, then emit
 *
 * Reproducible: same vendor JSON → identical TS (filters sorted by name).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const VENDOR = join(ROOT, "vendor/filters.json");
// The empirically-probed runtime allowlist (issue #106). The distilled catalog
// (filterNames.js ∪ pipe.yaml ∪ aggregate.yaml) is the LSP's "names applicable to
// a variable" — it lumps in operators, aggregates, type-methods, and db.query
// filters that 500 (`Unable to locate func entry`) in a value `filters[]` pipeline
// on a deployed endpoint. This file lists only the names a real engine actually
// resolves at runtime; membership is intersected against it. Regenerate via
// `tsx scripts/probe-filters.ts` against a sandbox.
const RESOLVABLE = join(ROOT, "vendor/filters-resolvable.json");
// The empirically-probed optional-arg overrides. Upstream marks a `path` arg
// required on 20 filters; a real engine runs 9 of them with no argument at all.
// Regenerate via `tsx scripts/probe-optional-path.ts` against a sandbox.
const OPTIONAL_ARGS = join(ROOT, "vendor/filters-optional-args.json");
// The empirically-probed argument COUNTS for filters whose spec marks a LEADING
// argument optional. An optional argument cannot be omitted positionally when a
// required one follows it — the next argument slides into its slot and the
// engine refuses the call — so the first `minArgs` arguments are emitted as
// required whatever the spec's flags say. Regenerate via
// `tsx scripts/probe-lambda-bindings.ts` against a sandbox. See issue #221.
const LEADING_REQUIRED = join(ROOT, "vendor/filters-leading-required.json");
const OUT = join(ROOT, "src/values/generated/filters.generated.ts");

const NAMES_SRC = process.env.XANO_FILTER_NAMES ?? "";
const DOCS_SRC = process.env.XANO_FILTER_DOCS ?? "";
const YAML_SRC = process.env.XANO_FILTER_YAML ?? "";
// The value pipeline draws typed metadata from three sibling catalogs that share
// filter.yaml's exact shape (`group`/`result`/`arg[]`). filter.yaml documents ~49
// richly; pipe.yaml (~222) and aggregate.yaml (~13) cover the long tail. On the
// names they share, filter.yaml wins (it is the curated, frontend-facing set).
const PIPE_SRC = process.env.XANO_PIPE_YAML ?? "";
const AGG_SRC = process.env.XANO_AGGREGATE_YAML ?? "";

/** A structured argument of a richly-specified filter. */
interface FilterArg {
  name: string;
  type: string;
  /** True when the arg may be omitted (has an upstream `default`, or its
   * description is flagged `optional`). Omitted when required. */
  optional?: boolean;
  /** The exact accepted spellings, for an enumerated arg (see {@link ARG_ENUMS}). */
  enum?: string[];
}
/** The distilled spec for one filter. */
interface FilterSpec {
  /** Structured args (from filter.yaml) — present only for richly-specified filters. */
  args?: FilterArg[];
  /** Result type (from filter.yaml). */
  result?: string;
  /** Group (from filter.yaml), e.g. `timestamp`, `vector`. */
  group?: string;
  /** One-line description (from filters.md or filter.yaml). */
  description?: string;
}
/** The committed catalog snapshot. */
interface FilterCatalog {
  names: string[];
  specs: Record<string, FilterSpec>;
}

// --- distillation (--refresh) -------------------------------------------------

/** Parse the exported `filterNames` array, skipping `//`-commented (deprecated) entries. */
function parseNames(src: string): string[] {
  const names: string[] = [];
  for (const line of src.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) continue; // deprecated / comment
    const m = trimmed.match(/^"([a-zA-Z0-9_]+)"\s*,?$/);
    if (m) names.push(m[1]);
  }
  return names;
}

/** Extract `# name` → first prose line from the hover-docs markdown. */
function parseDocs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const blocks = src.split(/^# /m).slice(1);
  for (const block of blocks) {
    const lines = block.split("\n");
    const name = lines[0].trim();
    const desc = lines.slice(1).find((l) => l.trim().length > 0);
    if (name && desc) out[name] = desc.trim();
  }
  return out;
}

/**
 * Purpose-built reader for filter.yaml — a flat map of `name:` → 2-space block
 * with `group`/`result`/`description` scalars and `arg:` (a list of `- name:/type:`
 * maps). Avoids a YAML dependency; the file's shape is regular.
 */
function parseFilterYaml(src: string): Record<string, FilterSpec> {
  const out: Record<string, FilterSpec> = {};
  let cur: string | null = null;
  let spec: FilterSpec | null = null;
  let inArgs = false;
  let pendingArg: Partial<FilterArg> | null = null;

  const flushArg = () => {
    if (pendingArg?.name && pendingArg.type && spec) {
      const arg: FilterArg = { name: pendingArg.name, type: pendingArg.type };
      if (pendingArg.optional) arg.optional = true;
      (spec.args ??= []).push(arg);
    }
    pendingArg = null;
  };
  const flush = () => {
    flushArg();
    if (cur && spec) out[cur] = spec;
  };

  for (const raw of src.split("\n")) {
    if (!raw.trim()) continue;
    const top = raw.match(/^([a-zA-Z0-9_]+):\s*$/);
    if (top) {
      flush();
      cur = top[1];
      spec = {};
      inArgs = false;
      continue;
    }
    if (!spec) continue;
    if (/^ {2}arg:\s*$/.test(raw)) {
      inArgs = true;
      continue;
    }
    const scalar = raw.match(/^ {2}(group|result|display|description):\s*(.+?)\s*$/);
    if (scalar) {
      inArgs = false;
      flushArg();
      const [, key, val] = scalar;
      if (key === "group") spec.group = val;
      else if (key === "result") spec.result = val;
      else if (key === "description") spec.description = val;
      continue;
    }
    if (/^ {2}entry:\s*$/.test(raw)) {
      inArgs = false;
      continue;
    }
    if (inArgs) {
      // An arg is optional when it carries an upstream `default`, or its
      // description is flagged `optional` (the two ways pipe.yaml/filter.yaml
      // signal it). `default`/`description` ride at a deeper indent than the
      // 2-space top-level scalars, so they only reach here, inside an arg.
      const argName = raw.match(/^\s*-\s*name:\s*(.+?)\s*$/);
      const argType = raw.match(/^\s*type:\s*(.+?)\s*$/);
      const argDefault = raw.match(/^\s*default:\s*(.+?)\s*$/);
      const argDesc = raw.match(/^\s*description:\s*(.+?)\s*$/);
      if (argName) {
        flushArg();
        pendingArg = { name: argName[1] };
      } else if (argType && pendingArg) {
        pendingArg.type = argType[1];
      } else if (argDefault && pendingArg) {
        pendingArg.optional = true;
      } else if (argDesc && pendingArg && /^optional\b/i.test(argDesc[1])) {
        pendingArg.optional = true;
      }
    }
  }
  flush();
  return out;
}

function refresh(): FilterCatalog {
  for (const [label, p] of [
    ["filter names", NAMES_SRC],
    ["filter docs", DOCS_SRC],
    ["filter yaml", YAML_SRC],
    ["pipe yaml", PIPE_SRC],
    ["aggregate yaml", AGG_SRC],
  ] as const) {
    if (!existsSync(p)) throw new Error(`--refresh: ${label} source not found: ${p}`);
  }
  const names = parseNames(readFileSync(NAMES_SRC, "utf8"));
  const docs = parseDocs(readFileSync(DOCS_SRC, "utf8"));
  const aggSpecs = parseFilterYaml(readFileSync(AGG_SRC, "utf8"));
  const pipeSpecs = parseFilterYaml(readFileSync(PIPE_SRC, "utf8"));
  const filterSpecs = parseFilterYaml(readFileSync(YAML_SRC, "utf8"));

  // Merge the three typed catalogs; later spreads win, so filter.yaml takes
  // precedence over pipe.yaml over aggregate.yaml on shared names.
  const yaml: Record<string, FilterSpec> = { ...aggSpecs, ...pipeSpecs, ...filterSpecs };

  // Value-pipeline membership. filterNames.js is the LSP's authoritative set of
  // filters applicable to a variable; pipe.yaml and aggregate.yaml are the value
  // pipeline's own catalogs, so their names count too. filter.yaml, however, is
  // the *db.query* filter catalog (SQL-generating filters like `array_length`,
  // `vector_*`, `epochms_*`) — a different runtime registry that does NOT back
  // the value `filters[]` pipeline this surface targets. It enriches typed args
  // for names already in the pipeline, but must NOT introduce new ones: a value
  // pipeline calling e.g. `fl.array_length` type-checks and exports but 500s at
  // runtime ("Unable to locate func entry"). See issue #46.
  const all = new Set<string>(names);
  for (const n of Object.keys(aggSpecs)) all.add(n);
  for (const n of Object.keys(pipeSpecs)) all.add(n);

  const specs: Record<string, FilterSpec> = {};
  for (const name of all) {
    const y = yaml[name];
    const spec: FilterSpec = {};
    if (y?.args?.length) spec.args = y.args;
    if (y?.result) spec.result = y.result;
    if (y?.group) spec.group = y.group;
    const desc = docs[name] ?? y?.description;
    if (desc) spec.description = desc;
    if (Object.keys(spec).length) specs[name] = spec;
  }
  return { names: [...all].sort(), specs };
}

// --- emission -----------------------------------------------------------------

/** JS reserved words that are valid yaml arg names but illegal TS parameter identifiers. */
const RESERVED = new Set([
  "default", "function", "class", "return", "new", "var", "let", "const", "case",
  "in", "of", "delete", "void", "typeof", "if", "else", "for", "while", "do",
  "switch", "break", "continue", "this", "super", "import", "export", "extends",
  "instanceof", "throw", "try", "catch", "finally", "yield", "await", "enum",
]);

/** Sanitize a yaml arg name into a valid, unique TS identifier. */
function paramName(raw: string, used: Set<string>): string {
  let id = raw.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^(\d)/, "_$1");
  if (!id) id = "arg";
  if (RESERVED.has(id)) id = `${id}_`;
  let name = id;
  let n = 1;
  while (used.has(name)) name = `${id}${++n}`;
  used.add(name);
  return name;
}

/**
 * Curated pipe-direction notes (issue #22). Several text filters disagree on
 * what the PIPED value means vs the named argument, and getting it backwards
 * silently inverts the check with no type or runtime error — a real
 * correctness/security hazard for a guard. The arg names already encode it
 * (`search` = needle to look for, `subject` = text operated on), but only if you
 * know the convention, so spell it out at the call site. Lives here (not in the
 * vendor JSON) so `--refresh` can't clobber it. See {@link jsdoc}.
 */
const PIPE_DIRECTION_NOTES: Record<string, string> = {};
for (const n of ["contains", "icontains", "starts_with", "istarts_with", "ends_with", "iends_with"]) {
  PIPE_DIRECTION_NOTES[n] = "Direction: the piped value is the subject text; the argument is the substring searched for.";
}
for (const n of [
  "regex_test",
  "regex_match",
  "regex_match_all",
  "regex_matches",
  "regex_replace",
  "regex_get_all_matches",
  "regex_get_first_match",
]) {
  PIPE_DIRECTION_NOTES[n] =
    "Direction: the piped value is the regex PATTERN; the `subject` argument is the text tested against it — reversed vs starts_with/contains. Build the pattern with c.regex(...) (delimiter-wrapped); a bare c.text(...) is rejected.";
}

/**
 * Descriptions that REPLACE the upstream one rather than adding to it (issue
 * #245).
 *
 * The pipe-direction notes above append, because upstream's sentence is merely
 * incomplete. These filters' upstream descriptions are *false*, and appending a
 * correction to a false sentence leaves the false sentence in `manifest.json`
 * and `llms.txt` for an agent to read first. `transform`'s upstream text —
 * "Processes an expression with local data bound to the $this variable" — names
 * a binding that does not exist on that path: a live probe
 * (`vendor/transform-expression.json`) has `$this` resolving to null, while the
 * operand arrives as `$0`. That one word is what issue #245 was reported from.
 *
 * Lives here (not in the vendor JSON) so `--refresh` cannot clobber it. Carries
 * no issue number or file path: these strings ship into `manifest.json` and
 * `llms.txt`, which `test/manifest/llms-no-opinion.test.ts` keeps free of
 * dev-process references. The provenance lives in `src/values/expression-arg.ts`.
 */
const DESCRIPTION_OVERRIDES: Record<string, string> = {
  transform:
    "Evaluates a Xano Expression Engine expression over the piped value. NOT a JavaScript body — there is no `return`, " +
    "and the piped value binds POSITIONALLY as `$0` (or `$$`), NOT as `$this` (which resolves to null here, yielding a " +
    "wrong answer with no error). `$var`, `$input`, `$env` and `$auth` also resolve, and filters may be piped inside " +
    "the expression: `$0 * 2`, `$0|sort|join:\",\"`, `{ id: $0.id, total: $0.qty * $0.price }`. PARENTHESIZE a pipe " +
    "used inside an object/array literal — `{ s: ($0|sort|join:\",\") }` — or the filter argument's comma is read as " +
    "the key separator, returning null and silently dropping every later key. For JavaScript use fl.lambda, whose " +
    "body does bind `$this`.",
  to_expr:
    "Treats the PIPED TEXT as Xano Expression Engine source, evaluates it, and returns the result. Takes no argument. " +
    "`$var`, `$input`, `$env` and `$auth` resolve inside it; there is no operand binding (`$0` is null) because the " +
    "operand IS the source. For an expression OVER a value, use fl.transform.",
};

/**
 * Bare scalars are accepted for EVERY filter argument (#229, superseding the
 * path-only coercion of #76).
 *
 * The narrow version of this took only a `path` argument, and only a string.
 * That is what made it a problem: `fl.get("count")` worked on the first try, so
 * an author learned "bare literals are fine here" — and then `fl.get("a.b", 0)`
 * failed to typecheck, on the SAME call, for the argument next to the one that
 * just worked. An asymmetry teaches a rule, and this one taught a false one.
 *
 * So the rule is now uniform and statable in one line: **anywhere a filter takes
 * a `Value`, a bare `string`, `number` or `boolean` is accepted and wrapped.**
 * Objects and arrays are NOT — `c.obj`/`c.array` carry a deliberate type-level
 * diagnostic the audit singled out as worth keeping, and swallowing them here
 * would route around it.
 *
 * Coercion keys on the RUNTIME type rather than the upstream declared type, so
 * the wrapper is exactly what the author would have typed by hand: a string
 * becomes `c.text`, an integral number `c.int`, any other number `c.decimal`, a
 * boolean `c.bool`. That makes this a pure TYPING change — a `Value` argument
 * still passes through untouched, and no currently-valid call changes a byte.
 * The conformance corpus asserts exactly that.
 *
 * Lives here (not in vendor JSON) so `--refresh` cannot clobber it.
 */

/**
 * Curated argument ENUMS — the exact set of spellings a filter's own
 * implementation branches on, keyed `<filter>.<arg>`.
 *
 * `fsort`'s `type` is why this exists (#198). Its comparator switch has five
 * arms and the `default:` arm falls through to `itext`, so every spelling
 * outside the set — `"decimal"`, `"int"`, anything — sorts case-insensitively
 * as TEXT and silently returns the wrong order. That is the failure the audit
 * hit: a "top N by score/distance/recency" endpoint built the natural way is
 * wrong, with no error anywhere. Only `"number"` compares numerically.
 *
 * Typing the argument as the literal union refuses the lying spellings where an
 * author writes them, at compile time, rather than asserting anything about
 * what the engine accepts — it accepts all of them, which is the whole problem.
 * `c.text("decimal")` still compiles, because it is still a `Value`; that is the
 * same deliberate escape hatch `raw()` is, and it is also what lets a pulled
 * workspace holding one round-trip instead of becoming un-exportable (the
 * lesson from the middleware `input` flip).
 *
 * The set is read off the engine's filter implementation, not probed: a probe
 * can only show which spellings behave differently, and four of these five are
 * string sorts that differ only in case-folding and numeric-substring handling.
 */
const ARG_ENUMS: Readonly<Record<string, readonly string[]>> = {
  "fsort.type": ["text", "itext", "natural", "inatural", "number"],
};

/**
 * Filter → the lambda surface its `code` argument runs at, so the emitted
 * signature can type an INLINE body (`fl.map(({ $this }) => …)`) with exactly
 * that surface's bindings. Mirrors `LAMBDA_CODE_FILTERS` in
 * `src/values/lambda.ts`, which is what the runtime guard reads; a test asserts
 * the two agree, and the emitted surface is what makes the author not have to
 * name one.
 */
const LAMBDA_SURFACES: Readonly<Record<string, string>> = {
  lambda: "fl.lambda",
  map: "map",
  filter: "filter",
  some: "some",
  every: "every",
  find: "find",
  findIndex: "findIndex",
  reduce: "reduce",
};

/**
 * Fold the curated pipe-direction notes into each affected filter's
 * `description`. Done here (rather than only in the emitted JSDoc) so the note
 * rides `FILTER_SPECS` into the manifest and `llms.txt` too — the agent that hit
 * this had to open `manifest.json` to disambiguate, so that surface is exactly
 * where the hint belongs. Returns a new specs map; the input is left untouched.
 */
function withDirectionNotes(specs: Record<string, FilterSpec>): Record<string, FilterSpec> {
  const out: Record<string, FilterSpec> = {};
  for (const [name, spec] of Object.entries(specs)) {
    // An override REPLACES; a note APPENDS. See {@link DESCRIPTION_OVERRIDES}.
    const override = DESCRIPTION_OVERRIDES[name];
    if (override !== undefined) {
      out[name] = { ...spec, description: override };
      continue;
    }
    const note = PIPE_DIRECTION_NOTES[name];
    out[name] = note
      ? { ...spec, description: spec.description ? `${spec.description} ${note}` : note }
      : spec;
  }
  return out;
}

/**
 * Clear the `optional` flag on every argument the engine actually requires, so
 * `FILTER_SPECS` — which is what `manifest.json` and `llms.txt` describe the
 * surface from — says the same thing the generated signature enforces. Without
 * this the docs would keep advertising `fl.reduce`'s `initial_value` as omittable
 * while the type refuses to omit it, which is the same wrong fact #221 started
 * from, in a different place.
 */
function withEngineRequired(specs: Record<string, FilterSpec>): Record<string, FilterSpec> {
  const out: Record<string, FilterSpec> = {};
  for (const [name, spec] of Object.entries(specs)) {
    if (!spec.args?.length) {
      out[name] = spec;
      continue;
    }
    const required = requiredCount(name, spec.args);
    out[name] = {
      ...spec,
      args: spec.args.map((a, i) => {
        if (i >= required || !a.optional) return a;
        const rest: FilterArg = { ...a };
        delete rest.optional;
        return rest;
      }),
    };
  }
  return out;
}

function jsdoc(spec: FilterSpec | undefined): string {
  const parts: string[] = [];
  if (spec?.description) parts.push(spec.description);
  const tail: string[] = [];
  if (spec?.group) tail.push(`group: ${spec.group}`);
  if (spec?.result) tail.push(`result: ${spec.result}`);
  if (tail.length) parts.push(`(${tail.join(", ")})`);
  const text = parts.join(" ");
  return text ? `/** ${text.replace(/\*\//g, "*\\/")} */ ` : "";
}

/**
 * How many leading arguments each filter REQUIRES, per the engine.
 *
 * The upstream spec's `optional` flag describes what an argument means, not
 * whether the call can leave it out: `fl.reduce`'s `initial_value` is flagged
 * optional and sits in front of the required `code`, so `fl.reduce(code)` used to
 * type-check and put the code in the initial-value slot (issue #221). Positional
 * omission is only ever possible from the END, so a probed count of what the
 * engine actually accepts is the authority here.
 */
function leadingRequired(): Record<string, number> {
  if (!existsSync(LEADING_REQUIRED)) return {};
  return (JSON.parse(readFileSync(LEADING_REQUIRED, "utf8")) as { minArgs: Record<string, number> }).minArgs;
}
const MIN_ARGS = leadingRequired();

/** Index of the first argument that may be omitted — everything before it is required. */
function requiredCount(name: string, args: FilterArg[]): number {
  const firstOptional = args.findIndex((a) => a.optional);
  return Math.max(MIN_ARGS[name] ?? 0, firstOptional === -1 ? args.length : firstOptional);
}

/** The authored type of one argument (an enumerated arg narrows to its members). */
function argType(name: string, a: FilterArg): string {
  const members = ARG_ENUMS[`${name}.${a.name}`];
  // An enumerated arg narrows the string half of `Scalar` to the exact members;
  // numbers and booleans are dropped from it, since a comparator mode is never
  // one of those.
  if (members) return `${members.map((m) => JSON.stringify(m)).join(" | ")} | Value`;
  // A lambda filter's `code` argument also takes the body itself, typed for THIS
  // filter's surface — so the bindings autocomplete from the call site and a
  // binding from another surface is a compile error, with no surface named by
  // hand (issue #221).
  const surface = a.name === "code" ? LAMBDA_SURFACES[name] : undefined;
  return surface ? `Scalar | Value | LambdaBody<${JSON.stringify(surface)}>` : "Scalar | Value";
}

function emitFactory(name: string, spec: FilterSpec | undefined): string {
  const doc = jsdoc(spec);
  if (spec?.args?.length) {
    const used = new Set<string>();
    const required = requiredCount(name, spec.args);
    const params: string[] = [];
    const fields: string[] = [];
    const names: string[] = [];
    for (const [i, a] of spec.args.entries()) {
      const pn = paramName(a.name, used);
      names.push(pn);
      const optional = i >= required;
      const type = argType(name, a);
      params.push(`${pn}${optional ? "?" : ""}: ${type}`);
      fields.push(`${pn}${optional ? "?" : ""}: ${type}`);
    }
    // Two call forms over one implementation. Positional keeps the short call
    // short; the named form is unambiguous for a filter with several arguments,
    // which is where the slot of any one of them is hardest to see. A variadic
    // tail rides the positional form so filters the yaml under-specifies (e.g.
    // variadic `concat`) still accept extra arguments.
    const positional = `(${params.join(", ")}, ...rest: (Scalar | Value)[]) => FilterXdo`;
    const named = `(args: { ${fields.join("; ")} }) => FilterXdo`;
    // The named form keys on the same sanitized identifiers the positional
    // parameters use, so one filter has one spelling per argument.
    const argNames = JSON.stringify(names);
    return `  ${JSON.stringify(name)}: ${doc}slotted(${JSON.stringify(name)}, ${argNames}, ${required}) as ((${positional}) & (${named})),`;
  }
  return `  ${JSON.stringify(name)}: ${doc}(...args: (Scalar | Value)[]): FilterXdo => filter(${JSON.stringify(name)}, ...args.map(v)),`;
}

/**
 * Attach the curated {@link ARG_ENUMS} members to the emitted `FilterSpec`, so
 * `manifest.json` and `llms.txt` can print the accepted set instead of the bare
 * word "enum" — which is what they printed before, and it is why the audit had
 * to discover the members by trying seven spellings against a live engine.
 */
function withArgEnums(specs: Record<string, FilterSpec>): Record<string, FilterSpec> {
  const out: Record<string, FilterSpec> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const args = spec.args?.map((a) => {
      const members = ARG_ENUMS[`${name}.${a.name}`];
      return members ? { ...a, enum: [...members] } : a;
    });
    out[name] = args ? { ...spec, args } : spec;
  }
  return out;
}

function emit(cat: FilterCatalog): string {
  const specs = withEngineRequired(withArgEnums(withDirectionNotes(cat.specs)));
  const requiredCounts: Record<string, number> = {};
  for (const name of cat.names) {
    const args = specs[name]?.args;
    const required = args?.length ? requiredCount(name, args) : 0;
    if (required > 0) requiredCounts[name] = required;
  }
  const factories = cat.names.map((n) => emitFactory(n, specs[n])).join("\n");
  const typedCount = cat.names.filter((n) => specs[n]?.args?.length).length;
  const imports = "{ filter, c, isTaggedValue }";
  const lambdaImports = "{ LAMBDA_CODE_FILTERS, toLambdaValue }";
  const coerceHelper = [
    "",
    "/** A bare JS literal a filter argument accepts in place of a {@link Value}. */",
    "export type Scalar = string | number | boolean;",
    "",
    "/**",
    " * Wrap a bare scalar as the constant an author would have written by hand;",
    " * pass a {@link Value} through, and an OMITTED argument straight back out.",
    " *",
    " * Keyed on the RUNTIME type, so the emitted tag matches the explicit form",
    " * exactly — `fl.get(\"a.b\", 0)` and `fl.get(c.text(\"a.b\"), c.int(0))` encode to",
    " * the same bytes (#229). Integral numbers take `const:int` and the rest",
    " * `const:decimal`, which is the split `c.int`/`c.decimal` already make.",
    " *",
    " * Undefined is reached in normal use: several filters take an argument the",
    " * engine accepts as absent (see vendor/filters-optional-args.json), and",
    " * `filter()` drops it, producing the empty arg list a real workspace stores.",
    " */",
    "const v = (x?: Scalar | Value): Value | undefined => {",
    '  if (typeof x === "string") return c.text(x);',
    '  if (typeof x === "number") return Number.isInteger(x) ? c.int(x) : c.decimal(x);',
    '  if (typeof x === "boolean") return c.bool(x);',
    "  return x;",
    "};",
    "",
    "/**",
    " * One implementation behind a filter's two call forms: positional, or a single",
    " * object of named arguments.",
    " *",
    " * The named form exists because a positional slot is invisible at the call site",
    " * (issue #221): `fl.reduce(code)` reads fine and puts the code in the",
    " * initial-value slot. Naming the argument makes the slot impossible to get",
    " * wrong, and it is the only readable form for the four-argument crypto filters.",
    " *",
    " * The two are told apart by what the first argument IS — a tagged value or a",
    ' * bare scalar is positional; a plain object is the named form. `c.obj({…})`',
    " * returns a tagged value, so an object-valued ARGUMENT is never mistaken for an",
    " * argument object.",
    " */",
    "const slotted =",
    "  (name: string, argNames: readonly string[], required: number) =>",
    "  (...args: unknown[]): FilterXdo => {",
    "    // An inline body resolves against the surface THIS filter runs at — the",
    "    // call site knows it, so the author does not restate it.",
    "    const surface = LAMBDA_CODE_FILTERS[name]?.surface;",
    "    const body = (x: unknown): unknown =>",
    "      surface === undefined ? x : toLambdaValue(x as Value, surface, `fl.${name}`);",
    "    const first = args[0];",
    "    const isNamed =",
    "      args.length === 1 &&",
    "      typeof first === \"object\" &&",
    "      first !== null &&",
    "      !Array.isArray(first) &&",
    "      !isTaggedValue(first);",
    "    if (!isNamed) {",
    "      const supplied = args.map(body) as (Scalar | Value | undefined)[];",
    "      assertArity(name, argNames, required, supplied.filter((a) => a !== undefined).length);",
    "      return filter(name, ...supplied.map(v));",
    "    }",
    "    const named = Object.fromEntries(",
    "      Object.entries(first as Record<string, unknown>).map(([k, x]) => [k, body(x)]),",
    "    ) as Record<string, Scalar | Value | undefined>;",
    "    // A hole in the NAMED form has its own message: the positional advice",
    "    // (\"use the named form\") would be useless to someone already using it.",
    "    const last = argNames.reduce((acc, n, i) => (named[n] !== undefined ? i : acc), -1);",
    "    const hole = argNames.slice(0, last).findIndex((n) => named[n] === undefined);",
    "    if (hole !== -1) {",
    "      throw new Error(",
    "        `fl.${name}: \\`${argNames[hole]}\\` is omitted but \\`${argNames[last]}\\` is supplied. Filter arguments are ` +",
    "          `positional even in this form — the engine reads them by slot, so one in the middle cannot be skipped. ` +",
    "          `Supply \\`${argNames[hole]}\\` too. (issue #221)`,",
    "      );",
    "    }",
    "    assertArity(name, argNames, required, last + 1);",
    "    return filter(name, ...argNames.map((n) => v(named[n])));",
    "  };",
    "",
    "/**",
    " * Refuse a call with fewer arguments than the engine requires (issue #221).",
    " *",
    " * The signature already says so, but a JavaScript caller — or an `any` that",
    " * erased the type — reaches the same factory, and the engine's own answer to a",
    " * short call is an argument-count error at runtime, on a deployed endpoint.",
    " */",
    "const assertArity = (name: string, argNames: readonly string[], required: number, got: number): void => {",
    "  if (got >= required) return;",
    "  throw new Error(",
    "    `fl.${name} needs ${required} argument(s) — ${argNames.slice(0, required).join(\", \")} — but got ${got}. ` +",
    "      `Filter arguments are positional and the engine refuses a short call, so a missing one cannot be inferred ` +",
    "      `— not even where the filter's own documentation calls it optional, because omission only works from the ` +",
    "      `END. (issue #221)`,",
    "  );",
    "};",
    "",
  ].join("\n");
  return `/**
 * AUTO-GENERATED by scripts/codegen-filters.ts — DO NOT EDIT BY HAND.
 *
 * Typed authoring surface for the value \`filters[]\` pipeline. Each \`fl.<name>\`
 * returns a {@link FilterXdo} to drop into {@link withFilters}; ${typedCount} of the
 * ${cat.names.length} filters carry named, typed arguments (from the engine's
 * filter/pipe/aggregate schema), the rest are variadic by
 * name. Regenerate with
 * \`npm run codegen:filters\` (\`-- --refresh\` to re-distill upstream).
 */
import ${imports} from "../value.js";
import type { Value } from "../value.js";
import ${lambdaImports} from "../lambda.js";
import type { LambdaBody } from "../lambda.js";
import type { FilterXdo } from "../../types/xdo.js";
${coerceHelper}
/** Distilled metadata for a filter (from the engine's filter/pipe/aggregate schema + LSP docs). */
export interface FilterSpec {
  args?: Array<{ name: string; type: string; optional?: boolean; enum?: string[] }>;
  result?: string;
  group?: string;
  description?: string;
}

/** Every filter name applicable to a value pipeline (authoritative membership). */
export const FILTER_NAMES: readonly string[] = ${JSON.stringify(cat.names)};

/** Per-filter metadata (only filters the sources document); drives agent grounding. */
export const FILTER_SPECS: Readonly<Record<string, FilterSpec>> = ${JSON.stringify(specs)};

/**
 * How many leading arguments each filter REQUIRES — the count a real engine
 * accepts, which is not always what the spec's \`optional\` flags imply (issue
 * #221). The generated signatures enforce it; codegen reads it to tell a stored
 * call it can rebuild from one it must carry through verbatim.
 */
export const FILTER_REQUIRED_ARGS: Readonly<Record<string, number>> = ${JSON.stringify(requiredCounts)};

/** Typed, discoverable constructors for the value \`filters[]\` pipeline. */
export const fl = {
${factories}
} as const;
`;
}

// --- main ---------------------------------------------------------------------

/**
 * Mark the args a real engine accepts as ABSENT, though upstream declares them
 * required (`vendor/filters-optional-args.json`).
 *
 * Same argument as the resolvability allowlist below, one level down: upstream
 * says what a filter advertises, execution says what it accepts, and where they
 * disagree the engine wins. Nine array filters take a `path` selecting a member
 * inside each element — `fsort`'s own description calls it optional — and the
 * engine runs all nine with no argument at all, defaulting to the element
 * itself. The yaml marks the arg required anyway.
 *
 * This is not cosmetic. A pulled workspace stores `filter_null` with `arg: []`,
 * so codegen faithfully emits `fl.filter_null()` — which did not type-check
 * against the generated signature, and the whole generated tree failed to
 * compile because of it.
 *
 * Deliberately a probed FILE rather than a hand-written list: the same probe
 * proves the other eleven (`set`, `get`, `unset`, `index_by`, `array_remove`, …)
 * genuinely throw "Too few arguments", and those keep their required arg.
 */
function relaxOptionalArgs(catalog: FilterCatalog): FilterCatalog {
  if (!existsSync(OPTIONAL_ARGS)) return catalog;
  const { optional } = JSON.parse(readFileSync(OPTIONAL_ARGS, "utf8")) as {
    optional: Record<string, string[]>;
  };
  let relaxed = 0;
  for (const [name, argNames] of Object.entries(optional)) {
    const spec = catalog.specs[name];
    if (!spec?.args) continue;
    for (const arg of spec.args) {
      if (argNames.includes(arg.name) && arg.optional !== true) {
        arg.optional = true;
        relaxed += 1;
      }
    }
  }
  if (relaxed > 0) console.log(`Relaxed ${relaxed} engine-optional arg(s) upstream marks required.`);
  return catalog;
}

/**
 * Intersect the distilled catalog against the empirical runtime allowlist
 * (issue #106): drop every name the engine can't resolve in a value pipeline, so
 * the generated `fl.*`, manifest, and llms.txt only ever advertise names a
 * deployed endpoint actually resolves. The two vendored sources stay independent
 * — `filters.json` records what upstream advertises, `filters-resolvable.json`
 * what runtime resolves — and the generated surface is their intersection.
 */
function reconcile(catalog: FilterCatalog): FilterCatalog {
  catalog = relaxOptionalArgs(catalog);
  const { resolvable } = JSON.parse(readFileSync(RESOLVABLE, "utf8")) as { resolvable: string[] };
  const allow = new Set(resolvable);
  const names = catalog.names.filter((n) => allow.has(n));
  const dropped = catalog.names.filter((n) => !allow.has(n));
  const specs: Record<string, FilterSpec> = {};
  for (const [n, s] of Object.entries(catalog.specs)) if (allow.has(n)) specs[n] = s;
  // A resolvable name the catalog never distilled is a coverage gap worth seeing
  // (the allowlist knows a filter the upstream sources don't) — surface, don't drop.
  const missing = resolvable.filter((n) => !catalog.names.includes(n));
  if (dropped.length) console.log(`Dropped ${dropped.length} non-resolvable filters: ${dropped.join(", ")}`);
  if (missing.length) console.log(`NOTE: ${missing.length} resolvable name(s) absent from the distilled catalog: ${missing.join(", ")}`);
  return { names, specs };
}

const doRefresh = process.argv.includes("--refresh");
let catalog: FilterCatalog;
if (doRefresh) {
  catalog = refresh();
  writeFileSync(VENDOR, JSON.stringify(catalog, null, 2) + "\n");
  console.log(`Refreshed ${VENDOR}: ${catalog.names.length} filters, ${Object.keys(catalog.specs).length} with specs.`);
} else {
  catalog = JSON.parse(readFileSync(VENDOR, "utf8")) as FilterCatalog;
}
catalog = reconcile(catalog);
writeFileSync(OUT, emit(catalog));
const typed = catalog.names.filter((n) => catalog.specs[n]?.args?.length).length;
console.log(`Wrote ${OUT}: ${catalog.names.length} filters (${typed} typed).`);
