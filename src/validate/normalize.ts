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
  // A query's saved request/response SAMPLE. Authored, but nothing in this SDK
  // models it, so it cannot survive a pull — the decoder reports a populated one
  // as an omission rather than letting it read as a failed round trip.
  //
  // Stripped rather than emptied because its contents are USER DATA: an example
  // payload with a key named `output` or `input` was being rewritten by the
  // engine-envelope rules meant for statement envelopes, which normalized one
  // real 700-byte sample down to `{}`.
  "example",
  // storage-mode flag the golden table corpus predates (those fixtures were
  // captured before `use_xdo` was serialized). The SDK always emits it; it
  // doesn't change the authored schema, so drop it from both sides — same as
  // the already-stripped `index`, whose gin entry `use_xdo` only gates.
  "use_xdo",
]);

/**
 * A query's saved TEST definitions — `[{id, name, input, token, expect, …}]`.
 *
 * Nothing in this SDK models them, so a populated list cannot survive a pull;
 * the decoder reports one as an omission and this drops it from the comparison,
 * so exactly one of "left behind" and "does not re-export" fires. Same treatment
 * as `example`, and stripped rather than emptied for the same reason: an
 * `expect` carries whole recorded response payloads, which are user data.
 *
 * Keyed on SHAPE, never on the name alone. `test` is one of the most generic
 * key names there is — the corpus holds table columns named `test`/`test2` and
 * const values `"test"` — so this fires only for a non-empty array whose every
 * entry carries the `expect` list a test definition is built around.
 */
function isSavedTestList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        Array.isArray((entry as { expect?: unknown }).expect),
    )
  );
}

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
/**
 * True for the interchangeable "no customization" forms: `""`, `{}`, and `[]`.
 *
 * `customize` is an associative map of column name → overrides, and an empty
 * associative collection serializes as a JSON **array** — the same artifact
 * already absorbed for `mocks` and an empty `context`. Missing the `[]` spelling
 * here was the single largest cause of `rawField()` in the sweep: 842 of 1,885
 * fields, 45% of a cluster the plan had classified as a field-authoring design
 * question rather than a canonicalization gap.
 */
function isEmptyCustomize(v: unknown): boolean {
  return v === "" || isEmptyObject(v) || isEmptyArray(v);
}
function isEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length === 0;
}
/**
 * A persisted int equal to `n`, whether serialized as a number or as a numeric
 * string. The engine types these `int` but a readback can carry either form —
 * the same artifact the tagged-`value` coercion below absorbs.
 */
function isNumber(v: unknown, n: number): boolean {
  return v === n || (typeof v === "string" && v !== "" && Number(v) === n);
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
/**
 * The four result-shape sub-blocks of {@link DEFAULT_CONTEXT_RETURN}, by member
 * name. The engine writes every one of them on every query; the SDK writes only
 * the block its `returnType` selects, so each default sibling has to drop on its
 * own once any one of them is customized.
 */
const DEFAULT_RETURN_BLOCKS: Readonly<Record<string, unknown>> = {
  list: DEFAULT_CONTEXT_RETURN.list,
  single: DEFAULT_CONTEXT_RETURN.single,
  stream: DEFAULT_CONTEXT_RETURN.stream,
  aggregate: DEFAULT_CONTEXT_RETURN.aggregate,
};

/**
 * The leanest all-defaults `context.return`: the result type at its declared
 * default with no sub-block customized. A query saved by an engine generation
 * that did not expand the whole subtree persists exactly this, and it carries no
 * more information than {@link DEFAULT_CONTEXT_RETURN} does.
 */
const MINIMAL_CONTEXT_RETURN = { type: "list" };
/**
 * Return-block paging members the engine declares `int`. A readback can carry
 * either serialization, and the number is the declared form.
 */
const PAGING_INT_KEYS = new Set(["page", "per_page", "offset"]);

/**
 * Statements whose `input[]` entries the engine reads BY NAME, so their stored
 * order carries nothing.
 *
 * Each one is on this list for two reasons: the engine resolves that statement's
 * arguments by NAME rather than by position, so a reordering cannot change what
 * it does; and real workspaces store the same entries in more than one order —
 * 3 `api_request`, and one each of the two document statements.
 *
 * This is an allowlist and must stay one. Order IS meaningful on other
 * input-routed statements — a row write's columns, and a lookup whose `input[]`
 * has to LEAD with `field_name`/`field_value` — so a blanket sort would quietly
 * corrupt them.
 */
const NAME_KEYED_INPUT = new Set([
  "mvp:create_auth",
  "mvp:api_request",
  "mvp:amazon_opensearch_document",
  "mvp:elasticsearch_document",
]);

/** An expression group that nests nothing — what an omitted group means. */
const EMPTY_SEARCH = { expression: [] };

/**
 * The inert `statement` the engine writes on an expression node whose `type` is
 * `"group"`.
 *
 * Every node carries BOTH members — `group` and `statement` — and `type` selects
 * which one is live. The engine dispatches on it in two independent walkers, and
 * neither ever reads the off-branch member: the search evaluator's
 * `case "group"` recurses into `$statement["group"]` alone, and the
 * expression-to-config converter's `case "group"` reads only
 * `$expr["group"]["expression"]`. The mirror of this is already handled — an
 * empty `group` on a `type:"statement"` node is dropped as a default (see the
 * `"group"` case in {@link isDefaultEnvelopeMember}) — and this is the missing
 * half, worth 6 `db.query` statements that fell back for carrying scaffolding.
 *
 * **Every group node's `statement` is dropped, blank or not**, because nothing
 * anywhere reads it. Five independent consumers were checked and all five
 * dispatch on `type` first: the engine's search evaluator and its
 * expression-to-config converter (every `["statement"]` read in the engine sits
 * inside a `case "statement":`), the frontend's row renderer (`@switch
 * (exp.type)`), and the frontend's own type-toggle handler, which reads the
 * GROUP's first child when converting back — never the parent's copy.
 *
 * The frontend also explains where a non-blank one comes from. Toggling a row
 * from statement to group copies the live comparison INTO the new group as its
 * first child and simply does not clear the original:
 *
 *     payload['group'] = { expression: [{ type: 'statement',
 *                                         statement: group.value.statement }] }
 *
 * So the leftover is a snapshot of the condition at the moment it was wrapped.
 * In the survey corpus 1 of 11 still matches the group's first child exactly and
 * 10 have drifted — the user kept editing the group while the frozen copy stayed
 * behind. It is editor exhaust, not authored intent: the UI renders only the
 * live branch, so whoever "wrote" it has no way to see it, edit it, or know it
 * is there.
 *
 * That is what separates this from `example` and a saved `test` list, which are
 * also unread but ARE user data and are therefore stripped rather than dropped.
 * The rule is not "never discard bytes" — it is never discard something someone
 * MEANT. A non-blank one is reported as an `expected-omission` so the discard is
 * visible; a blank one is pure scaffolding and goes quietly.
 */
export function isBlankGroupStatement(v: unknown): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const node = v as { op?: unknown; left?: unknown; right?: unknown };
  if (node.op !== "=") return false;
  const blankSide = (side: unknown): boolean =>
    side !== null &&
    typeof side === "object" &&
    (side as { tag?: unknown }).tag === "const" &&
    (side as { operand?: unknown }).operand === "";
  return blankSide(node.left) && blankSide(node.right);
}
/**
 * The per-return-type sub-blocks of a `db.query`'s `context.return`, and the
 * return types that have none.
 */
const RETURN_BLOCKS = ["single", "list", "stream", "aggregate"] as const;
const RETURN_TYPES = new Set<string>([...RETURN_BLOCKS, "count", "exists"]);

/**
 * A `context.return` reduced to its LIVE branch, or `undefined` when it is not a
 * return section or has no dead branch to shed.
 *
 * `return.type` selects one of four sub-blocks — `single`, `list`, `stream`,
 * `aggregate` (`count` and `exists` select none) — and the query editor writes
 * ALL of them on save, because the panel builds one form group over the whole
 * declared section and emits `form.value` wholesale. So a `type:"single"` query
 * still stores a fully-populated `list` block, paging and all, and a query that
 * was ever a list keeps whatever sort it had after switching away.
 *
 * Nothing reads the off-branches. The converter that turns the stored section
 * into the engine's query config is a chain of `if (returnType == "…")` arms,
 * each reading `return.<that type>.*` and nothing else; Xano's own
 * XanoScript↔stack translator likewise writes only the live block. The dead ones
 * are invisible in the editor and inert at runtime — the same editor exhaust as
 * an expression group's `statement` branch (see {@link isBlankGroupStatement}),
 * and dropped for the same reason: the rule is never discard what someone MEANT,
 * not never discard bytes.
 *
 * A dead branch that carries real configuration — a sort, a group-by, paging
 * switched on — is reported as an `expected-omission` by the decoder so the
 * discard is visible; the default-filled ones the editor writes on every save go
 * quietly, since reporting those would fire on nearly every query pulled.
 */
export function liveReturnSection(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const section = value as Record<string, unknown>;
  const type = section.type;
  if (typeof type !== "string" || !RETURN_TYPES.has(type)) return undefined;
  const dead = RETURN_BLOCKS.filter((b) => b !== type && b in section);
  if (dead.length === 0) return undefined;
  const live: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(section)) {
    if (!(RETURN_BLOCKS as readonly string[]).includes(k) || k === type) live[k] = v;
  }
  return live;
}

/**
 * A schema input's `default` blanked wherever the engine will discard it anyway.
 *
 * `convertSchemaParamToConfig` opens with, unconditionally:
 *
 * ```php
 * if ($param["required"]) { $param["default"] = null; $param["hasDefault"] = false; }
 * ```
 *
 * So on a REQUIRED input the stored `default` is thrown away before anything can
 * read it — the two spellings found in the wild (`""` from the engine's own
 * trigger templates and from this SDK, `null` from whatever wrote the realtime
 * triggers on a current instance) are the same unreachable member. 82 of the 82
 * `.input[].default` verify-mismatch rows on a live sweep were required entries.
 *
 * **Scoped to `required` for a reason, not for caution.** The very next lines are
 * `$param["default"] ??= ""` and then `if ($param["nullable"] && …) $param["default"] = null`
 * — so on an OPTIONAL input the two spellings can genuinely differ, and a blanket
 * rule would flatten a real nullable default into an empty string. Same shape,
 * opposite answer, decided by a member.
 *
 * Applied to schema descriptors only — they carry `type` and `required`. A
 * statement's `input[]` entries are `{name, tag, value}` and pass straight
 * through, and a table COLUMN never reaches here (its `default` is a real DB
 * default, and this walks `input` arrays alone).
 */
function blankInertDefaults(entry: unknown): unknown {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const e = entry as Record<string, unknown>;
  if (!("type" in e) || !("required" in e)) return entry;
  const out: Record<string, unknown> = { ...e };
  if (e["required"] === true && "default" in e) out["default"] = null;
  // An `obj` input's members go through the same conversion, recursively.
  if (Array.isArray(e["children"])) out["children"] = e["children"].map(blankInertDefaults);
  return out;
}

/**
 * A realtime event's `auth` block with an UNBOUND auth table dropped, or
 * `undefined` when there is nothing to drop.
 *
 * `mvp:realtime_event` scopes an event to one auth row via
 * `context.auth.{dbo_id,row_id}`. The editor's form materializes both members
 * always and writes `dbo_id: 0` when no table is bound; the SDK omits the member
 * entirely when no `authTable` is given. `0` is not a table — this is the same
 * "an internal row id is not portable identity" that makes `guid 0` unresolvable
 * elsewhere — so the two spellings are one state, and a bound table can never
 * collide with it.
 *
 * Evidenced three ways, which is what it takes to drop bytes:
 *   • `RealtimeEvent::process` reads `$data["auth"]["dbo_id"] ?? 0` — twice —
 *     so absent and `0` are literally the same value in the engine's own code,
 *     and it then gates the whole row lookup behind `if ($dbo_id)`;
 *   • the statement's XanoScript schema declares `auth_table?=""`, so an
 *     unbound table is the declared default rather than a missing argument; and
 *   • a live round trip (`scripts/probe-persisted-defaults.ts`) deployed the
 *     SDK's omitted spelling into a fresh tenant and exported it back
 *     unchanged — the engine does NOT materialize the member on the way in, so
 *     omitting it cannot drift a deploy → pull cycle.
 *
 * Keyed on the SHAPE, not the name: an `auth` block pairing a numeric `dbo_id`
 * with a `row_id`, and only when the id is `0`. `dbo_id` appears exactly once in
 * the 177-project corpus and only here, but scoping by shape is what keeps that
 * true if it ever appears somewhere it means something else.
 */
export function unboundAuthTable(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const block = value as Record<string, unknown>;
  if (block.dbo_id !== 0 || !("row_id" in block)) return undefined;
  const rest = { ...block };
  delete rest["dbo_id"];
  return rest;
}

/**
 * The dead `context.return` branches that carry authored configuration — a
 * non-empty `sort`/`group`/`eval`/`index`, or paging switched on. Used to report
 * what {@link liveReturnSection} drops; a branch holding only the editor's
 * defaults returns nothing.
 */
export function configuredDeadReturnBlocks(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const section = value as Record<string, unknown>;
  const type = section.type;
  if (typeof type !== "string" || !RETURN_TYPES.has(type)) return [];
  return RETURN_BLOCKS.filter((b) => b !== type && isConfiguredReturnBlock(section[b]));
}

function isConfiguredReturnBlock(block: unknown): boolean {
  if (block === null || typeof block !== "object" || Array.isArray(block)) return false;
  const b = block as Record<string, unknown>;
  for (const list of ["sort", "group", "eval", "index"]) {
    if (Array.isArray(b[list]) && (b[list] as unknown[]).length > 0) return true;
  }
  const paging = b.paging;
  return (
    paging !== null && typeof paging === "object" && (paging as { enabled?: unknown }).enabled === true
  );
}

/** The engine's default `context.external` (paged-external input) — SDK omits it. */
const DEFAULT_CONTEXT_EXTERNAL = {
  tag: "input",
  value: "",
  permissions: { page: true, sort: true, search: true, per_page: false },
};
/**
 * A `context.simpleExternal` block whose every facet binds NOTHING — the empty
 * scaffold the editor writes on a query that binds no paging facet.
 *
 * Keyed on the VALUE rather than on one frozen shape, because the scaffold has
 * more than one stored spelling: 61 across the sweep write each facet as
 * `{tag:"input", value:""}` and 3 as `{tag:"const", value:""}`. Both bind the
 * same nothing — an input named `""` does not exist, and an empty const parses
 * to nothing through the `int|min(1)` the engine declares.
 *
 * Reading the scaffold as authored was expensive out of proportion to its size:
 * five blank facets came back as five bound paging Values, and because the SDK
 * (correctly) refuses to author `external` alongside input-bound paging, the
 * recovered call did not merely mismatch — it THREW, taking the whole db.query
 * down to `raw()`. A blank facet is not a bind.
 *
 * The 4 genuinely populated blocks in the corpus keep every facet: a non-empty
 * value anywhere means the block was authored.
 */
function bindsNoPagingFacet(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const facets = Object.values(value as Record<string, unknown>);
  if (facets.length === 0) return false;
  return facets.every(
    (facet) =>
      facet !== null &&
      typeof facet === "object" &&
      !Array.isArray(facet) &&
      (facet as { value?: unknown }).value === "" &&
      ((facet as { filters?: unknown[] }).filters ?? []).length === 0,
  );
}

/**
 * The engine's default API-group CORS block — every facet off, no origins.
 *
 * Frozen here rather than imported from the encoder because this module sits
 * under the authoring layer, not above it. `test/validate/normalize.test.ts`
 * pins the literal against what the encoder emits by default, so the two cannot
 * drift apart silently.
 */
const DEFAULT_CORS = {
  mode: "default",
  allowOrigins: [],
  allowHeaders: [],
  allowCredentials: false,
  maxAge: 0,
  allowMethods: { delete: false, get: false, head: false, patch: false, post: false, put: false },
};
/** The engine's default API-group `documentation` block — docs open, no token. */
const DEFAULT_DOCUMENTATION = { require_token: false, token: "" };
/** An attachment block that attaches nothing and customizes no phase. */
const DEFAULT_MIDDLEWARE = { pre: [], post: [], pre_customize: false, post_customize: false };

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
    // An empty `mocks` arrives as `[]` from the engine and `{}` from the SDK — the
    // empty-associative-collection artifact again. Both mean "no mocks".
    case "mocks":
      return isEmptyObject(v) || isEmptyArray(v);
    // An UNSET runtime binding, in both stored spellings: the `null` the engine
    // writes on one generation and the blank-member object it writes on another
    // (`{id: "", mode: ""}` on 6 real `mvp:function` statements). A binding that
    // names anything is preserved and still compares.
    case "runtime":
      return (
        v === null ||
        (typeof v === "object" &&
          v !== null &&
          !Array.isArray(v) &&
          Object.values(v as Record<string, unknown>).every((member) => member === ""))
      );
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
    // The object-level members below are the same generational gap one level up
    // — an object saved by an older engine generation omits them, while both the
    // current engine and the SDK always write them at a fixed default. They were
    // 1,716 of the 1,744 round-trip mismatches in a 187-workspace sweep, and
    // each default is evidenced twice: the engine reads the absent key as this
    // value, and real workspaces store present-at-default and absent side by
    // side on one instance.
    case "docs":
    case "datasource":
    case "view_alias":
      return v === "";
    // An MCP tool entry's optional metadata, and the agent provider-config
    // members whose unset spelling is the empty string. Both store the empty
    // form and the absent form side by side across the corpus.
    case "tool_meta":
    case "resource_uri":
    case "alias":
    case "baseURL":
    case "safetySettings":
    case "dynamicRetrievalConfig":
    case "apiKey":
      return v === "";
    // `headers` is an empty STRING on an unset agent config and a string[] on an
    // api_request statement — dropping only the string spelling leaves an empty
    // header list comparing as the authored value it is.
    case "headers":
      return v === "";
    // A tool entry's kind. Absent means `tool`; a `resource` or `prompt` entry
    // says so and still compares. Value-distinct from the other `type`
    // discriminators (an expression node, a column type), none of which is `tool`.
    case "type":
      return v === "tool";
    // Four stored spellings of "no thinking budget" across 16 real configs: the
    // empty string, absent, and the block with its budget as either `0` or `""`.
    case "thinkingConfig":
      return (
        v === "" ||
        (typeof v === "object" &&
          v !== null &&
          !Array.isArray(v) &&
          (v as Record<string, unknown>)["includeThoughts"] === false &&
          ((v as Record<string, unknown>)["thinkingBudget"] === 0 ||
            (v as Record<string, unknown>)["thinkingBudget"] === ""))
      );
    // A query with no declared response type. Type- and value-distinct from the
    // raw-SQL `response_type`, whose values are `list`/`single`/`count` and
    // whose own default (`list`) is spelled differently.
    case "response_type":
      return v === "standard";
    // Empty list members. `tag` is the load-bearing one: it is also the
    // discriminator every tagged value carries, so the rule is restricted to the
    // ARRAY spelling — a `tag: "const:str"` is a string and never matches.
    case "tag":
    case "views":
    case "result":
      return isEmptyArray(v);
    // Two API-group gates with opposite defaults, each the value the engine
    // falls back to when the key is absent: a group serves unless disabled,
    // documentation is off unless turned on.
    case "api_group_enabled":
      return v === true;
    case "swagger":
      return v === false;
    case "documentation":
      return deepEqual(normalize(v), normalize(DEFAULT_DOCUMENTATION));
    // A CORS block is applied ONLY when its `mode` is `"custom"` — the engine
    // reads an absent mode as `""`, which is not custom — so a block that does
    // not say `custom` configures nothing.
    //
    // Two spellings therefore mean the same default. The current one says
    // `mode: "default"`; an older one predates `mode` entirely and carries
    // `enabled: false`, a key that request path never reads.
    case "cors": {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
      const block = { ...(v as Record<string, unknown>) };
      if (block["enabled"] === false) delete block["enabled"];
      block["mode"] ??= "default";
      return deepEqual(normalize(block), normalize(DEFAULT_CORS));
    }
    // Both stored spellings of "no middleware": the engine hands an empty
    // associative map back as a JSON array, the same artifact already absorbed
    // for `mocks`, `customize` and an empty `context`. A phase explicitly
    // customized to run nothing still compares — that is not inheriting.
    case "middleware":
      return isEmptyArray(v) || deepEqual(normalize(v), normalize(DEFAULT_MIDDLEWARE));
    // Two unrelated `offset`s, both at a default. An addon's is the response path
    // its rows are spliced into, `""` when spliced at the root. A list context's
    // paging offset is declared to default to 0. Neither carries information at
    // its default; any other value is preserved.
    case "offset":
      return v === "" || isNumber(v, 0);
    // Return-block paging members, each at its declared default. Type-distinct
    // from their same-named neighbours in a permissions block (`page: true`,
    // `per_page: false`), which are booleans and so untouched.
    case "page":
      return isNumber(v, 1);
    case "per_page":
      return isNumber(v, 25);
    case "metadata":
      return v === true;
    case "totals":
      return v === false;
    case "distinct":
      return v === "auto";
    // `s.setheader`'s duplicate-handling mode. The engine declares it
    // `duplicates?=replace` and reads it as `($data["duplicates"] ?? "replace")`,
    // so an absent key IS "replace"; 3 real statements omit it against 8 that
    // store it present-at-default. The key appears on no other statement.
    case "duplicates":
      return v === "replace";
    // A return sub-block whose every member sat at a default. These are checked
    // against their NORMALIZED form because the member rules above are what empty
    // them — without this the block survives as `{}` and the whole return envelope
    // never collapses, which is the only reason it matters.
    //
    // `list` also names a foreach's iterated value; a tagged value never
    // normalizes to empty, so that one is untouched.
    //
    // `enabled:false` is the one member no rule above empties, deliberately — it
    // is meaningful on a history block, so it cannot be dropped by name. It IS
    // droppable here, where the key says the block is paging: 7 real db.query
    // statements omit `paging` outright against 149 that store it present at
    // `enabled:false`, and the two spellings mean the same thing.
    //
    // Evidenced twice before being trusted. Every engine consumer reads the flag
    // as `["paging"]["enabled"] ?? false`, so an absent block IS a disabled one,
    // and the serializer returns before writing anything when it is off — a
    // disabled block emits no source at all. The siblings are provably inert
    // meanwhile: every read of `page`/`per_page`/`offset`/`metadata` sits behind
    // that same gate.
    //
    // Still narrow: this fires only once every OTHER member has normalized away.
    // A disabled block that customizes something (`{enabled:false, per_page:50}`)
    // keeps both and compares as itself.
    case "paging": {
      const normalized = normalize(v);
      return isEmptyObject(normalized) || deepEqual(normalized, { enabled: false });
    }
    // The same four blocks, plus the residue the member rules above cannot reach.
    //
    // The engine writes ALL FOUR result-shape blocks on every query; the SDK writes
    // only the one its `returnType` selects. Emptiness alone does not collapse a
    // default sibling, because two of its members have no rule that empties them —
    // the paging `enabled:false` gate and an aggregate's empty `group`/`index`
    // lists. So one customized `per_page` left every default sibling mismatching,
    // and a paged query could never verify.
    //
    // Deep-equality against each block's own frozen default is what reaches those
    // members WITHOUT a global rule on their generic names — `enabled:false` is
    // meaningful on a history block, and an empty `group` is a condition default
    // elsewhere. A block with anything authored inside it still compares.
    case "list":
    case "single":
    case "stream":
    case "aggregate":
      return (
        isEmptyObject(normalize(v)) ||
        deepEqual(normalize(v), normalize(DEFAULT_RETURN_BLOCKS[key]))
      );
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
    // `input`; the full persisted form carries `input:[]`; and the engine writes
    // `input:null` for a statement that takes no inputs at all. All three are the
    // same "no inputs" state — the SDK emits the `[]` spelling, so without the
    // null arm every input-less statement in a pulled workspace fails to prove
    // and degrades to `raw()`. Drop all three on both sides; a populated `input`
    // is preserved. Same two-spellings-of-empty shape as `settings_registry`.
    case "input":
      return v === null || isEmptyArray(v);
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
      // An ARRAY is not a settings block — it is the engine's own record of past
      // runs, which the generated tree deliberately does not carry. Dropping it
      // from both sides is what stops that deliberate omission ALSO reading as a
      // failed round trip; the two mean opposite things and an object must not
      // report both.
      return (
        Array.isArray(v) ||
        (v !== null && typeof v === "object" && (v as { inherit?: unknown }).inherit === true)
      );
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
    // `false` and `""` are both "no auth table"; a guid names one and compares.
    case "auth":
      return v === false || v === "";
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
    // A condition container that holds nothing, in either stored spelling: the
    // `{expression: []}` the SDK writes and the empty associative-map form `[]`
    // the engine hands back — the same artifact already absorbed for `mocks`,
    // `customize` and an empty `context`. Both mean "no condition configured".
    // A populated container is untouched and still compares node for node.
    case "expr":
      return (
        isEmptyArray(v) ||
        (v !== null &&
          typeof v === "object" &&
          isEmptyArray((v as { expression?: unknown }).expression))
      );
    case "search":
      return deepEqual(normalize(v), normalize({ expression: [] }));
    // Two spellings of an all-defaults return block. The engine's declared shape
    // defaults the result type to a list and leaves every sub-block optional, so
    // a query that customizes nothing persists either the whole subtree (when the
    // engine filled it on save) or nothing but the type — and the SDK omits it
    // entirely. Accept both, and preserve any customized paging/sort/distinct.
    case "return":
      return (
        deepEqual(normalize(v), normalize(DEFAULT_CONTEXT_RETURN)) ||
        deepEqual(normalize(v), MINIMAL_CONTEXT_RETURN)
      );
    // A condition entry's nested group. The engine declares it optional with no
    // default, so an entry that nests nothing omits the key while the SDK
    // materializes an empty search. Same state; drop the empty form on both
    // sides. A group that actually nests expressions is preserved and compared.
    case "group":
      return deepEqual(normalize(v), EMPTY_SEARCH);
    // A condition entry's or-flag, declared to default false: the persisted form
    // omits it at the default where the SDK writes it.
    case "or":
      return v === false;
    // Generated-asset visibility, declared to default public wherever it appears.
    case "access":
      return v === "public";
    // A precondition's error class, declared to default to the standard error.
    case "error_type":
      return v === "standard";
    case "external":
      return deepEqual(normalize(v), normalize(DEFAULT_CONTEXT_EXTERNAL));
    case "simpleExternal":
      return bindsNoPagingFacet(v);
    default:
      return false;
  }
}

/**
 * A statement/object `output` is "empty" — `null` (what the engine writes for a
 * statement that shapes no result), `{filters:[]}` (lean parser form), and
 * `{items:[],filters:[],customize:false}` (full persisted form) are all the same
 * "no output customization" state. Drop the key from both sides when empty;
 * keep it (and recurse) when it carries selected `items` or `customize:true`.
 *
 * The `null` arm matters for the same reason as `input:null`: the SDK emits the
 * full form, so without it every result-less statement in a pulled workspace
 * fails its re-encode proof and degrades to `raw()`.
 */
export function isEmptyOutput(v: unknown): boolean {
  if (v === null) return true;
  if (typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as { items?: unknown; customize?: unknown };
  const noItems = o.items === undefined || (Array.isArray(o.items) && o.items.length === 0);
  return noItems && o.customize !== true;
}

/** An `@` target naming a table by local row id (`dbo=14`) rather than by guid. */
const LOCAL_DBO_REF = /^dbo=\d+$/;

/**
 * Rewrite every LOCAL table reference in a `customize` subtree to the unbound
 * spelling, and report which targets were cleared.
 *
 * A per-column override inside `customize` can carry an `@` table reference, and
 * an old engine version did not remap those to portable guids on export the way
 * it does everywhere else. What is left is a row id in the SOURCE workspace,
 * naming whatever happens to hold that id anywhere else — not identity, the same
 * conclusion {@link isBoundNumericId} reaches for a numeric reference generally.
 *
 * The decoder clears them so a pulled tree carries no confidently-wrong
 * reference, and the comparison applies the same rewrite so that deliberate
 * change does not ALSO read as a failed round trip. One implementation, used
 * from both sides, because two copies of this rule would drift.
 */
export function clearLocalDboRefs<T>(value: T, cleared?: Set<string>): T {
  if (Array.isArray(value)) {
    return value.map((item) => clearLocalDboRefs(item, cleared)) as unknown as T;
  }
  if (value === null || typeof value !== "object") return value;
  const next = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, member]) => [
      key,
      clearLocalDboRefs(member, cleared),
    ]),
  ) as { name?: unknown; arg?: unknown };
  if (next.name === "@" && Array.isArray(next.arg)) {
    const target = next.arg[0];
    if (typeof target === "string" && LOCAL_DBO_REF.test(target)) {
      cleared?.add(target);
      return { ...next, arg: ["dbo=", ...next.arg.slice(1)] } as unknown as T;
    }
  }
  return next as unknown as T;
}

/**
 * Statements whose `context` **IS** their tagged value, and the `tag` each one's
 * engine schema declares as that value's default.
 *
 * For all of these the engine declares every context member
 * optional-with-a-default and fills the absent ones: `filters` is a list and so
 * defaults to `[]`, `value` is declared `text` whose type default is `""`, and
 * `tag` defaults to the value below. An empty `context` therefore resolves to a
 * blank value of that tag — the same statement as one storing those members
 * explicitly. It is a second stored spelling, not a shape no authoring surface
 * can produce.
 *
 * **The tag is per-statement and MUST be read, never assumed.** Most default to
 * `const`, but the `UpdateVarBase` family overrides it per subclass — arithmetic
 * to `const:decimal`, the bitwise ops and `math_mod` to `const:int`,
 * `array_merge` to `const:array` — and `die` and `setheader` default to **input**,
 * a blank input reference rather than a constant. Assuming `const` across the
 * family would have mis-decoded five of them; this is the same trap invariant 2
 * names, where `swagger` and `api_group_enabled` are structurally identical and
 * default opposite ways.
 *
 * `named` marks the statements whose context also carries the target variable's
 * `name` (the `UpdateVarBase` family routes it there, declared `text` and so
 * also defaulting to `""`). `set_var` is not one of them — its name rides the
 * envelope `as` — and `die`/`sleep`/`setheader` have no name at all. The fill has
 * to match what the encoder writes for the recovered record, and the encoder
 * writes `name: ""` for exactly the `named` ones.
 *
 * Evidenced twice, as a default must be. The engine's optional-schema pass
 * supplies each member when the key is absent, AND real workspaces store both
 * spellings side by side — per statement, not just in aggregate: 101 `set_var`
 * carry a blank const explicitly against 18 that store nothing, and every
 * statement below has exactly one empty instance alongside its populated ones.
 *
 * Then settled on a live engine (`scripts/probe-empty-setvar.ts`), because a
 * source trace is not a behaviour: the two spellings deployed into two fresh
 * tenants bind the same value. That probe also showed the engine PERSISTS
 * whichever spelling it is handed rather than canonicalizing, so a pulled
 * workspace that stored `{}` re-exports as the EXPLICIT form — the bytes change,
 * deliberately, and the live probe is what licenses changing them at all.
 */
const EMPTY_CONTEXT_FILL: ReadonlyMap<string, { tag?: string; named: boolean }> = new Map([
  // Its name rides the envelope `as`, so the context is the value alone.
  ["mvp:set_var", { tag: "const", named: false }],
  // Standalone classes, each declaring its own default tag.
  ["mvp:sleep", { tag: "const:int", named: false }],
  ["mvp:die", { tag: "input", named: false }],
  ["mvp:setheader", { tag: "input", named: false }],
  // `array_pop`/`array_shift` carry NO `tag`, because they take no operand:
  // popping or shifting reads nothing, their specs route no spread field, and
  // the encoder writes `name` alone. The fill must be exactly what the encoder
  // writes — filling a value they cannot author invents members the comparison
  // then demands forever, which is what shipped once when they were given the
  // full `UpdateVarBase` treatment below.
  //
  // A name-only fill is a different claim from that one, and it is evidenced
  // twice on the engine, both times on the SCALAR `name`:
  //   • the statement's own XanoScript schema declares `name?='': context.name`
  //     — the default for an absent name IS the empty string; and
  //   • `UpdateVarBase::getContextSchema` declares `name: text` and runs it
  //     through the same `XS::optional` pass that licenses every entry here.
  //
  // That second point is exactly where the loops failed (see
  // {@link LOOP_EMPTY_ITERAND}): `XS::optional` materializes a SCALAR member but
  // defaults a NESTED object to the literal string `"{}"`. `name` is a scalar,
  // `list`/`cnt` are not, and the shape is what decides. The engine's own
  // statement-transform corpus stores `{"context":{}}` for `mvp:array_shift`.
  ["mvp:array_pop", { named: true }],
  ["mvp:array_shift", { named: true }],
  // The `UpdateVarBase` family: `{name, value, tag, filters}`, `tag` overridden
  // per subclass by `getDefaultTag()`. `test/codegen/spec-inverse` asserts every
  // entry's members against the spec catalog so the two cannot drift.
  ["mvp:update_var", { tag: "const", named: true }],
  ["mvp:array_merge", { tag: "const:array", named: true }],
  ["mvp:array_push", { tag: "const", named: true }],
  ["mvp:array_unshift", { tag: "const", named: true }],
  ["mvp:bitwise_and", { tag: "const:int", named: true }],
  ["mvp:bitwise_or", { tag: "const:int", named: true }],
  ["mvp:bitwise_xor", { tag: "const:int", named: true }],
  ["mvp:math_add", { tag: "const:decimal", named: true }],
  ["mvp:math_sub", { tag: "const:decimal", named: true }],
  ["mvp:math_mul", { tag: "const:decimal", named: true }],
  ["mvp:math_div", { tag: "const:decimal", named: true }],
  ["mvp:math_mod", { tag: "const:int", named: true }],
  ["mvp:text_append", { tag: "const", named: true }],
  ["mvp:text_prepend", { tag: "const", named: true }],
  ["mvp:text_trim", { tag: "const", named: true }],
  ["mvp:text_ltrim", { tag: "const", named: true }],
  ["mvp:text_rtrim", { tag: "const", named: true }],
  ["mvp:text_starts_with", { tag: "const", named: true }],
  ["mvp:text_istarts_with", { tag: "const", named: true }],
  ["mvp:text_ends_with", { tag: "const", named: true }],
  ["mvp:text_iends_with", { tag: "const", named: true }],
  ["mvp:text_contains", { tag: "const", named: true }],
  ["mvp:text_icontains", { tag: "const", named: true }],
]);

/**
 * A loop whose iterand is ABSENT, and the empty iterand it is REPAIRED to.
 *
 * **What the engine's optional-schema pass does and does not fill**, since this
 * keeps coming up and the answer is not uniform. `XS::optional` walks a context
 * schema and, for each absent member:
 *
 *  - SCALAR (`value: text`, `response_type?=list`) → filled with the type's
 *    default. This is why {@link EMPTY_CONTEXT_FILL} works.
 *  - LIST (`arg[]`, `filters[]`) → filled with `[]`.
 *  - NESTED OBJECT (`list:`, `cnt:`, `connection_string_flex:`) → defaulted to
 *    the literal STRING `"{}"`, which materializes nothing. The statement class
 *    then reads the key directly and faults.
 *
 * So "the schema declares a default" is not enough — the member's SHAPE decides.
 * Two clusters were mis-read on that: the loops below, and the raw-SQL family,
 * whose empty contexts look fillable until you notice `connection_string_flex`
 * is a nested object with nothing to recover.
 *
 * This is not a default the engine supplies — that was checked, and it does not.
 * `ForEachLoop`/`ForLoop` declare `list`/`cnt` as nested `{value, tag?=…,
 * filters[]}` objects with default tags and run them through the same
 * `XS::optional` pass that makes {@link EMPTY_CONTEXT_FILL} correct one level
 * up, but `XS::optional` defaults a nested object to the literal string `"{}"`
 * rather than materializing its members, and the statement classes read the key
 * directly. A live engine (`scripts/probe-empty-context.ts`) confirmed it:
 * `foreach` raises "For Each Loop: missing list argument" and `for` faults on
 * `Undefined array key "cnt"`.
 *
 * So the stored form is BROKEN — the key went missing on the way out, an empty
 * value that did not survive serialization — and 9 real statements carry it.
 * The repair gives each the benign reading of the empty value it lost: an empty
 * list, and a zero count. Both are no-ops, which is the closest a working loop
 * gets to one that cannot run.
 *
 * **This EVALUATES DIFFERENTLY and is reported as `modernized` at every site**,
 * exactly like a blank `const:obj` becoming `c.obj()`: the stored form throws at
 * runtime and the repaired form iterates nothing. That report is the whole
 * licence for it — silently turning a fault into a no-op would hide a real
 * defect in the source workspace.
 */
const LOOP_EMPTY_ITERAND: ReadonlyMap<string, { member: string; value: string; tag: string }> =
  new Map([
    ["mvp:foreach", { member: "list", value: "[]", tag: "const:array" }],
    ["mvp:for", { member: "cnt", value: "0", tag: "const:int" }],
  ]);

/** A blank value at `tag` — what the engine's optional-schema pass materializes. */
function blankValue(tag: string): Record<string, unknown> {
  return { value: "", tag, filters: [] };
}

/**
 * The `context` the engine's optional-schema pass would produce for `stored`,
 * or null when this statement has no such fill.
 *
 * Two cases, and they are NOT the same kind of thing:
 *
 *  - {@link EMPTY_CONTEXT_FILL} — the whole context IS the value and the engine
 *    genuinely supplies the members. Byte-changing but behaviour-preserving.
 *  - {@link LOOP_EMPTY_ITERAND} — the iterand went missing and the engine does
 *    NOT supply it. This is a REPAIR that evaluates differently, and every site
 *    is reported as `modernized` by the loop decoder.
 *
 * The decoder reads this to recover the value, and the comparison reads it so
 * the recovered statement's explicit re-encode still matches the sparse stored
 * spelling. One implementation, used from both sides, because two copies of this
 * rule would drift and the drift would be invisible.
 */
export function filledContext(stored: unknown): Record<string, unknown> | null {
  if (stored === null || typeof stored !== "object") return null;
  const { name, context } = stored as { name?: unknown; context?: unknown };
  if (typeof name !== "string") return null;

  const whole = EMPTY_CONTEXT_FILL.get(name);
  if (whole) {
    // All three empty spellings: `{}` from the SDK, `[]` from the engine's
    // serializer, and `null` from a current engine.
    const empty =
      context === null ||
      (Array.isArray(context) && context.length === 0) ||
      (typeof context === "object" && Object.keys(context).length === 0);
    if (!empty) return null;
    // No tag means no operand — the fill is the name alone.
    if (whole.tag === undefined) return { name: "" };
    return whole.named ? { name: "", ...blankValue(whole.tag) } : blankValue(whole.tag);
  }

  const loop = LOOP_EMPTY_ITERAND.get(name);
  if (loop) {
    if (context === null || typeof context !== "object" || Array.isArray(context)) return null;
    const block = context as Record<string, unknown>;
    if (block[loop.member] !== undefined) return null;
    return { ...block, [loop.member]: { value: loop.value, tag: loop.tag, filters: [] } };
  }
  return null;
}

export function normalize<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => normalize(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    // A `const:obj` stored blank (`value:""` or `value:null`) is the empty
    // object written by an older editor generation; today it writes `{}`, and
    // that is the only form this SDK emits. Canonicalize forward so the two
    // compare equal — same rule as `customize`, and the reason a decoded blank
    // object can come back as `c.obj()` and still round-trip. The decoder
    // reports every such site under `modernized`, because unlike `customize`
    // this one does change what the value evaluates to.
    const blankObj =
      (value as { tag?: unknown }).tag === "const:obj" &&
      "value" in (value as object) &&
      ((value as { value?: unknown }).value === "" ||
        (value as { value?: unknown }).value === null);
    // A table (`dbo`) object carries a `schema` array but no `context`. Older
    // golden export fixtures store a top-level `as:<name>` on tables; live
    // `mvp_dbo` never does (a table returns nothing). Drop it on both sides.
    const isTable = "schema" in (value as object) && !("context" in (value as object));
    // `mvp:create_auth` stores its four named entries in two different orders —
    // `dbtable, extras, expiration, id` on 21 of 25 real statements and
    // `id, dbtable, extras, expiration` on the other 4 — and the SDK can only
    // write one of them. Ordering them by name on BOTH sides makes the two
    // spellings compare equal.
    //
    // Scoped to this one statement, and only because a live round trip settled
    // it: both orders mint a token, and the engine persists whichever order it
    // is handed rather than canonicalizing. The entries are named parameters, so
    // position carries nothing — but that is a fact about this statement, not a
    // licence to sort `input[]` anywhere else, where order IS meaningful (a row
    // write's columns, a lookup's leading field_name/field_value).
    const sortsInput = NAME_KEYED_INPUT.has((value as { name?: unknown }).name as string);
    // A sparse context — empty, or missing a loop's iterand — is one spelling of
    // the members the engine's optional-schema pass supplies. Substitute them so
    // that spelling compares equal to the explicit one (see {@link filledContext}).
    const contextFill = filledContext(value);
    // An expression node whose live branch is the nested group: its `statement`
    // member is scaffolding the engine never reads (see
    // {@link isBlankGroupStatement}).
    const isGroupNode = (value as { type?: unknown }).type === "group";
    // A middleware attachment block, identified by its own flags rather than by
    // the generic names `pre`/`post`. A phase list is read ONLY when its
    // `_customize` flag is set — the engine's resolver returns it on that branch
    // and otherwise falls through to the parent tier without looking at the list
    // — so a list sitting behind an off flag is an editor leftover the engine
    // never runs, and compares equal to the empty list the SDK writes.
    const isMiddlewareBlock =
      "pre_customize" in (value as object) || "post_customize" in (value as object);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (STRIP_KEYS.has(k)) continue;
      if (isTable && k === "as") continue;
      if (k === "test" && isSavedTestList(v)) continue;
      if (isGroupNode && k === "statement") continue;
      if (
        isMiddlewareBlock &&
        (k === "pre" || k === "post") &&
        (value as Record<string, unknown>)[`${k}_customize`] !== true
      ) {
        continue;
      }
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
      // A populated customize: clear any LOCAL table reference inside it before
      // comparing, matching the decoder's own rewrite (see
      // {@link clearLocalDboRefs}). Scoped to this subtree — a numeric reference
      // at FIELD level is a different, already-settled case that stays verbatim.
      if (k === "customize") {
        out[k] = normalize(clearLocalDboRefs(v));
        continue;
      }
      // An empty `context` arrives as `[]` from the engine and `{}` from the SDK:
      // an empty associative collection serializes as a JSON array, so the two
      // are the same "no context" state with no authoring distinction.
      // Canonicalize forward to `{}` — the form the SDK writes — so the split
      // does not fail an otherwise-equal statement, and so the `context.*` rules
      // below always see one shape.
      //
      // Scoped to `context` deliberately. A blanket array→object coercion would
      // corrupt every genuinely-empty list in the envelope.
      if (k === "input" && Array.isArray(v)) {
        // A required input's `default` is discarded by the engine before anything
        // reads it, so its two stored spellings are one state (see
        // {@link blankInertDefaults}). Applied to every input array; the sort
        // below is the separate, statement-scoped rule.
        const entries = v.map(blankInertDefaults);
        out[k] = (
          sortsInput
            ? [...entries].sort((a, b) =>
                String((a as { name?: unknown })?.name ?? "").localeCompare(
                  String((b as { name?: unknown })?.name ?? ""),
                ),
              )
            : entries
        ).map((entry) => normalize(entry));
        continue;
      }
      // A `context.return` keeps only the branch its `type` selects; the editor
      // writes all four and the engine reads one (see {@link liveReturnSection}).
      if (k === "return") {
        const live = liveReturnSection(v);
        if (live) {
          out[k] = normalize(live);
          continue;
        }
      }
      // An `auth` block naming no table: `dbo_id: 0` is the editor's spelling of
      // the member the SDK omits (see {@link unboundAuthTable}).
      if (k === "auth") {
        const unbound = unboundAuthTable(v);
        if (unbound) {
          out[k] = normalize(unbound);
          continue;
        }
      }
      if (k === "context" && contextFill) {
        out[k] = normalize(contextFill);
        continue;
      }
      // `null` is the THIRD spelling of no-context, alongside the `[]` and `{}`
      // above. It does not appear anywhere in the 177-project corpus — that
      // instance is old — and turned up on a current one under `mvp:create_auth`,
      // whose `getContextSchema()` returns the empty list outright: the statement
      // has no context to hold, so every empty spelling of it is the same
      // nothing. Canonicalize to `{}` with the others, or the statement loses its
      // readability to a key the engine never reads.
      if (k === "context" && (isEmptyArray(v) || v === null)) {
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
      // A paging int persisted as a numeric STRING. These coerce toward the NUMBER,
      // the opposite direction to `value`/`arg` above, because that is what each
      // form declares: a tagged `value` is a string, `page`/`per_page`/`offset` are
      // ints. Same artifact, canonicalized toward the declared type in both cases.
      //
      // The default-holding forms already reconcile via `isNumber`; this is for a
      // CUSTOMIZED one, where a stored `"10"` against an encoded `10` cost 11
      // `db.query` statements their readability.
      //
      // An addon's `offset` shares the key name and holds a response PATH
      // (`"items[]"`), which is not a numeric string and so passes through — the
      // same coexistence the two `offset` rules already rely on.
      if (PAGING_INT_KEYS.has(k) && typeof v === "string" && /^-?\d+$/.test(v)) {
        out[k] = Number(v);
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
      if (k === "value" && blankObj) {
        out[k] = "{}";
        continue;
      }
      // A tagged `value` is declared a STRING (`TaggedValue.value`), and the engine
      // persists a `const:bool` either way — `value: false` and `value: "false"` are
      // the same authored boolean. Coerced for the same reason as the numeric form
      // directly above, and it is what a stored `context.lock` costs otherwise: 25
      // `db.query` statements degraded to `raw()` over the spelling of one flag.
      //
      // Only `true`/`false` under a `value` key. A boolean anywhere else keeps its
      // type and is still compared.
      // `operand` is the same tagged value under the name a COMPARISON gives it
      // (`statement.left` / `statement.right`), and the corpus is inconsistent
      // there for the same reason: a real workspace stores `const:int` `0` as the
      // number while the SDK writes the documented string.
      //
      // Leaving it out was a silent hole rather than a missing nicety. The
      // decoders hand `prove` the STORED value object as the factory argument, so
      // a re-encode reproduces the number and the proof passes — while the source
      // it emits says `c.int(0)`, which encodes `"0"`. The proof therefore could
      // not see a difference that `verify` (comparing a real re-export) reports.
      out[k] =
        (k === "value" || k === "operand" || k === "temperature") &&
        (typeof v === "number" || typeof v === "boolean")
          ? String(v)
          : normalize(v);
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
