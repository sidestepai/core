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
    "Direction: the piped value is the regex PATTERN; the `subject` argument is the text tested against it — reversed vs starts_with/contains. Build the pattern with c.regex(...) (delimiter-wrapped); a bare c.text(...) is rejected (issue #128).";
}

/**
 * Curated path-arg coercion (issue #76). The object-manipulation filters
 * (`set`, `get`, `has`, `unset`, `append`, `index_by`, … — 20 in all) take a
 * static key path argument, uniformly named `path` and typed `text` upstream.
 * Typing it as a bare `Value` forces `fl.get(c.text("count"))` where
 * `fl.get("count")` reads naturally. Every such arg accepts `string | Value`
 * and coerces a bare string to `c.text` in the factory body — mirroring how
 * `api.request` fields (`url`, `method`, …) already accept literals. This is a
 * pure widening (`Value` → `string | Value`), so no existing caller breaks and
 * no byte output changes for currently-valid code. Keyed on the invariant arg
 * NAME rather than a per-filter allowlist, so a new path-taking filter is
 * covered automatically. Lives here (not in vendor JSON) so `--refresh` can't
 * clobber it. See {@link emitFactory} and {@link emit}.
 */
const PATH_ARG_NAMES = new Set(["path"]);
const takesCoercedPath = (arg: FilterArg): boolean => PATH_ARG_NAMES.has(arg.name);

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
    const note = PIPE_DIRECTION_NOTES[name];
    out[name] = note
      ? { ...spec, description: spec.description ? `${spec.description} ${note}` : note }
      : spec;
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

function emitFactory(name: string, spec: FilterSpec | undefined): string {
  const doc = jsdoc(spec);
  if (spec?.args?.length) {
    const used = new Set<string>();
    // Optional args (upstream `default`/`optional`) emit `name?: Value`; once one
    // arg is optional every following arg is too (TS requires it). `filter()`
    // drops omitted (undefined) args, so `fl.trim()` is valid and serializes clean.
    let sawOptional = false;
    const params: string[] = [];
    const callArgs: string[] = [];
    for (const a of spec.args) {
      const pn = paramName(a.name, used);
      sawOptional = sawOptional || !!a.optional;
      // A path arg accepts a bare string and is coerced to c.text in the body
      // (issue #76); every other arg stays a plain `Value`.
      const isPath = takesCoercedPath(a);
      params.push(`${pn}${sawOptional ? "?" : ""}: ${isPath ? "string | Value" : "Value"}`);
      callArgs.push(isPath ? `coercePath(${pn})` : pn);
    }
    // Named args for discoverability + a variadic tail so filters the yaml
    // under-specifies (e.g. variadic `concat`) still accept extra arguments.
    return `  ${JSON.stringify(name)}: ${doc}(${params.join(", ")}, ...rest: Value[]): FilterXdo => filter(${JSON.stringify(name)}, ${callArgs.join(", ")}, ...rest),`;
  }
  return `  ${JSON.stringify(name)}: ${doc}(...args: Value[]): FilterXdo => filter(${JSON.stringify(name)}, ...args),`;
}

function emit(cat: FilterCatalog): string {
  const specs = withDirectionNotes(cat.specs);
  const factories = cat.names.map((n) => emitFactory(n, specs[n])).join("\n");
  const typedCount = cat.names.filter((n) => specs[n]?.args?.length).length;
  // Only pull in `c` + the coercion helper when a path-coercing filter is present,
  // so an unused import can never leak into the generated file (issue #76).
  const hasPathCoerce = cat.names.some((n) => specs[n]?.args?.some(takesCoercedPath));
  const imports = hasPathCoerce ? "{ filter, c }" : "{ filter }";
  const coerceHelper = hasPathCoerce
    ? [
        "",
        "/**",
        " * Coerce a bare string path to a text constant; pass a {@link Value} through",
        " * (issue #76), and an OMITTED one straight back out.",
        " *",
        " * Nine filters take a path argument the engine accepts as absent (see",
        " * vendor/filters-optional-args.json), so this is reached with undefined —",
        " * which filter() then drops, producing the empty arg list a real workspace",
        " * stores.",
        " */",
        "const coercePath = (path?: string | Value): Value | undefined =>",
        '  typeof path === "string" ? c.text(path) : path;',
        "",
      ].join("\n")
    : "";
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
import type { FilterXdo } from "../../types/xdo.js";
${coerceHelper}
/** Distilled metadata for a filter (from the engine's filter/pipe/aggregate schema + LSP docs). */
export interface FilterSpec {
  args?: Array<{ name: string; type: string; optional?: boolean }>;
  result?: string;
  group?: string;
  description?: string;
}

/** Every filter name applicable to a value pipeline (authoritative membership). */
export const FILTER_NAMES: readonly string[] = ${JSON.stringify(cat.names)};

/** Per-filter metadata (only filters the sources document); drives agent grounding. */
export const FILTER_SPECS: Readonly<Record<string, FilterSpec>> = ${JSON.stringify(specs)};

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
