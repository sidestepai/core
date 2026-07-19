/**
 * Query (API endpoint) kind (U7) → payload key `query`. Function-like
 * (input/run/result) plus HTTP fields: `verb`, `app` (api_group binding),
 * `auth`, `response_type`, `cache`, `output`. Validated against
 * `cloud-client: …/transform-temp/schema:query.json`.
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
import { emptyMiddleware, defaultHistory, encodeTags } from "./common.js";
import type { MiddlewareBlock } from "./common.js";
import type { ApiGroupDef } from "./api-group.js";
import { resolveRef } from "../refs/guid.js";
import { lockKey } from "../lock/lock.js";
import { getLockedCanonical } from "../lock/store.js";

export type HttpVerb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

/**
 * `QueryDef` is generic over its `input` map `I` so a consumer can recover the
 * exact, branded input types via `InferInput<typeof myQuery>` (see
 * `src/inputs/infer.ts`). The default keeps every existing use — a bare
 * `QueryDef` — working unchanged.
 */
export interface QueryDef<I extends Record<string, InputDescriptor> = Record<string, InputDescriptor>> {
  name: string;
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
  /** false (no auth) or an auth table id. */
  auth?: boolean | number;
  description?: string;
  docs?: string;
  responseType?: "standard" | "stream";
  apiEnabled?: boolean;
  disabled?: boolean;
  cache?: Partial<CacheXdo>;
  /** Workspace tags (stored `tag: [{tag}]`), e.g. `["xano:quick-start"]`. */
  tags?: string[];
  input?: I;
  stack?: Statement[];
  response?: ResponseDef;
}

/**
 * A `query()` handle: the def plus a `getPath()` method. It stays a plain data
 * descriptor with one added method — the method is dropped by `JSON.stringify`
 * and ignored by `encodeQuery`, so serialization and conformance are unaffected.
 */
export type QueryHandle<I extends Record<string, InputDescriptor> = Record<string, InputDescriptor>> =
  QueryDef<I> & {
    /**
     * The endpoint's **group-relative** URL path — `/api:<canonical>/<name>` —
     * ready to prepend a host and drop into `fetch`. The api group's `canonical`
     * is resolved from the bound `apiGroup` handle (or `opts.canonical`); it
     * throws if neither is available (an empty canonical is minted into
     * `xano.lock` at export and is not knowable from the def alone). The HTTP
     * verb is available separately as `<query>.verb`.
     */
    getPath(opts?: { canonical?: string }): string;
  };

export interface QueryXdo {
  name: string;
  description: string;
  docs: string;
  api_enabled: boolean;
  auth: boolean | number;
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

export function encodeQuery(def: QueryDef): QueryXdo {
  if (!def.name) throw new Error("query: `name` is required.");
  if (!def.verb) throw new Error("query: `verb` is required.");
  warnUnboundReturn("query", def.name, def.stack, def.response);
  return {
    name: def.name,
    description: def.description ?? "",
    docs: def.docs ?? "",
    api_enabled: def.apiEnabled ?? true,
    auth: def.auth ?? false,
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
    middleware: emptyMiddleware(),
    tag: encodeTags(def.tags),
    history: defaultHistory("query"),
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
function resolveCanonical(def: QueryDef, override?: string): string {
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
export function query<const I extends Record<string, InputDescriptor> = Record<never, never>>(
  def: QueryDef<I>,
): QueryHandle<I> {
  // The path segment is invariant across calls; only the canonical can vary
  // (via an override), so normalize the name once here.
  const path = def.name.replace(/^\/+/, "");
  const getPath = (opts?: { canonical?: string }): string =>
    `/api:${resolveCanonical(def, opts?.canonical)}/${path}`;
  return { ...def, getPath };
}
