/**
 * Shared normalizer for persisted-object deep-equal. Used by both the golden
 * fixture corpus (`test/`) and the `sidestep validate` round-trip diff (KTD-2/3):
 * it strips server- and auto-generated keys the engine adds on import (which the
 * SDK never emits) so authored-field parity can be compared directly.
 *
 * This lives in `src/` (not `test/`) because `sidestep validate` is shipped code
 * built from `src/` and cannot import from `test/`; `test/helpers/normalize.ts`
 * re-exports from here so the corpus keeps a single source of truth.
 *
 * Beyond the enumerated server keys, this also drops `workspace`, `branch`, and
 * `market_item`: in a real fixture these are large server/deploy-target blobs
 * (e.g. `workspace.editBranch`), and deploy-target binding is out of scope.
 * Removing them from both sides keeps the comparison focused on authored logic.
 */
const STRIP_KEYS = new Set([
  // server columns / persistence
  "id",
  "created_at",
  "updated_at",
  "deleted_at",
  "guid",
  "_draft",
  // auto-generated xsids / runtime keys
  "_xsid",
  "@guid",
  "@index",
  "stack_id",
  "index",
  // deploy-target / market binding (deferred)
  "workspace",
  "branch",
  "market_item",
  // engine-stored source artifact (the raw XanoScript text), not authored data
  "xanoscript",
  // storage-mode flag the golden table corpus predates (those fixtures were
  // captured before `use_xdo` was serialized). The SDK always emits it; it
  // doesn't change the authored schema, so drop it from both sides — same as
  // the already-stripped `index`, whose gin entry `use_xdo` only gates.
  "use_xdo",
]);

/**
 * Recursively remove server/auto-generated keys from a parsed JSON value.
 *
 * Also coerces numeric `value` fields to strings: the golden corpus is
 * internally inconsistent about whether a `const:int`/`const:decimal` tagged
 * value serializes its `value` as a number (`10`) or a string (`"10"`) — the
 * same logical value either way. The SDK emits the documented string form
 * (`TaggedValue.value: string`); coercing here makes the comparison ignore that
 * serialization-generation artifact rather than fail on a real-equivalent value.
 */
function isEmptyObject(v: unknown): boolean {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;
}
/** True for the two interchangeable "no customization" forms: `""` and `{}`. */
function isEmptyCustomize(v: unknown): boolean {
  return v === "" || isEmptyObject(v);
}
function isEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length === 0;
}

/** Structural deep-equal for comparing an engine-default subtree to a frozen default. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const x = a as unknown[];
    const y = b as unknown[];
    return x.length === y.length && x.every((v, i) => deepEqual(v, y[i]));
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((k) => deepEqual(x[k], y[k]));
}

/**
 * Canonicalize the two interchangeable persisted timestamp serializations to a
 * single instant string. The SDK emits ISO-8601 (`2026-01-01T00:00:00Z`); the
 * engine reads it back in Postgres form (`2026-01-01 00:00:00+0000`). They are
 * the same moment — a serialization-generation artifact (Branch A), like the
 * numeric `value` coercion — so collapse both to `Date.toISOString()`. Returns
 * `undefined` for any string that is not a timestamp (left untouched).
 */
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|z|[+-]\d{2}:?\d{2})?$/;
function canonicalizeTimestamp(s: string): string | undefined {
  const m = TIMESTAMP_RE.exec(s);
  if (!m) return undefined;
  let tz = m[3] ?? "Z";
  if (tz === "z") tz = "Z";
  if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`; // +0000 → +00:00
  const d = new Date(`${m[1]}T${m[2]}${tz}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * The engine's default list-query `context.return` envelope. An addon (and any
 * db-query context) that customizes nothing has the engine fill this whole
 * subtree; the SDK omits it. Drop the key on both sides only when it deep-equals
 * this exact default (a customized paging/sort/distinct is preserved).
 */
const DEFAULT_CONTEXT_RETURN = {
  list: {
    sort: [],
    paging: { page: 1, offset: 0, totals: false, enabled: false, metadata: true, per_page: 25 },
    distinct: "auto",
  },
  type: "list",
  single: { sort: [] },
  stream: { sort: [], paging: { page: 1, enabled: false, per_page: 25 }, distinct: "auto" },
  aggregate: {
    eval: [],
    sort: [],
    group: [],
    index: [],
    paging: { page: 1, enabled: false, metadata: true, per_page: 25 },
  },
};
/** The engine's default `context.external` (paged-external input) — SDK omits it. */
const DEFAULT_CONTEXT_EXTERNAL = {
  tag: "input",
  value: "",
  permissions: { page: true, sort: true, search: true, per_page: false },
};
/** The engine's default `context.simpleExternal` (per-facet input) — SDK omits it. */
const DEFAULT_CONTEXT_SIMPLE_EXTERNAL = {
  page: { tag: "input", value: "" },
  sort: { tag: "input", value: "" },
  offset: { tag: "input", value: "" },
  search: { tag: "input", value: "" },
  per_page: { tag: "input", value: "" },
};

/**
 * Envelope members whose value, when it equals the listed default, is a
 * representational artifact rather than authored data. The SDK now emits the
 * **full** persisted statement/object envelope (every member always present
 * with empty defaults); the older parser-generation fixtures omit those empties
 * entirely. Dropping a member from both sides when it holds its empty default
 * makes the two generations compare equal while still comparing any non-default
 * value (e.g. `disabled:true`, a populated `settings_registry`, `as:"user"`).
 */
export function isDefaultEnvelopeMember(key: string, v: unknown): boolean {
  switch (key) {
    case "mocks":
      return isEmptyObject(v);
    case "runtime":
      return v === null;
    case "settings_registry":
      return v === null || isEmptyArray(v);
    case "addon":
      return isEmptyArray(v);
    case "disabled":
      return v === false;
    case "as":
    case "description":
    case "sql_name":
      return v === "";
    // Field-envelope members the engine fills with a fixed default on save. A
    // field saved by an older engine generation omits them entirely, while both
    // the current engine and the SDK always write them — the same lean-vs-full
    // generational gap as the members above, and by far the most common one in
    // the wild: nearly every field in a workspace that has not been re-saved
    // lacks `is_settings_registry`. Without these the decoder cannot prove ANY
    // authored form reproduces such a field, so every one of them degrades to a
    // descriptor literal or `rawField()` — including foreign keys, which lose
    // their `f.tableRef(table)` form and the table import with it.
    case "is_settings_registry":
    case "sensitive":
      return v === false;
    case "mode":
    case "format":
      return v === "";
    // A field's `vector.size` is only authored on a `vector` column; on every
    // other type the engine writes this exact default. Dropping it at the
    // default is symmetric, so a real `vector` column of size 3 still compares
    // equal, and any other size is preserved and still compared.
    case "vector":
      return deepEqual(v, { size: 3 });
    // Agent `agent_settings.model`: the engine persists a top-level empty
    // `model:""` (the real model lives under `configs.<provider>.model`); the SDK
    // omits the empty top-level field. Drop it on both sides when empty.
    case "model":
      return v === "";
    // Statement input-entry members: the lean parser form omits these; the full
    // persisted form carries them. Drop at their defaults (a meaningful
    // `ignore:true` on a system column, or non-empty `children`, is kept).
    case "ignore":
    case "expand":
      return v === false;
    // Expression right-operand flag: the engine schema marks it `?=false` and
    // drops it at the default on save, so the persisted form (and the SDK) omit
    // it; older parser-generation fixtures still carry `ignore_empty:false`.
    case "ignore_empty":
      return v === false;
    case "children":
      return isEmptyArray(v);
    // A value's filter chain: an empty `filters:[]` is identical to no filter
    // chain. The engine always serializes it on a nested value (e.g. a
    // `context`-nested `filename`); the SDK omits it there. Drop the empty form
    // on both sides so the representational gap doesn't fail an otherwise-equal
    // value. A non-empty chain is preserved and still compared.
    case "filters":
      return isEmptyArray(v);
    // Statement/object input-entry array: the lean parser form omits an empty
    // `input`; the full persisted form carries `input:[]`. Same generational gap
    // as the members above — an empty input array is identical to no inputs.
    // Drop the empty form on both sides; a populated `input` is preserved.
    case "input":
      return isEmptyArray(v);
    case "example":
      return isEmptyObject(v);
    case "shared_workspace":
      return v !== null && typeof v === "object" && (v as { is_shared?: unknown }).is_shared === false;
    // A trigger's `obj_id`: a table trigger's is the referenced table's GUID
    // *string* (authored, derived by the SDK, kept and compared). A workspace /
    // realtime / error trigger has no table, so the engine stores a *numeric*
    // branch/workspace reference (`1`) while the SDK emits a `0` placeholder —
    // deploy-target state, same rationale as the stripped `branch`. Drop the
    // numeric form on both sides; the guid-string form is preserved.
    case "obj_id":
      return typeof v === "number";
    // Toolset/query/function inherit-tier `history` block: when `inherit` is true
    // nothing is customized (the limit/enabled members are the inherited
    // defaults, not authored). The SDK omits it on a toolset; drop the inheriting
    // form on both sides. A customized (`inherit:false`) history is preserved.
    case "history":
      return v !== null && typeof v === "object" && (v as { inherit?: unknown }).inherit === true;
    // An MCP-server toolset persists `agent_settings:null` (only agents carry a
    // real settings block); the SDK omits it. Drop the null form.
    case "agent_settings":
      return v === null;
    // An agent's default `agent_settings.telemetry` (all providers off, empty
    // keys): the SDK omits it. Drop when telemetry is disabled.
    case "telemetry":
      return v !== null && typeof v === "object" && (v as { enabled?: unknown }).enabled === false;
    // A tool/query/function `test:[]` scaffold array — the SDK omits it on a tool;
    // an empty test list is identical to none. Drop the empty form both sides.
    case "test":
      return isEmptyArray(v);
    // A default `auth:false` (public / no auth table): the engine persists it on a
    // tool where the SDK omits it. Drop the `false` form; `auth:true` and an
    // auth-table id are preserved and still compared.
    case "auth":
      return v === false;
    // Default db-query `context` members the engine fills when an addon (or any
    // db context) customizes nothing; the SDK omits them. Empty-collection /
    // false members drop directly; the three structured members below match
    // their exact engine default (a customized context is preserved).
    case "bind":
    case "eval":
    case "sort":
      return isEmptyArray(v);
    case "future":
      return v === false;
    // Compare NORMALIZED against NORMALIZED default: normalize strips empty
    // `sort`/`eval`/`index` members from the nested subtree, so the frozen
    // default must pass through the same reduction to compare equal.
    case "lock":
      return deepEqual(normalize(v), normalize({ tag: "const:bool", value: "" }));
    case "search":
      return deepEqual(normalize(v), normalize({ expression: [] }));
    case "return":
      return deepEqual(normalize(v), normalize(DEFAULT_CONTEXT_RETURN));
    case "external":
      return deepEqual(normalize(v), normalize(DEFAULT_CONTEXT_EXTERNAL));
    case "simpleExternal":
      return deepEqual(normalize(v), normalize(DEFAULT_CONTEXT_SIMPLE_EXTERNAL));
    default:
      return false;
  }
}

/**
 * A statement/object `output` is "empty" — `{filters:[]}` (lean parser form) or
 * `{items:[],filters:[],customize:false}` (full persisted form) are the same
 * "no output customization" state. Drop the key from both sides when empty;
 * keep it (and recurse) when it carries selected `items` or `customize:true`.
 */
export function isEmptyOutput(v: unknown): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as { items?: unknown; customize?: unknown };
  const noItems = o.items === undefined || (Array.isArray(o.items) && o.items.length === 0);
  return noItems && o.customize !== true;
}

export function normalize<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => normalize(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    // A table (`dbo`) object carries a `schema` array but no `context`. Older
    // golden export fixtures store a top-level `as:<name>` on tables; live
    // `mvp_dbo` never does (a table returns nothing). Drop it on both sides.
    const isTable = "schema" in (value as object) && !("context" in (value as object));
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (STRIP_KEYS.has(k)) continue;
      if (isTable && k === "as") continue;
      // Full-envelope members at their empty default: a representational
      // artifact between the parser and persisted generations — drop on both
      // sides (see {@link isDefaultEnvelopeMember}).
      if (isDefaultEnvelopeMember(k, v)) continue;
      // `output` is an object only on statements; drop it when it carries no
      // selected items / customization (the `output:[]` array on query/function
      // envelopes is unaffected and falls through to normal handling).
      if (k === "output" && isEmptyOutput(v)) continue;
      // `customize` empty form is a serialization-generation artifact: the corpus
      // emits `{}` on some fields and `""` on others within the *same* table, with
      // no authoring distinction. Canonicalize both empties to the CURRENT form
      // — `{}`, what the engine and the SDK write today — so field comparisons
      // ignore it (a non-empty customize is preserved and still compared).
      //
      // The direction matters. Normalizing toward `""` made the legacy shape the
      // canonical one, which no authoring surface can emit; every column carrying
      // it was therefore declared unrepresentable and forced through
      // `rawField()`. Canonicalizing forward instead means a legacy column
      // decodes to the same readable `f.*` call as its modern twin, and the tree
      // re-exports the current form. `""` is a shape this SDK reads and never
      // writes.
      if (k === "customize" && isEmptyCustomize(v)) {
        out[k] = {};
        continue;
      }
      // `arg` (filter/method arguments) is numeric/string-inconsistent in the
      // corpus (`[8]` vs `["10"]`) — the same artifact as `value`; coerce the
      // numbers to the SDK's string form so the comparison ignores it.
      if (k === "arg" && Array.isArray(v)) {
        out[k] = v.map((e) => (typeof e === "number" ? String(e) : normalize(e)));
        continue;
      }
      // `value` coercion absorbs a corpus inconsistency (the SDK always emits the
      // string form; only older goldens carry the number). `temperature` is a
      // different case: the SDK's agent encoder emits a NUMBER (buildProviderConfig
      // in src/kinds/agent.ts) but the engine persists a string ("1"), so this
      // absorbs a real SDK↔engine divergence — proven for the openai golden. The
      // deeper fix is to stringify temperature in the encoder once goldens for the
      // other providers confirm the same (agent objects aren't capturable via the
      // function-only round-trip path today).
      out[k] =
        (k === "value" || k === "temperature") && typeof v === "number" ? String(v) : normalize(v);
    }
    return out as unknown as T;
  }
  // Collapse the two persisted timestamp serializations to one instant (Branch A
  // serialization artifact) — see {@link canonicalizeTimestamp}. Non-timestamp
  // strings pass through untouched.
  if (typeof value === "string") {
    const ts = canonicalizeTimestamp(value);
    if (ts !== undefined) return ts as unknown as T;
  }
  return value;
}
