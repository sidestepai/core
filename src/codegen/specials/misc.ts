/**
 * The remaining hand-written encoders' inverses — raw-input capture, the two
 * array set operations, realtime events, auth-token minting, and the two
 * call-family tail statements that do not fit `calls.ts`'s uniform shape.
 *
 * What these have in common is that their encoders *rename* fields on the way to
 * storage (`source` → `collection`/`left`, `excludeMiddleware` →
 * `exclude_middleware_modification`) or fill a default the author never wrote.
 * Both are exactly the cases a spec inversion cannot reach, and both are cheap to
 * invert by hand — the renames are one-to-one and the defaults are recovered by
 * re-running the encoder's own constructor and comparing.
 */
import type { TaggedValue } from "../../types/xdo.js";
import { lit, obj, type Expr } from "../print.js";
import { resolveReference } from "../ref-index.js";
import { decodeValue } from "../value.js";
import { declineHere, getPath, prove, type SpecialArgs, type SpecialDecoder } from "./prove.js";
import { liveArrayMapContext } from "../../validate/normalize.js";

/** Coerce a stored `{value, tag, filters}` block to a tagged value. */
function toValue(raw: unknown): TaggedValue | null {
  if (raw === null || typeof raw !== "object") return null;
  const block = raw as { value?: unknown; tag?: unknown; filters?: unknown };
  if (typeof block.tag !== "string" || block.value === undefined) return null;
  return {
    value: block.value as string,
    tag: block.tag as TaggedValue["tag"],
    filters: (Array.isArray(block.filters) ? block.filters : []) as TaggedValue["filters"],
  };
}

/** The stored `input[]` as a name → value map, or null if any entry is malformed. */
function inputMap(a: SpecialArgs): Map<string, TaggedValue> | null {
  const list = Array.isArray(a.stored.input) ? a.stored.input : [];
  const out = new Map<string, TaggedValue>();
  for (const raw of list) {
    const value = toValue(raw);
    const name = (raw as { name?: unknown }).name;
    if (!value || typeof name !== "string")
      return declineHere("input[]: entry is not a named tagged value");
    out.set(name, value);
  }
  return out;
}

/** Append a non-empty `as` to a candidate call. */
function withAs(
  a: SpecialArgs,
  entries: Array<[string, Expr]>,
  runtime: Record<string, unknown>,
): void {
  const as = (a.stored as { as?: unknown }).as;
  if (typeof as === "string" && as !== "") {
    entries.push(["as", lit(as)]);
    runtime.as = as;
  }
}

/**
 * `util.get_raw_input` — capture the request body.
 *
 * Both entries are `?=` optionals the engine omits when unset, so each is carried
 * back by PRESENCE rather than by comparing against a default — an explicitly
 * authored `"json"` is stored and must survive. `util.get_input` is an alias of
 * the same factory and encodes identically; one surface is chosen so the output
 * is deterministic.
 */
const getRawInput: SpecialDecoder = (a) => {
  const values = inputMap(a);
  if (!values) return null;
  const encoding = values.get("encoding");
  const exclude = values.get("exclude_middleware_modification");
  const known = new Set(["encoding", "exclude_middleware_modification"]);
  const extra = [...values.keys()].find((name) => !known.has(name));
  if (extra !== undefined)
    return declineHere(`util.get_raw_input: unmodelled input entry "${extra}"`);

  // Presence, not value: both are `?=` optionals the engine omits when unset, so
  // an absent entry means "not authored" and must stay absent.
  const entries: Array<[string, Expr]> = [];
  const runtime: Record<string, unknown> = {};
  if (encoding) {
    entries.push(["encoding", decodeValue(a.ctx, encoding)]);
    runtime.encoding = encoding;
  }
  if (exclude) {
    entries.push(["excludeMiddleware", decodeValue(a.ctx, exclude)]);
    runtime.excludeMiddleware = exclude;
  }
  withAs(a, entries, runtime);
  return prove(a.ctx, a.stored, "util.get_raw_input", [runtime], [obj(entries)]);
};

/**
 * Build a decoder for a statement whose arguments are renamed `context` keys.
 *
 * `fields` maps a stored context key to its authoring argument. Keys marked
 * required must be present; the rest are emitted only when stored. A context key
 * outside the map (beyond `constants`, which the encoder writes unconditionally)
 * means a different shape, so the decoder falls through.
 */
function contextValues(
  path: string,
  fields: ReadonlyArray<readonly [key: string, arg: string, required?: boolean]>,
  constants: Readonly<Record<string, unknown>> = {},
): SpecialDecoder {
  return (a) => {
    const context = (a.stored.context ?? {}) as Record<string, unknown>;
    for (const [key, expected] of Object.entries(constants)) {
      if (context[key] !== expected)
        return declineHere(`${path}: context.${key} is not the modelled ${String(expected)}`);
    }
    const known = new Set([...fields.map(([key]) => key), ...Object.keys(constants)]);
    for (const key of Object.keys(context))
      if (!known.has(key)) return declineHere(`${path}: unmodelled context key "${key}"`);

    const entries: Array<[string, Expr]> = [];
    const runtime: Record<string, unknown> = {};
    for (const [key, arg, required] of fields) {
      if (context[key] === undefined) {
        if (required) return declineHere(`${path}: required context.${key} is absent`);
        continue;
      }
      const value = toValue(context[key]);
      if (!value) return declineHere(`${path}: context.${key} is not a tagged value`);
      entries.push([arg, decodeValue(a.ctx, value)]);
      runtime[arg] = value;
    }
    withAs(a, entries, runtime);
    return prove(a.ctx, a.stored, path, [runtime], [obj(entries)]);
  };
}

/** `api.realtime_event` — channel/data plus an auth block scoping the event. */
const realtimeEvent: SpecialDecoder = (a) => {
  const context = (a.stored.context ?? {}) as Record<string, unknown>;
  const channel = toValue(context.channel);
  const data = toValue(context.data);
  const authId = toValue(getPath(context, "auth.row_id"));
  if (!channel || !data || !authId)
    return declineHere("api.realtime_event: channel, data, or auth.row_id is not a tagged value");

  const entries: Array<[string, Expr]> = [
    ["channel", decodeValue(a.ctx, channel)],
    ["data", decodeValue(a.ctx, data)],
  ];
  const runtime: Record<string, unknown> = { channel, data };

  const tableGuid = getPath(context, "auth.dbo_id");
  if (typeof tableGuid === "string" && tableGuid !== "") {
    entries.push([
      "authTable",
      resolveReference(a.ctx, a.refs, tableGuid, { ...a.resolve, unresolved: "object-ref" }),
    ]);
    runtime.authTable = { name: "", guid: tableGuid };
  }
  entries.push(["authId", decodeValue(a.ctx, authId)]);
  runtime.authId = authId;
  return prove(a.ctx, a.stored, "api.realtime_event", [runtime], [obj(entries)]);
};

/**
 * `realtime.publish` — the current-layer send statement.
 *
 * Two asymmetries with `api.realtime_event` above, both load-bearing:
 *  - `realtime_server` is a NAME, not a guid, so it decodes back to a plain string
 *    rather than through the reference index. A bare `const` name round-trips as the
 *    string the author wrote; any other tag keeps its value expression.
 *  - Every field but `realtime_server`/`channel`/`data` is optional AND the whole
 *    `auth` block may be absent, so an absent key means "not authored" rather than
 *    malformed — re-materializing it would write bytes the engine never held.
 */
const realtimePublish: SpecialDecoder = (a) => {
  const context = (a.stored.context ?? {}) as Record<string, unknown>;
  const known = new Set(["realtime_server", "channel", "data", "message", "auth"]);
  const unmodelled = Object.keys(context).find((key) => !known.has(key));
  if (unmodelled !== undefined)
    return declineHere(`realtime.publish: unmodelled context key "${unmodelled}"`);

  const server = toValue(context.realtime_server);
  const channel = toValue(context.channel);
  const data = toValue(context.data);
  if (!server || !channel || !data)
    return declineHere("realtime.publish: realtime_server, channel, or data is not a tagged value");

  const entries: Array<[string, Expr]> = [];
  const runtime: Record<string, unknown> = {};
  // A plain `const` name is what an author writes as `server: "chat"`; anything else
  // (an input, a var, a filtered value) keeps its expression form.
  if (server.tag === "const" && server.filters.length === 0) {
    entries.push(["server", lit(server.value)]);
    runtime.server = server.value;
  } else {
    entries.push(["server", decodeValue(a.ctx, server)]);
    runtime.server = server;
  }
  entries.push(["channel", decodeValue(a.ctx, channel)]);
  entries.push(["data", decodeValue(a.ctx, data)]);
  runtime.channel = channel;
  runtime.data = data;

  const message = context.message === undefined ? null : toValue(context.message);
  if (context.message !== undefined) {
    if (!message) return declineHere("realtime.publish: context.message is not a tagged value");
    entries.push(["message", decodeValue(a.ctx, message)]);
    runtime.message = message;
  }

  if (context.auth !== undefined) {
    const tableGuid = getPath(context, "auth.dbo_id");
    if (typeof tableGuid === "string" && tableGuid !== "") {
      entries.push([
        "authTable",
        resolveReference(a.ctx, a.refs, tableGuid, { ...a.resolve, unresolved: "object-ref" }),
      ]);
      runtime.authTable = { name: "", guid: tableGuid };
    }
    const rowId = getPath(context, "auth.row_id");
    if (rowId !== undefined) {
      const authId = toValue(rowId);
      if (!authId) return declineHere("realtime.publish: context.auth.row_id is not a tagged value");
      entries.push(["authId", decodeValue(a.ctx, authId)]);
      runtime.authId = authId;
    }
  }

  return prove(a.ctx, a.stored, "realtime.publish", [runtime], [obj(entries)]);
};

/**
 * `security.create_auth_token` — the auth table rides a bare-guid `const` input
 * entry rather than a `context` reference, and `extras`/`expiration` carry
 * encoder defaults (`{}` / 24h) that are elided when unchanged.
 */
const createAuthToken: SpecialDecoder = (a) => {
  const values = inputMap(a);
  if (!values) return null;
  const table = values.get("dbtable");
  const id = values.get("id");
  // `extras?={}` and `expiration?=86400` are `?=` optionals the engine omits when
  // unset, so their absence means "not authored" rather than "malformed".
  const extras = values.get("extras");
  const expiration = values.get("expiration");
  const known = new Set(["dbtable", "id", "extras", "expiration"]);
  if (!table || !id)
    return declineHere("security.create_auth_token: input[] is missing dbtable or id");
  const unmodelled = [...values.keys()].find((name) => !known.has(name));
  if (unmodelled !== undefined)
    return declineHere(`security.create_auth_token: unmodelled input entry "${unmodelled}"`);
  if (table.tag !== "const" || table.filters.length > 0)
    return declineHere("security.create_auth_token: dbtable is not a bare guid constant");

  // A blank guid is an unbound table — resolving it threw inside the factory and
  // took the whole statement to `raw()`. Same "no target" spelling as elsewhere.
  const unbound = table.value === "";

  // A `dbtable` this bundle does not resolve as a guid.
  //
  // Keyed on RESOLUTION and on nothing else. **SideStep resolves references by
  // guid only and never maps a name back to an object.** An earlier version
  // keyed this on "a table of that name exists", which is a name lookup in all
  // but direction; it also left the case where that table is ABSENT falling
  // through to guid resolution, reporting a missing guid 6 more times.
  //
  // And there is nothing else it COULD key on. A workspace guid is an arbitrary
  // unique key that anyone can change — it has no pattern, so the value cannot
  // be classified by shape. Two readings therefore stay open and only the
  // workspace owner can tell them apart:
  //
  //  - older workspaces store this field by NAME, and the engine keys it by
  //    name on those, so the statement works and nothing is wrong;
  //  - or it is a guid whose table was deleted, re-keyed, or sat outside the
  //    export's scope — a real broken reference.
  //
  // Reported as `name-bound-ref` because that is literally and only what is
  // known: the reference is stored by name and did not resolve as a guid. Same
  // contract {@link unboundTableArg} holds a blank table to — name both
  // readings, leave the judgement to whoever reads it — rather than picking one
  // and quietly downgrading the other. Warning rather than error for the reason
  // spelled out on the category: the bytes round-trip, so the output is not
  // unsafe to act on; what a reader has to decide is whether the missing symbol
  // link matters to them. The bytes are faithful either way: the value rides
  // through verbatim on the
  // `{name, guid}` escape hatch and re-encodes identically. What is lost is the
  // link to the table's symbol, and resolving it would be worse than useless —
  // re-encoding a table handle writes that table's real guid, changing the
  // stored bytes.
  const unresolvable = !unbound && a.refs.lookup(table.value) === undefined;
  if (unresolvable) {
    a.ctx.problem(
      "name-bound-ref",
      `security.create_auth_token references table "${table.value}", which this bundle does not resolve as a guid — SideStep resolves references by guid only. Older workspaces store this field by NAME, which the engine still honours, so this may be working as stored; it may equally be a table that was deleted or re-keyed. Carried verbatim, so the bytes are preserved, but it is not linked to the table's symbol and a re-deploy will not re-link it`,
    );
  }
  const entries: Array<[string, Expr]> = [
    [
      "table",
      unbound
        ? lit(null)
        : unresolvable
          ? obj([
              ["name", lit("")],
              ["guid", lit(table.value)],
            ])
          : resolveReference(a.ctx, a.refs, table.value, { ...a.resolve, unresolved: "object-ref" }),
    ],
    ["id", decodeValue(a.ctx, id)],
  ];
  const runtime: Record<string, unknown> = {
    table: unbound ? null : { name: "", guid: table.value },
    id,
  };
  // Presence, not value: an explicitly-authored `{}`/86400 is stored and must
  // come back, just as a workspace that omitted them must stay omitted.
  if (extras) {
    entries.push(["extras", decodeValue(a.ctx, extras)]);
    runtime.extras = extras;
  }
  if (expiration) {
    entries.push(["expiration", decodeValue(a.ctx, expiration)]);
    runtime.expiration = expiration;
  }
  withAs(a, entries, runtime);
  return prove(a.ctx, a.stored, "security.create_auth_token", [runtime], [obj(entries)]);
};

/** The lean `{name, …value}` bindings a call-family statement carries. */
function callInput(a: SpecialArgs): { expr: Expr; runtime: Record<string, unknown> } | null {
  const values = inputMap(a);
  if (!values) return null;
  const cells: Array<[string, Expr]> = [];
  const runtime: Record<string, unknown> = {};
  for (const [name, value] of values) {
    cells.push([name, decodeValue(a.ctx, value)]);
    runtime[name] = value;
  }
  return { expr: obj(cells), runtime };
}

/**
 * `action.package.call` — a reachable placeholder.
 *
 * SideStep does not model marketplace action-package identity, so the encoder
 * writes an empty trace id and version id and ignores the `action` argument
 * entirely. The decoder mirrors that exactly: it refuses any stored statement
 * carrying a real identity (which it could not reproduce), and passes the same
 * empty `action` the encoder discards.
 */
const actionPackageCall: SpecialDecoder = (a) => {
  const context = (a.stored.context ?? {}) as Record<string, unknown>;
  if (getPath(context, "action.trace_id") !== "" || getPath(context, "package_version.id") !== "")
    return declineHere("action.package.call: statement carries a marketplace identity");
  const slug = getPath(context, "package.slug");
  if (typeof slug !== "string")
    return declineHere("action.package.call: context.package.slug is not a string");

  const entries: Array<[string, Expr]> = [["action", lit("")]];
  const runtime: Record<string, unknown> = { action: "" };
  if (slug !== "") {
    entries.push(["package", lit(slug)]);
    runtime.package = slug;
  }
  const input = callInput(a);
  if (!input) return null;
  if (Object.keys(input.runtime).length > 0) {
    entries.push(["input", input.expr]);
    runtime.input = input.runtime;
  }
  withAs(a, entries, runtime);
  return prove(a.ctx, a.stored, "action.package.call", [runtime], [obj(entries)]);
};

/** `workflow_test.call` — a guid target plus an always-present datasource. */
const workflowTestCall: SpecialDecoder = (a) => {
  const context = (a.stored.context ?? {}) as Record<string, unknown>;
  const guid = context.id;
  if (typeof guid !== "string" || guid === "")
    return declineHere("workflow_test.call: context.id is blank");

  const entries: Array<[string, Expr]> = [
    [
      "workflowTest",
      resolveReference(a.ctx, a.refs, guid, { ...a.resolve, unresolved: "object-ref" }),
    ],
  ];
  const runtime: Record<string, unknown> = { workflowTest: { name: "", guid } };
  const datasource = context.datasource;
  if (typeof datasource === "string" && datasource !== "") {
    entries.push(["datasource", lit(datasource)]);
    runtime.datasource = datasource;
  }
  withAs(a, entries, runtime);
  return prove(a.ctx, a.stored, "workflow_test.call", [runtime], [obj(entries)]);
};

/**
 * `security.create_guid` — the engine declares no context, input, or output
 * schema for it, so `as` is the only thing to recover. Anything else present is
 * a shape this does not model, and declining lets it ride `raw()` intact.
 */
const createGuid: SpecialDecoder = (a) => {
  const entries: Array<[string, Expr]> = [];
  const runtime: Record<string, unknown> = {};
  withAs(a, entries, runtime);
  return prove(a.ctx, a.stored, "security.create_guid", [runtime], [obj(entries)]);
};

/**
 * `array.map` — both engine output modes.
 *
 * `output_type:"value"` reads the scalar `transform_value`; `output_type:"object"`
 * reads `transform_object[]` and rebuilds it as the record form the factory takes.
 * A record key has to be a literal, so an `attribute_key` that is anything other
 * than an unfiltered `const` text declines to `raw()` rather than inventing one —
 * the engine's editor offers a full tagged value there and this surface does not.
 *
 * The context is reduced through {@link liveArrayMapContext} first, because an
 * editor-saved statement carries BOTH mapping branches and only one is live. The
 * dead branch at its inert spelling is dropped; a dead branch carrying anything
 * real is left in place and declines below, since the SDK cannot write it back.
 */
const arrayMap: SpecialDecoder = (a) => {
  const context = (liveArrayMapContext(a.stored) ?? a.stored.context ?? {}) as Record<
    string,
    unknown
  >;
  const outputType = context.output_type ?? "value";
  const known = new Set(["output_type", "collection", "transform_value", "transform_object"]);
  for (const key of Object.keys(context))
    if (!known.has(key)) return declineHere(`array.map: unmodelled context key "${key}"`);

  const source = toValue(context.collection);
  if (!source) return declineHere("array.map: required context.collection is absent");
  const entries: Array<[string, Expr]> = [["source", decodeValue(a.ctx, source)]];
  const runtime: Record<string, unknown> = { source };

  if (outputType === "value") {
    // The object branch never reads `transform_object`, and vice versa — a
    // statement carrying the other mode's key is a shape this does not model.
    if (context.transform_object !== undefined)
      return declineHere("array.map: transform_object present on a value-mode statement");
    const transform = toValue(context.transform_value);
    if (context.transform_value !== undefined) {
      if (!transform) return declineHere("array.map: context.transform_value is not a tagged value");
      entries.push(["transform", decodeValue(a.ctx, transform)]);
      runtime.transform = transform;
    }
  } else if (outputType === "object") {
    if (context.transform_value !== undefined)
      return declineHere("array.map: transform_value present on an object-mode statement");
    const attributes = context.transform_object;
    if (!Array.isArray(attributes) || attributes.length === 0)
      return declineHere("array.map: object mode with no transform_object entries");
    const mapEntries: Array<[string, Expr]> = [];
    const mapRuntime: Record<string, unknown> = {};
    for (const attribute of attributes) {
      const key = toValue((attribute as Record<string, unknown> | null)?.attribute_key);
      const value = toValue((attribute as Record<string, unknown> | null)?.attribute_value);
      if (!key || !value) return declineHere("array.map: transform_object entry is not two values");
      if (key.tag !== "const" || key.filters.length > 0)
        return declineHere("array.map: transform_object key is computed, not a literal");
      if (Object.hasOwn(mapRuntime, key.value))
        return declineHere(`array.map: duplicate transform_object key "${key.value}"`);
      mapEntries.push([key.value, decodeValue(a.ctx, value)]);
      mapRuntime[key.value] = value;
    }
    entries.push(["transform", obj(mapEntries)]);
    runtime.transform = mapRuntime;
  } else {
    return declineHere(`array.map: unmodelled output_type "${String(outputType)}"`);
  }

  withAs(a, entries, runtime);
  return prove(a.ctx, a.stored, "array.map", [runtime], [obj(entries)]);
};

/** Miscellaneous decoders by stored name. */
export const MISC_DECODERS: ReadonlyMap<string, SpecialDecoder> = new Map<string, SpecialDecoder>([
  ["mvp:get_input", getRawInput],
  ["mvp:array_map", arrayMap],
  [
    "mvp:array_union",
    contextValues("array.union", [
      ["left", "source", true],
      ["right", "with"],
      ["transform_value", "transform"],
    ]),
  ],
  ["mvp:realtime_event", realtimeEvent],
  ["mvp:realtime_publish", realtimePublish],
  ["mvp:create_auth", createAuthToken],
  ["mvp:guid", createGuid],
  ["mvp:action_package", actionPackageCall],
  ["mvp:workspace_run_workflow_test", workflowTestCall],
]);
