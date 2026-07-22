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

/**
 * Envelope members whose value, when it equals the listed default, is a
 * representational artifact rather than authored data. The SDK now emits the
 * **full** persisted statement/object envelope (every member always present
 * with empty defaults); the older parser-generation fixtures omit those empties
 * entirely. Dropping a member from both sides when it holds its empty default
 * makes the two generations compare equal while still comparing any non-default
 * value (e.g. `disabled:true`, a populated `settings_registry`, `as:"user"`).
 */
function isDefaultEnvelopeMember(key: string, v: unknown): boolean {
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
function isEmptyOutput(v: unknown): boolean {
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
      // no authoring distinction. Canonicalize both empties so field comparisons
      // ignore it (a non-empty customize is preserved and still compared).
      if (k === "customize" && isEmptyCustomize(v)) {
        out[k] = "";
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
  return value;
}
