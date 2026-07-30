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

  // `dbtable` has a THIRD stored spelling: older workspaces write the table's
  // NAME here rather than its guid (7 of 191 across the sweep, against 179 guid
  // and 5 blank). Routing a name through guid resolution reported "guid user is
  // not present in this bundle" — an ERROR, about a guid that was never a guid.
  // The name rides through verbatim on the `{name, guid}` escape hatch and
  // re-encodes byte-identically, so nothing is lost; what it costs is the link
  // to the table's symbol, which is a readability loss and reported as one.
  // Resolving it to the symbol would be worse than useless: re-encoding a table
  // handle writes the table's real guid, changing the stored bytes.
  const named = unbound ? undefined : a.refs.all().find((o) => o.kind === "table" && o.name === table.value);
  const nameSpelled = named !== undefined && a.refs.lookup(table.value) === undefined;
  if (nameSpelled) {
    a.ctx.problem(
      "value-fallback",
      `security.create_auth_token references table "${table.value}" by name rather than by guid, as older workspaces store it; carried verbatim, so it is not linked to the table's symbol`,
    );
  }
  const entries: Array<[string, Expr]> = [
    [
      "table",
      unbound
        ? lit(null)
        : nameSpelled
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

/** Miscellaneous decoders by stored name. */
export const MISC_DECODERS: ReadonlyMap<string, SpecialDecoder> = new Map<string, SpecialDecoder>([
  ["mvp:get_input", getRawInput],
  [
    "mvp:array_map",
    contextValues(
      "array.map",
      [
        ["collection", "source", true],
        ["transform_value", "transform"],
      ],
      // Only the scalar mapping path is modelled; the object-literal form stores
      // a different `output_type` and falls through to `raw()`.
      { output_type: "value" },
    ),
  ],
  [
    "mvp:array_union",
    contextValues("array.union", [
      ["left", "source", true],
      ["right", "with"],
      ["transform_value", "transform"],
    ]),
  ],
  ["mvp:realtime_event", realtimeEvent],
  ["mvp:create_auth", createAuthToken],
  ["mvp:guid", createGuid],
  ["mvp:action_package", actionPackageCall],
  ["mvp:workspace_run_workflow_test", workflowTestCall],
]);
