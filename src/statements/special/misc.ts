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
 *   (1) array_map — the scalar `transform_value` path is byte-exact. The
 *       object-literal form (`transform_object` + `output_type:"object"`) is now
 *       authorable and round-trips through codegen, but is modeled from the
 *       engine's declared context schema rather than a capture: no golden yet.
 *   (2) create_auth — input order is `id/dbtable/extras/expiration`, read from the
 *       engine's own input schema; `extras`/`expiration` are `?=` optionals and
 *       are omitted when unset. Only the `dbtable` const tag is unverified.
 *   (3) realtime_event — context.{channel,data,auth.{dbo_id,row_id}} CONFIRMED by
 *       the schema transform (auth_table via !map:dbo:constant → table guid).
 */
import type { Statement, AsShapeBrand } from "../statement.js";
import { encodeStatement, registerStatement } from "../statement.js";
import type { Value } from "../../values/value.js";
import { c, isTaggedValue } from "../../values/value.js";
import { resolveRef } from "../../refs/guid.js";
import type { ObjectRef } from "../../refs/guid.js";
import { annotate } from "../statement.js";
import type { StatementAnnotations } from "../statement.js";

function vf(v: Value): { value: string; tag: string; filters: unknown[] } {
  return { value: v.value, tag: v.tag, filters: v.filters };
}

// --- array map / union ------------------------------------------------------
// Stored shapes modeled on the engine transforms' decode() (authoritative for
// the persisted form), NOT the authoring arg names — these `!class` transforms
// rename their fields on the way to storage:
//   array_map   → { output_type:"value", collection:<source>, transform_value?:<map> }
//   array_union → { left:<source>, right?:<other>, transform_value?:<map> }

export interface ArrayMapArgs extends StatementAnnotations {
  /** The source array → stored `collection`. */
  source: Value;
  as?: string;
  /**
   * How each item maps. Two forms, and the form picks the engine's `output_type`:
   * - a single {@link Value} → each item maps to that scalar expression
   *   (`output_type:"value"`, stored `transform_value`);
   * - a record of values → each item maps to an OBJECT with those keys
   *   (`output_type:"object"`, stored `transform_object[]`).
   *
   * Use `ref("$this")` for the current item and `ref("$index")` for its position.
   * An empty record is rejected — the engine's object branch iterates
   * `transform_object` and would map every item to `{}`.
   */
  transform?: Value | Record<string, Value>;
}

/** A `transform` record (object form) rather than a single tagged value. */
function isTransformRecord(t: Value | Record<string, Value>): t is Record<string, Value> {
  return !isTaggedValue(t);
}

/**
 * `array.map <source>` — map each element through an expression (`mvp:array_map`).
 *
 * Both engine output modes are golden-verified against live captures. The object
 * path (`output_type:"object"` + `transform_object[]`) stores one
 * `{attribute_key, attribute_value}` entry per record key, in authored order,
 * and the key is a plain `const` text triple.
 *
 * Only the LIVE branch is emitted, and the capture confirms the engine agrees:
 * an imported object-mode statement stores NO `transform_value`, and a
 * value-mode one stores no `transform_object`. The EDITOR is the exception — it
 * builds its form from the whole context schema and saves every control, so an
 * editor-saved object-mode statement also carries `transform_value` at its
 * schema defaults. Both spellings are one state (the engine's object branch
 * never reads `transform_value`); `liveArrayMapContext` in validate/normalize.ts
 * is where that equivalence lives, so an editor-authored statement still reads
 * back to this factory instead of falling to `raw()`.
 *
 * ```ts
 * // scalar: ["a","b"] → ["A","B"]
 * s.array.map({ source: ref("names"), as: "upper", transform: withFilters(ref("$this"), fl.upper()) })
 * // object: [1,2] → [{id:1, pos:0}, {id:2, pos:1}]
 * s.array.map({ source: ref("ids"), as: "rows", transform: { id: ref("$this"), pos: ref("$index") } })
 * ```
 */
export function arrayMap(a: ArrayMapArgs): Statement {
  const context: Record<string, unknown> = { output_type: "value", collection: vf(a.source) };
  if (a.transform !== undefined) {
    if (isTransformRecord(a.transform)) {
      const entries = Object.entries(a.transform);
      if (entries.length === 0) {
        throw new Error(
          "array.map: an object `transform` needs at least one key — the engine's object branch " +
            "iterates `transform_object` and an empty one maps every item to `{}`. Pass a record " +
            "of values (`{ id: ref('$this') }`) or a single value for the scalar form.",
        );
      }
      context.output_type = "object";
      context.transform_object = entries.map(([key, value]) => ({
        attribute_key: vf(c.text(key)),
        attribute_value: vf(value),
      }));
    } else {
      context.transform_value = vf(a.transform);
    }
  }
  return annotate({ name: "mvp:array_map", context, as: a.as ?? "", input: [] }, a);
}

export interface ArrayUnionArgs extends StatementAnnotations {
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
  return annotate({ name: "mvp:array_union", context, as: a.as ?? "", input: [] }, a);
}

// --- comment / placeholder -------------------------------------------------

/**
 * `comment` — a no-op annotation node (`mvp:comment`). The text IS this
 * statement's `description`, so `text` and `a.description` set the same member
 * and an explicit `a.description` wins; `a.disabled` applies as it does anywhere.
 */
export function comment(text = "", a?: StatementAnnotations): Statement {
  return annotate({ name: "mvp:comment", description: text, context: {}, input: [] }, a);
}

// `mvp:placeholder` deliberately has NO factory. The engine writes it into an
// export in place of a statement it could not resolve, then refuses those same
// bytes on import, so there is no destination where an authored one runs. It is
// decoded through `raw()` and blocked at `export()` — see
// {@link DECODE_ONLY_STATEMENTS}.

// --- raw input / post-process ---------------------------------------------

export interface GetRawInputArgs extends StatementAnnotations {
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
  return annotate({
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
  }, a);
}

/**
 * `util.post_process { … }` — run a post-response sub-stack (`mvp:post_process`).
 * A pure block statement (engine schema `args: []`): no `as`, just the `run`
 * stack. Byte-verified (parser-minimal) against the engine's persisted shape.
 */
export function postProcess(body: Statement[], a?: StatementAnnotations): Statement {
  return annotate(
    { name: "mvp:post_process", context: { run: body.map(encodeStatement) }, input: [] },
    a,
  );
}

// --- realtime event (declarative) ------------------------------------------

export interface RealtimeEventArgs extends StatementAnnotations {
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
 * @deprecated Superseded by {@link realtimePublish}. This publishes to Xano's older
 * workspace-global realtime layer, NOT to a `realtimeChannel()` — its `channel` is a
 * string against that layer, so pointing it at a current-layer channel path publishes
 * into the void.
 *
 * To originate an event on the current layer, use `s.realtime.publish`, which names the
 * owning `realtimeServer()` and so addresses a real `realtimeChannel()`.
 *
 * Still exported and still supported so `sidestep codegen` can bring back a workspace
 * that holds one. Withheld from the `llms.txt` statement catalog and named only under
 * `## Legacy`.
 */
export function realtimeEvent(a: RealtimeEventArgs): Statement {
  const auth: Record<string, unknown> = { row_id: vf(a.authId) };
  if (a.authTable !== undefined) auth.dbo_id = resolveRef("dbo", a.authTable);
  return annotate({
    name: "mvp:realtime_event",
    context: { channel: vf(a.channel), data: vf(a.data), auth },
    input: [],
  }, a);
}

// --- realtime publish (declarative) ----------------------------------------

/**
 * The realtime server to publish onto: a `realtimeServer()` handle, its bare name, or
 * a `Value` when the name is computed at runtime.
 *
 * The engine resolves this server by NAME within the current workspace and branch —
 * not by guid — so a handle contributes its `name`, not its identity.
 */
export type RealtimePublishServer = string | { name: string } | Value;

export interface RealtimePublishArgs extends StatementAnnotations {
  /**
   * The owning realtime server, by name. Required: a channel path is unique only
   * within its server, so the path alone cannot be addressed.
   */
  server: RealtimePublishServer;
  /**
   * The channel PATH to publish onto, already filled in — `c.text("rooms/42")`, not
   * the `rooms/{room_id}` template. Build it with `realtimeChannel().getChannel({…})`
   * rather than concatenating by hand.
   */
  channel: Value;
  /** The event payload delivered to subscribers. */
  data: Value;
  /**
   * Optional message TYPE stamped on the frame, so a client that switches on type can
   * route a server-originated event the same way it routes a `realtimeMessage()` one.
   * Naming a type does NOT invoke that message's handler — see the note on delivery below.
   */
  message?: Value;
  /**
   * Optional ASSERTED identity attributed to the event: name an auth **table** (a
   * `table({ auth: true })` def or its name) and it resolves to that table's guid.
   *
   * This is attribution carried on the frame, NOT a credential — nothing validates it
   * and no auth gate consumes it. Do not use it to grant a publish that a channel's
   * `publish.who` would otherwise refuse; this statement bypasses that gate entirely.
   */
  authTable?: ObjectRef;
  /** The asserted identity's row id. Attribution only — see {@link RealtimePublishArgs.authTable}. */
  authId?: Value;
}

/**
 * `realtime.publish { … }` — originate a server-authored event onto a realtime channel
 * from any function stack (`mvp:realtime_publish`).
 *
 * This is how a query, task, function, or trigger pushes to connected clients without a
 * client frame arriving first: "the auction closed", "the job finished", "row 42 changed".
 *
 * Three properties decide whether this is the right tool, and all three surprise people:
 *
 *  - **Delivery-only.** The event is fanned out to subscribers as-is. It does NOT invoke
 *    a `realtimeMessage()` handler, even when `message` names one, so no stack of yours
 *    runs on the delivery side. A channel `deliver` trigger still applies (it belongs to
 *    the channel, not to the message).
 *  - **Server-authoritative.** It bypasses the channel's `publish.who` policy — that gate
 *    governs CLIENTS. Any stack that can run this can publish, so guard it in your own
 *    stack if that matters.
 *  - **Fail-soft.** A missing or disabled server, a server with no minted canonical, or an
 *    unreachable bus is logged engine-side and returns quietly. NOTHING throws into your
 *    stack and there is no return value to check, so a mis-targeted publish is SILENT.
 *    The two references this SDK can check — `server` and `channel` — throw here at author
 *    time instead, because that is the only loud failure available.
 *
 * It does not rescue `deliverTo: "explicit"` on a `realtimeMessage()`: this originates an
 * event INTO a channel and never selects recipients from inside a handler.
 *
 * ```ts
 * const rooms = realtimeChannel({ name: "rooms/{room_id}", server: chat, input: { room_id: input.int() } });
 * s.realtime.publish({
 *   server: chat,
 *   channel: c.text(rooms.getChannel({ room_id: 42 })),
 *   message: c.text("post"),
 *   data: obj({ body: "the auction closed" }),
 * });
 * ```
 */
export function realtimePublish(a: RealtimePublishArgs): Statement {
  const server = publishServerValue(a.server);
  if (!a.channel || a.channel.value === "") {
    throw new Error(
      "realtime.publish: `channel` is required — the filled-in channel path to publish onto (use `realtimeChannel().getChannel({…})`).",
    );
  }
  const context: Record<string, unknown> = {
    realtime_server: server,
    channel: vf(a.channel),
    data: vf(a.data),
  };
  if (a.message !== undefined) context.message = vf(a.message);
  const auth: Record<string, unknown> = {};
  if (a.authTable !== undefined) auth.dbo_id = resolveRef("dbo", a.authTable);
  if (a.authId !== undefined) auth.row_id = vf(a.authId);
  if (Object.keys(auth).length > 0) context.auth = auth;
  return annotate({ name: "mvp:realtime_publish", context, input: [] }, a);
}

/** Coerce the `server` argument to its stored value form — always the server's NAME. */
function publishServerValue(server: RealtimePublishServer): { value: string; tag: string; filters: unknown[] } {
  if (typeof server === "string") {
    if (server === "") throw new Error("realtime.publish: `server` is required — the owning realtime server's name.");
    return { value: server, tag: "const", filters: [] };
  }
  if (server && typeof server === "object" && "tag" in server) return vf(server as Value);
  const name = server && typeof server === "object" ? server.name : undefined;
  if (!name) {
    throw new Error(
      "realtime.publish: `server` is required — pass the `realtimeServer()` handle, its name, or a value naming it.",
    );
  }
  return { value: name, tag: "const", filters: [] };
}

// --- auth token (declarative) ----------------------------------------------

export interface CreateAuthTokenArgs<As extends string = string> extends StatementAnnotations {
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
  return annotate({
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
  } as unknown as Statement & AsShapeBrand<As, string>, a);
}

// --- security.create_guid ---------------------------------------------------

/**
 * `security.create_guid` — generate a GUID (`mvp:guid`).
 *
 * The engine's statement declares no context, input, or output schema at all
 * (`Generate GUID`): it takes nothing and binds the generated value, so `as` is
 * the only thing to author. Sibling of `security.create_uuid` (`mvp:uuid4`),
 * which is a different generator and a different stored statement — the SDK
 * models both rather than folding one into the other.
 *
 * Branded `AsShapeBrand<As, string>` so a `ref("<as>")` traces to `string`.
 */
export function createGuid<const As extends string = "">(
  a: { as?: As } & StatementAnnotations = {},
): Statement & AsShapeBrand<As, string> {
  return annotate({
    name: "mvp:guid",
    context: {},
    as: a.as ?? "",
    input: [],
  }, a) as unknown as Statement & AsShapeBrand<As, string>;
}

// --- expect.to_throw (structural) ------------------------------------------

export interface ExpectToThrowArgs extends StatementAnnotations {
  /** The statements expected to raise. */
  body: Statement[];
  /** Optional expected exception matcher. */
  exception?: Value;
}

/** `expect.to_throw { … }` — assert a sub-stack throws (`mvp:test_expect_to_throw`). */
export function expectToThrow(a: ExpectToThrowArgs): Statement {
  const context: Record<string, unknown> = { run: a.body.map(encodeStatement) };
  if (a.exception) context.exception = vf(a.exception);
  return annotate({ name: "mvp:test_expect_to_throw", context, input: [] }, a);
}

registerStatement("mvp:array_map", arrayMap);
registerStatement("mvp:guid", createGuid);
registerStatement("mvp:array_union", arrayUnion);
registerStatement("mvp:comment", comment);
registerStatement("mvp:get_input", getRawInput);
registerStatement("mvp:post_process", postProcess);
registerStatement("mvp:realtime_event", realtimeEvent);
registerStatement("mvp:realtime_publish", realtimePublish);
registerStatement("mvp:create_auth", createAuthToken);
registerStatement("mvp:test_expect_to_throw", expectToThrow);
