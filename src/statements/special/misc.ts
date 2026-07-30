/**
 * Hand-authored miscellaneous specials (U10) — the remaining `!class` /
 * `!function` / declarative statements without a generated factory: array
 * map/union, the comment & placeholder nodes, raw-input access, post-process,
 * realtime events, auth-token creation, and the `expect.to_throw` test
 * assertion.
 *
 * `comment`, `realtime_event`, and `create_auth` have declarative transforms in
 * the engine schema and are encoded to match them; the rest are `!class` with no
 * persisted golden yet, so they are **structural** (reachable, byte-verified
 * later). Block fields map to same-named `context` entries unless the schema's
 * declarative transform says otherwise.
 *
 * array_map, array_union, get_input, and test_expect_to_throw are now
 * golden-verified against live engine captures (see the conformance corpus);
 * post_process is parser-verified. Remaining unverified spots:
 *   (1) array_map — the scalar `transform_value` path is byte-exact; the
 *       object-literal form (engine `transform_object` + `output_type:"object"`)
 *       is still UNSUPPORTED here (a feature gap, not a verification gap).
 *   (2) create_auth — input order is `id/dbtable/extras/expiration`, read from the
 *       engine's own input schema; `extras`/`expiration` are `?=` optionals and
 *       are omitted when unset. Only the `dbtable` const tag is unverified.
 *   (3) realtime_event — context.{channel,data,auth.{dbo_id,row_id}} CONFIRMED by
 *       the schema transform (auth_table via !map:dbo:constant → table guid).
 */
import type { Statement, AsShapeBrand } from "../statement.js";
import { encodeStatement, registerStatement } from "../statement.js";
import type { Value } from "../../values/value.js";
import { resolveRef } from "../../refs/guid.js";
import type { ObjectRef } from "../../refs/guid.js";

function vf(v: Value): { value: string; tag: string; filters: unknown[] } {
  return { value: v.value, tag: v.tag, filters: v.filters };
}

// --- array map / union ------------------------------------------------------
// Stored shapes modeled on the engine transforms' decode() (authoritative for
// the persisted form), NOT the authoring arg names — these `!class` transforms
// rename their fields on the way to storage:
//   array_map   → { output_type:"value", collection:<source>, transform_value?:<map> }
//   array_union → { left:<source>, right?:<other>, transform_value?:<map> }

export interface ArrayMapArgs {
  /** The source array → stored `collection`. */
  source: Value;
  as?: string;
  /** Per-item mapping expression → stored `transform_value`. */
  transform?: Value;
}

/**
 * `array.map <source>` — map each element through an expression (`mvp:array_map`).
 *
 * The scalar `transform_value` path is golden-verified (live capture). The
 * object-literal mapping form (engine `transform_object` + `output_type:"object"`)
 * is NOT supported here — only the scalar path; `output_type` is hard-coded
 * `"value"`. @TODO(byte-verify): the object-literal form remains unimplemented.
 */
export function arrayMap(a: ArrayMapArgs): Statement {
  const context: Record<string, unknown> = { output_type: "value", collection: vf(a.source) };
  if (a.transform) context.transform_value = vf(a.transform);
  return { name: "mvp:array_map", context, as: a.as ?? "", input: [] };
}

export interface ArrayUnionArgs {
  /** The base array → stored `left`. */
  source: Value;
  /** The array to union in → stored `right`. */
  with?: Value;
  as?: string;
  /** Optional per-item transform → stored `transform_value`. */
  transform?: Value;
}

/**
 * `array.union <source>` — set-union of arrays (`mvp:array_union`).
 *
 * Golden-verified against a live capture: the field remap (source→left,
 * with→right, transform→transform_value) matches the engine's array-union format.
 */
export function arrayUnion(a: ArrayUnionArgs): Statement {
  const context: Record<string, unknown> = { left: vf(a.source) };
  if (a.with) context.right = vf(a.with);
  if (a.transform) context.transform_value = vf(a.transform);
  return { name: "mvp:array_union", context, as: a.as ?? "", input: [] };
}

// --- comment / placeholder -------------------------------------------------

/** `comment` — a no-op annotation node (`mvp:comment`). Text rides the `description`. */
export function comment(text = ""): Statement {
  return { name: "mvp:comment", description: text, context: {}, input: [] };
}

/** `placeholder <name>` — an unconfigured statement slot (`mvp:placeholder`). */
export function placeholder(name: string): Statement {
  return { name: "mvp:placeholder", context: { name }, input: [] };
}

// --- raw input / post-process ---------------------------------------------

export interface GetRawInputArgs {
  as?: string;
  /** Body decoding (`json`, `raw`, …). */
  encoding?: Value;
  /** Skip middleware-applied transforms. */
  excludeMiddleware?: Value;
}

/**
 * `util.get_raw_input` / `util.get_input` — capture the raw request body
 * (`mvp:get_input`). Empty context, and up to two `input[]` entries — `encoding`
 * (`?=json`) and `exclude_middleware_modification` (note the full stored name;
 * `?=false`). Both are optional in the engine schema and are written only when
 * authored, matching what Xano's editor stores.
 */
export function getRawInput(a: GetRawInputArgs = {}): Statement {
  return {
    name: "mvp:get_input",
    context: {},
    as: a.as ?? "",
    // Both entries are `?=` optionals in the engine schema (`encoding?=json`,
    // `exclude_middleware_modification?=false`) and Xano's editor writes neither
    // for a plain body capture — so they are emitted only when authored.
    input: [
      ...(a.encoding === undefined ? [] : [{ name: "encoding", ...vf(a.encoding) }]),
      ...(a.excludeMiddleware === undefined
        ? []
        : [{ name: "exclude_middleware_modification", ...vf(a.excludeMiddleware) }]),
    ],
  };
}

/**
 * `util.post_process { … }` — run a post-response sub-stack (`mvp:post_process`).
 * A pure block statement (engine schema `args: []`): no `as`, just the `run`
 * stack. Byte-verified (parser-minimal) against the engine's persisted shape.
 */
export function postProcess(body: Statement[]): Statement {
  return { name: "mvp:post_process", context: { run: body.map(encodeStatement) }, input: [] };
}

// --- realtime event (declarative) ------------------------------------------

export interface RealtimeEventArgs {
  /** The channel to publish on. */
  channel: Value;
  /** The event payload. */
  data: Value;
  /** Optional auth table whose row scopes the event. */
  authTable?: ObjectRef;
  /** The auth row id. */
  authId: Value;
}

/**
 * `api.realtime_event { … }` — publish a realtime event (`mvp:realtime_event`).
 *
 * @deprecated Superseded. This publishes to Xano's older workspace-global realtime
 * layer, NOT to a `realtimeChannel()` — its `channel` is a string against that layer,
 * so pointing it at a current-layer channel path publishes into the void.
 *
 * There is no current-layer send statement yet, so this is not a stand-in for one:
 * to move a payload out over the current layer, return it from a `realtimeMessage()`
 * handler and let its `deliverTo` (`channel` / `sender` / `others`) decide who
 * receives it.
 *
 * Still exported and still supported so `sidestep codegen` can bring back a workspace
 * that holds one. Withheld from the `llms.txt` statement catalog and named only under
 * `## Legacy`.
 */
export function realtimeEvent(a: RealtimeEventArgs): Statement {
  const auth: Record<string, unknown> = { row_id: vf(a.authId) };
  if (a.authTable !== undefined) auth.dbo_id = resolveRef("dbo", a.authTable);
  return {
    name: "mvp:realtime_event",
    context: { channel: vf(a.channel), data: vf(a.data), auth },
    input: [],
  };
}

// --- auth token (declarative) ----------------------------------------------

export interface CreateAuthTokenArgs<As extends string = string> {
  /**
   * The auth table the token authenticates against.
   *
   * `null` is the UNBOUND table the engine stores as a blank guid — deleted, or
   * never bound. It exists so `codegen` can reproduce such a statement instead
   * of throwing, the same "no target" spelling `db.query`'s `table` carries.
   */
  table: ObjectRef | null;
  /** Token id (the authenticated row id). */
  id: Value;
  /** Extra claims embedded in the token. Defaults to `{}` (no extra claims). */
  extras?: Value;
  /** Expiry in seconds. Defaults to `86400` (24h); `0` never expires. */
  expiration?: Value;
  as?: As;
}

/**
 * `security.create_auth_token { … }` — mint an auth token (`mvp:create_auth`).
 *
 * Branded `AsShapeBrand<As, string>` (like the `db.*` producers) so a
 * `ref("<as>")` to the minted token traces to `string` via `InferResponse`
 * instead of `unknown` — the token is always a JWT string. The brand is phantom;
 * the emitted statement bytes are unchanged.
 */
export function createAuthToken<const As extends string = "">(
  a: CreateAuthTokenArgs<As>,
): Statement & AsShapeBrand<As, string> {
  return {
    name: "mvp:create_auth",
    context: {},
    as: a.as ?? "",
    // Entry order and optionality come straight from the engine's own input
    // schema — `id`, `dbtable`, `extras?={}`, `expiration?=86400`. The SDK
    // previously wrote a different order with both optionals always present;
    // Xano's editor writes this shape, so this is what a pulled workspace has.
    input: [
      { name: "id", ...vf(a.id) },
      {
        name: "dbtable",
        value: a.table === null ? "" : resolveRef("dbo", a.table),
        tag: "const",
        filters: [],
      },
      ...(a.extras === undefined ? [] : [{ name: "extras", ...vf(a.extras) }]),
      ...(a.expiration === undefined ? [] : [{ name: "expiration", ...vf(a.expiration) }]),
    ],
  } as unknown as Statement & AsShapeBrand<As, string>;
}

// --- expect.to_throw (structural) ------------------------------------------

export interface ExpectToThrowArgs {
  /** The statements expected to raise. */
  body: Statement[];
  /** Optional expected exception matcher. */
  exception?: Value;
}

/** `expect.to_throw { … }` — assert a sub-stack throws (`mvp:test_expect_to_throw`). */
export function expectToThrow(a: ExpectToThrowArgs): Statement {
  const context: Record<string, unknown> = { run: a.body.map(encodeStatement) };
  if (a.exception) context.exception = vf(a.exception);
  return { name: "mvp:test_expect_to_throw", context, input: [] };
}

registerStatement("mvp:array_map", arrayMap);
registerStatement("mvp:array_union", arrayUnion);
registerStatement("mvp:comment", comment);
registerStatement("mvp:placeholder", placeholder);
registerStatement("mvp:get_input", getRawInput);
registerStatement("mvp:post_process", postProcess);
registerStatement("mvp:realtime_event", realtimeEvent);
registerStatement("mvp:create_auth", createAuthToken);
registerStatement("mvp:test_expect_to_throw", expectToThrow);
