/**
 * Query (API endpoint) kind (U7) → payload key `query`. Function-like
 * (input/run/result) plus HTTP fields: `verb`, `app` (api_group binding),
 * `auth`, `response_type`, `cache`, `output`. Validated against
 * the Xano engine's persisted shape.
 */
import type { ResultItemXdo, StackItemXdo, InputXdo, CacheXdo } from "../types/xdo.js";
import { encodeStatement } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { encodeResponse, warnUnboundReturn } from "../responses/response.js";
import type { ResponseDef } from "../responses/response.js";
import { encodeInput } from "../inputs/input.js";
import type { InputDescriptor } from "../inputs/input.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";
import { encodeHistory, type HistoryInput } from "./history.js";
import type { MiddlewareBlock } from "./common.js";
import { buildMiddlewareBlock } from "./middleware-attach.js";
import type { MiddlewareAttach } from "./middleware-attach.js";
import type { ApiGroupDef } from "./api-group.js";
import type { TableDef } from "./table.js";
import { resolveRef } from "../refs/guid.js";
import { resolveAuthRef } from "../refs/auth.js";
import { lockKey } from "../lock/lock.js";
import { getLockedCanonical } from "../lock/store.js";
import {
  parsePathParams,
  assertPathParamInputs,
  fillPathParams,
  type IsStaticPath,
  type PathParamValues,
} from "./path-params.js";

export type HttpVerb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

/**
 * `QueryDef` is generic over its `input` map `I` so a consumer can recover the
 * exact, branded input types via `InferInput<typeof myQuery>` (see
 * `src/inputs/infer.ts`), and over its declared response shape `Res` so
 * `InferResponse<typeof myQuery>` (see `src/responses/infer.ts`) recovers the
 * read shape. Both default so every existing use — a bare `QueryDef` — works
 * unchanged; `Res` defaults to `never` (undeclared), which routes
 * `InferResponse` to automatic derivation.
 */
export interface QueryDef<
  I extends Record<string, InputDescriptor> = Record<string, InputDescriptor>,
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  S extends readonly Statement[] = readonly Statement[],
  N extends string = string,
> {
  /**
   * The endpoint path within its api group — the last segment(s) of
   * `/api:<canonical>/<name>`.
   *
   * A `{param}` segment makes it a URL PATH PARAM: `"blog/{slug}"` binds the
   * segment to the `slug` input, and segments chain
   * (`"blog/{slug}/review/{review_id}"`). Every `{param}` MUST have a matching
   * `input` entry declared `required: true` with a scalar type, or `query()`
   * throws — a marker with no input deploys as a permanently-broken route. There
   * are no wildcards or patterns, and a `{param}` is always a whole segment
   * (`"post-{slug}"` is an error). Inputs that are not in the path are ordinary
   * query-string/body params and need nothing special.
   *
   * Captured as a literal so `getPath({ params })` types its keys from it.
   */
  name: N;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  verb: HttpVerb;
  /**
   * The API group this query belongs to — an `apiGroup()` def or its name.
   * Resolved to the group's guid (which the engine remaps to a local id on
   * import), so the binding is stable across syncs. Prefer this over the raw
   * numeric `apiGroupId`. Pass the def handle when the group sets an explicit `guid`.
   */
  apiGroup?: ApiGroupDef | string;
  /** Escape hatch: a raw numeric `app.id`. Takes precedence over `apiGroup`. */
  apiGroupId?: number;
  /**
   * The authentication table backing this endpoint, or `false`/omitted for a
   * public (no-auth) endpoint. Pass the auth `table()` def — the table marked
   * `table({ auth: true })` — and `export()` resolves it to that table's guid
   * (the engine remaps guid→local id on import), so the binding is stable across
   * syncs. A bare table name resolves the same way, but pass the def handle when
   * the table pins an explicit `guid`: a bare name derives its guid from the name
   * alone and would diverge from the pinned identity. A raw numeric `dbo.id` is
   * an escape hatch that wins when given. Xano supports any number of auth
   * tables, so name the one this endpoint authenticates against; `export()`
   * rejects a reference that isn't a registered auth table. Once set, read the
   * authenticated record inside the stack with the `auth("path")` value ref.
   *
   * Unlike `apiGroup`, the numeric escape hatch lives in this same field rather
   * than a separate `authId`: `auth` is a single terminal value with no second
   * consumer (the `apiGroup` handle also feeds `getPath()`'s `canonical`, which
   * is why *it* needs the symbolic ref and the raw id to coexist as two fields).
   */
  auth?: false | TableDef | string | number;
  description?: string;
  docs?: string;
  responseType?: "standard" | "stream";
  apiEnabled?: boolean;
  disabled?: boolean;
  cache?: Partial<CacheXdo>;
  /**
   * Pre/post middleware attachment. `middleware: { pre: [mw], post: [...] }`
   * runs the listed middleware around this endpoint's stack. Providing a phase
   * sets its `_customize` flag (override); omitting it inherits from the API
   * group, then the workspace (the engine resolves the chain — SideStep emits
   * the flags and lists). `pre: middleware.clear()` overrides with nothing
   * (stop inheriting). Reference a `middleware()` def handle or its name.
   *
   * A `pre` middleware runs **after** auth resolution, so `auth()` is available
   * inside the middleware when this endpoint is authenticated (its `auth` names
   * an auth table). On a public endpoint (`auth` unset) `auth()` is `null` — so
   * keying a rate limit by `auth("id")` on a public endpoint collapses every
   * caller into one shared bucket. `export()` **warns** (never blocks) when an
   * `auth()`-keyed middleware is attached here and this endpoint has no auth table.
   */
  middleware?: MiddlewareAttach;
  /**
   * Request-history capture. Omit to inherit (API group → workspace). A scalar:
   * `false` off, `true` on at default depth, a number = capture depth, `"all"`
   * unlimited. Any value stops inheriting. See {@link HistoryInput}.
   */
  history?: HistoryInput;
  /** Workspace tags (stored `tag: [{tag}]`), e.g. `["xano:quick-start"]`. */
  tags?: string[];
  input?: I;
  /**
   * The endpoint's statement stack. Captured as the literal tuple `S` (via
   * `query()`'s `const` inference) so `InferResponse` can trace a single-variable
   * response back to the branded `db.get`/`db.query` that bound it (U5). A
   * dynamically-built `Statement[]` widens `S` and the trace degrades to
   * `unknown` — the override (`responseShape`) remains the escape hatch.
   */
  stack?: S;
  /**
   * The response assignment: a single {@link Value} (returned directly) or a
   * record of named values (an object with those keys). Captured as the literal
   * `Resp` so `InferResponse` can auto-derive object-literal keys (U2) and, with
   * the branded stack, trace a single-variable response (U5).
   */
  response?: Resp;
  /**
   * Type-only: declare the endpoint's response shape so
   * `InferResponse<typeof query>` recovers it exactly (the always-correct
   * override, taking precedence over automatic derivation). Reuse the read-side
   * types you already have — e.g. `responseShape: [] as InferRow<typeof link>[]`
   * for a list, or `null as InferRow<typeof s> | null` for a get. Use it for
   * responses the static walk can't see (filters, lambdas, control-flow vars).
   * The runtime value is ignored by `encodeQuery`; only its type is read.
   */
  responseShape?: Res;
}

/**
 * A `query()` handle: the def plus `getPath()` and `toSearchParams()`. It stays
 * a plain data descriptor with two added methods — they are dropped by
 * `JSON.stringify` and ignored by `encodeQuery`, so serialization and
 * conformance are unaffected.
 */
export type QueryHandle<
  I extends Record<string, InputDescriptor> = Record<string, InputDescriptor>,
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  S extends readonly Statement[] = readonly Statement[],
  N extends string = string,
> = QueryDef<I, Res, Resp, S, N> & {
    /**
     * The endpoint's **group-relative** URL path — `/api:<canonical>/<name>` —
     * ready to prepend a host and drop into `fetch`. The api group's `canonical`
     * is resolved from the bound `apiGroup` handle (or `opts.canonical`); it
     * throws if neither is available (an empty canonical is minted into
     * `xano.lock` at export and is not knowable from the def alone). The HTTP
     * verb is available separately as `<query>.verb`.
     *
     * When the name carries `{param}` segments, `params` is REQUIRED and its
     * keys are exactly those params — `getPath({ params: { slug: "hello" } })`
     * → `/api:blog/blog/hello`. It throws on a missing, empty, or unknown param,
     * and on a value containing `/` (which would address a different route).
     */
    getPath: IsStaticPath<N> extends true
      ? (opts?: { canonical?: string }) => string
      : (opts: { canonical?: string; params: PathParamValues<N> }) => string;
    /**
     * Serialize this endpoint's inputs into a GET query string, dropping the
     * ones bound to `{param}` path segments — those already ride in the path via
     * {@link getPath}, and sending them twice is how `?slug=` ends up alongside
     * `/blog/hello`. Otherwise identical to the free {@link toSearchParams}
     * (which has no view of the route and so keeps every key).
     */
    toSearchParams: {
      (input: Record<string, SearchParamValue>): URLSearchParams;
      (input: Record<string, unknown>): URLSearchParams;
    };
  };

export interface QueryXdo {
  name: string;
  description: string;
  docs: string;
  api_enabled: boolean;
  /** `false` (no auth), the auth table's guid, or a raw numeric `dbo.id`. */
  auth: false | number | string;
  response_type: string;
  verb: HttpVerb;
  disabled: boolean;
  /** The api group binding: a numeric local id, or the group's guid (the portable form). */
  app: { id: number | string };
  cache: CacheXdo;
  output: unknown[];
  middleware: MiddlewareBlock;
  tag: unknown[];
  history: { inherit: boolean; enabled: boolean; limit: number };
  input: InputXdo[];
  result: ResultItemXdo[];
  run: StackItemXdo[];
  test: unknown[];
  example: Record<string, unknown>;
  market_item: { id: number; version: number; guid: string };
}

function defaultCache(override?: Partial<CacheXdo>): CacheXdo {
  return {
    active: false,
    ttl: 3600,
    input: true,
    auth: true,
    datasource: true,
    ip: false,
    headers: [],
    env: [],
    ...override,
  };
}

/**
 * Resolve a query's `auth` to what the engine stores: `false` (no auth), a raw
 * numeric `dbo.id` (escape hatch), or the auth table's guid. Shared with toolset
 * tools via {@link resolveAuthRef} — a `TableDef` handle or bare table name
 * flows through `resolveRef("dbo", …)` (the same guid path `apiGroup` uses), so
 * the reference stays stable across syncs and any number of auth tables coexist.
 *
 * This runs per-def with no registry visibility, so it validates only what a
 * single def can prove (a `TableDef` handle's own `auth` flag; a plausible id).
 * A *bare-name* reference can't be checked here — `Xano.export()` cross-checks
 * the resolved guid against the registered auth tables.
 */
function resolveAuth(name: string, auth: QueryDef["auth"]): false | number | string {
  return resolveAuthRef("query", name, auth);
}

/**
 * Validate the endpoint path against the input map and return the `{param}`
 * names it declares. Shared by `query()` (authoring time — the error fires on
 * the line the author wrote) and `encodeQuery` (the backstop).
 */
function assertQueryPathParams(
  def: Pick<QueryDef<Record<string, InputDescriptor>, unknown>, "name" | "input">,
): string[] {
  const context = `query "${def.name}"`;
  const params = parsePathParams(context, def.name);
  assertPathParamInputs(context, params, def.input);
  return params;
}

export function encodeQuery(def: QueryDef<Record<string, InputDescriptor>, unknown>): QueryXdo {
  if (!def.name) throw new Error("query: `name` is required.");
  if (!def.verb) throw new Error("query: `verb` is required.");
  // Re-check the path↔input contract here, not just in `query()`: `QueryDef` is
  // public and the kind registry encodes plain objects, so a hand-built def must
  // not be able to route around the guard.
  assertQueryPathParams(def);
  warnUnboundReturn("query", def.name, def.stack, def.response);
  return {
    name: def.name,
    description: def.description ?? "",
    docs: def.docs ?? "",
    api_enabled: def.apiEnabled ?? true,
    auth: resolveAuth(def.name, def.auth),
    response_type: def.responseType ?? "standard",
    verb: def.verb,
    disabled: def.disabled ?? false,
    // The engine binds a query to its api group by the group's guid (export
    // maps id→guid, import remaps guid→local id). Deriving that guid from the
    // group's name is stateless and stable across syncs. A numeric `apiGroupId`
    // is an explicit escape hatch and wins when given.
    app: {
      id:
        def.apiGroupId ??
        (def.apiGroup !== undefined ? resolveRef("app", def.apiGroup) : 0),
    },
    cache: defaultCache(def.cache),
    output: [],
    middleware: buildMiddlewareBlock(def.middleware),
    tag: encodeTags(def.tags),
    history: encodeHistory("query", def.history),
    input: Object.entries(def.input ?? {}).map(([name, d]) => encodeInput(name, d)),
    result: encodeResponse(def.response),
    run: (def.stack ?? []).map(encodeStatement),
    test: [],
    example: {},
    market_item: { id: 0, version: 0, guid: "" },
  };
}

export const queryKind: ObjectKind<QueryDef, QueryXdo> = {
  name: "query",
  payloadKey: "query",
  encode: encodeQuery,
};
registerKind(queryKind);

/**
 * Resolve the api group's `canonical` URL token for `getPath`, in priority
 * order:
 *   1. an explicit `getPath({ canonical })` override;
 *   2. the bound `apiGroup` handle's non-empty in-code `canonical`;
 *   3. the canonical minted-and-frozen in `xano.lock` for this group, read via
 *      the seeded override store (populated by `seedLockOverrides`, which the
 *      CLI and build scripts run before importing defs).
 *
 * We deliberately do NOT mint a fresh canonical here. A canonical is unique per
 * Xano *instance across all workspaces*; the only safe place to generate one is
 * `export --lock` (random, collision-checked, then frozen so every later export
 * and every client agrees). Minting at `getPath()` time would hand a frontend a
 * token that doesn't match the deployed endpoint. So when nothing is resolvable
 * we throw with the fix rather than fabricate.
 */
function resolveCanonical(
  def: QueryDef<Record<string, InputDescriptor>, unknown>,
  override?: string,
): string {
  if (override) return override;
  const group = def.apiGroup;
  if (group && typeof group === "object" && typeof group.canonical === "string" && group.canonical !== "") {
    return group.canonical;
  }
  // Fall back to the canonical minted into xano.lock for this group. The group
  // binding is a handle (`{ name }`) or a bare name string; either yields the
  // lock key `app:<name>`.
  const groupName = typeof group === "string" ? group : group?.name;
  if (groupName) {
    const locked = getLockedCanonical(lockKey("app", groupName));
    if (locked) return locked;
  }
  throw new Error(
    `query "${def.name}": getPath() cannot resolve the api group's canonical URL token. ` +
      `Set an explicit \`apiGroup({ canonical })\`, or run \`sidestep export --lock\` once (it ` +
      `mints a unique canonical and freezes it in xano.lock) and seed that lock before ` +
      `importing defs — the CLI does this automatically, and build scripts call ` +
      `seedLockOverrides(readLockFile(path)) first. As a last resort pass one directly: ` +
      `getPath({ canonical: "..." }). (Minting here is unsafe — canonicals must be unique ` +
      `per instance across all workspaces, so they are only generated at locked export.)`,
  );
}

/**
 * Author an API query. Returns a {@link QueryHandle} — the def plus a
 * `getPath()` method — and preserves the exact, branded `input` map on the
 * return type so `InferInput<typeof theQuery>` recovers the request-payload type.
 */
/**
 * The `/api:<canonical>/<name>` path's trailing `<name>` segment: the query name
 * with any leading slash stripped. Shared so a consumer reconstructing the path
 * from an exported bundle (`sidestep paths`) stays in lockstep with `getPath()`.
 */
export function pathSegment(name: string): string {
  return name.replace(/^\/+/, "");
}

function queryImpl<
  const I extends Record<string, InputDescriptor> = Record<never, never>,
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  const S extends readonly Statement[] = readonly Statement[],
  const N extends string = string,
>(def: QueryDef<I, Res, Resp, S, N>): QueryHandle<I, Res, Resp, S, N> {
  // Fail on the line the author wrote, before export and before deploy: a
  // {param} with no matching required scalar input is a broken route.
  const params = assertQueryPathParams(def as QueryDef<Record<string, InputDescriptor>, unknown>);
  const context = `query "${def.name}"`;
  // The path segment is invariant across calls; only the canonical and the
  // param values can vary, so normalize the name once here.
  const path = pathSegment(def.name);
  const getPath = (opts?: { canonical?: string; params?: Record<string, string | number> }): string =>
    `/api:${resolveCanonical(def, opts?.canonical)}/${
      params.length ? fillPathParams(context, "getPath()", path, opts?.params) : path
    }`;
  const search = (values: Record<string, unknown>): URLSearchParams =>
    toSearchParams(
      params.length
        ? Object.fromEntries(Object.entries(values).filter(([key]) => !params.includes(key)))
        : values,
    );
  return { ...def, getPath, toSearchParams: search } as QueryHandle<I, Res, Resp, S, N>;
}

/**
 * A value acceptable in a query-string param. Covers the *scalar* subset an
 * `InferInput` map yields — scalars, plus arrays of scalars (repeated as
 * `?k=a&k=b`). Nested `input.object`/`input.list` shapes are deliberately
 * excluded (no canonical query-string encoding): a literal typed against this
 * member won't type-check, and one reaching {@link toSearchParams} through the
 * wide overload throws at runtime rather than serializing to `"[object Object]"`.
 * `null`/`undefined` are dropped so an absent optional input contributes no param.
 */
export type SearchParamValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<string | number | boolean | null | undefined>;

/**
 * Serialize a query input map into {@link URLSearchParams} for a GET request —
 * `query.toSearchParams(input)`. GET endpoints carry their inputs in the query
 * string, not a JSON body; this is the transport counterpart to the scalar
 * inputs of `InferInput<typeof q>`, so a generic `fetch` wrapper doesn't have to
 * hand-roll the `?k=v` convention. Scalars stringify (`true`→`"true"`, `1`→`"1"`,
 * `0`/`false` are kept), arrays repeat the key, and `null`/`undefined` are omitted.
 *
 * Fails loud rather than emitting a garbage param: a non-finite number
 * (`NaN`/`Infinity`) or a non-primitive value (an object slipping past the type
 * via `any`) throws a {@link TypeError} instead of serializing to `"NaN"` /
 * `"[object Object]"`.
 *
 * Two call shapes, one runtime. Authored literals get {@link SearchParamValue}
 * autocomplete from the strict overload, but the wide `Record<string, unknown>`
 * overload accepts everything the strict one rejects — so a bad literal
 * type-checks here and is caught only at runtime, not at compile time. That is
 * deliberate: a generic transport that holds its endpoint input opaquely
 * (`Record<string, unknown>`, or an `InferInput<Q>` map behind a generic type
 * param) passes it with no `as` cast, and the runtime scalar guard in the body
 * below is the real check — a non-serializable value throws rather than slipping
 * through, whichever overload it came in on.
 *
 * @example
 * const q = query({ name: "get_snippet", verb: "GET", apiGroup: g, input: { id: input.int() } });
 * const url = `${BASE}${q.getPath()}?${query.toSearchParams({ id: 7 })}`;
 * @example
 * // generic GET transport — the input map is `Record<string, unknown>`, no cast
 * url += `?${query.toSearchParams(opts.input)}`;
 */
export function toSearchParams(input: Record<string, SearchParamValue>): URLSearchParams;
export function toSearchParams(input: Record<string, unknown>): URLSearchParams;
export function toSearchParams(input: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  const append = (key: string, item: string | number | boolean): void => {
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new TypeError(`toSearchParams: param "${key}" is ${item} — not a finite value`);
    }
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      throw new TypeError(`toSearchParams: param "${key}" is not a scalar (got ${typeof item})`);
    }
    params.append(key, String(item));
  };
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        append(key, item);
      }
    } else {
      append(key, value as string | number | boolean);
    }
  }
  return params;
}

/**
 * Author an API query. Callable as `query({…})`; also carries
 * {@link toSearchParams} as `query.toSearchParams(input)` for GET transport.
 */
export const query = Object.assign(queryImpl, { toSearchParams });
