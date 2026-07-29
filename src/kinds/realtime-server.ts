/**
 * Realtime server (`realtime_server`) — the top-level container of Xano's
 * realtime layer, and the root of the containment chain
 * `realtime_server -> channel -> message` (the realtime analogue of
 * `api_group -> query` and `mcp_server -> tool`).
 *
 * A realtime server is branch-scoped and canonical-addressed like an API group,
 * so a workspace may own several of them and each round-trips through
 * export/import as its own object. Its existence is what marks a workspace as
 * using the current realtime layer — there is no `mode` field and no version
 * discriminator.
 *
 * Clients dial it at `wss://<instance host>/ws/<canonical>` — derive that with
 * `realtimeServer().getUrl(baseUrl)` rather than hardcoding it, and see
 * {@link RealtimeServerHandle} for the frame protocol that follows the
 * handshake.
 *
 * Two engine details this encoder honors and that are easy to get wrong:
 *  - `enabled` defaults to **false**, unlike almost every other `enabled` field
 *    in the SDK. A server you author is off until you turn it on.
 *  - `history` is the *container* tier its channels' messages inherit
 *    (`message_enabled`/`message_limit`) and it defaults **off** — message
 *    history is a hot path.
 *
 * NOTE ON DEPLOYMENT: Xano's workspace-archive import does not yet carry
 * realtime sections. Authoring, encoding, and round-tripping all work today;
 * a realtime object included in a deployed bundle is inert until the engine
 * side lands.
 */
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";
import {
  encodeContainerHistory,
  type ContainerHistoryBlock,
  type HistoryInput,
} from "./history.js";
import { resolveCanonicalToken } from "./canonical.js";

export interface RealtimeServerDef {
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  /**
   * Whether the server accepts connections. Defaults to **false** — a realtime
   * server is off until explicitly enabled. An enabled server with no active
   * channel still refuses the handshake, so ship at least one
   * `realtimeChannel()` with it.
   */
  enabled?: boolean;
  /**
   * The public URL token this server is addressed by. Omit and it is minted and
   * frozen in `xano.lock` at `sidestep export --lock`; set it explicitly to pin
   * one. Never generated at encode time — a canonical must be unique per Xano
   * instance across all workspaces.
   */
  canonical?: string;
  /**
   * Server-level message-history default — the container tier this server's
   * channels' messages inherit (stored `message_enabled`/`message_limit`). Omit
   * to inherit from the branch/workspace. Defaults **off**: message history is a
   * hot path. A scalar: `false` off, `true` on at default depth, a number =
   * capture depth, `"all"` unlimited. See {@link HistoryInput}.
   */
  history?: HistoryInput;
  /** Workspace tags (stored `tag: [{tag}]`). */
  tags?: string[];
}

/**
 * The stored envelope. Note there is deliberately no `docs` key: unlike
 * `app`/`query`/`toolset`, the realtime objects do not persist one — the
 * XanoScript kind accepts `docs` but the stored record has no such field, so
 * emitting it would add a key the engine never wrote.
 */
export interface RealtimeServerXdo {
  name: string;
  description: string;
  canonical: string;
  enabled: boolean;
  history: ContainerHistoryBlock<"message">;
  tag: Array<{ tag: string }>;
}

/**
 * Resolve a realtime server's `canonical` URL token, in priority order:
 * an explicit override, the def's own non-empty `canonical`, then the value
 * minted-and-frozen in `xano.lock` under `realtime_server:<name>`.
 *
 * Deliberately never mints: a canonical must be unique per Xano *instance
 * across all workspaces*, so the only safe place to generate one is
 * `export --lock` (random, collision-checked, then frozen so every later export
 * and every client agrees). Mirrors the api-group and toolset resolvers.
 */
export function resolveRealtimeServerCanonical(
  def: { name: string; canonical?: string },
  override?: string,
): string {
  return resolveCanonicalToken("realtime server", "realtime_server", "getCanonical", def, override);
}

export function encodeRealtimeServer(def: RealtimeServerDef): RealtimeServerXdo {
  if (!def.name) throw new Error("realtimeServer: `name` is required.");
  return {
    name: def.name,
    description: def.description ?? "",
    canonical: def.canonical ?? "",
    enabled: def.enabled ?? false,
    history: encodeContainerHistory("message", def.history),
    tag: encodeTags(def.tags),
  };
}

export const realtimeServerKind: ObjectKind<RealtimeServerDef, RealtimeServerXdo> = {
  name: "realtime_server",
  payloadKey: "realtime_server",
  encode: encodeRealtimeServer,
};
registerKind(realtimeServerKind);

/** Options for {@link RealtimeServerHandle.getPath}/`getUrl`/`getCanonical`. */
export interface RealtimeUrlOptions {
  /** Override the resolved `canonical` URL token (bypasses the def/lock lookup). */
  canonical?: string;
  /**
   * Address a TENANT's isolated database instead of the instance's own
   * workspace. Rides as a `<tenant>:<canonical>` prefix on the socket path; the
   * websocket tier splits it and applies the tenant's database before resolving
   * the canonical, so a bare canonical would resolve against the wrong
   * workspace. Omit for a normal (non-tenant) instance.
   */
  tenant?: string;
}

/** Reject a tenant name that would break the `<tenant>:<canonical>` split. */
function assertTenant(tenant: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(tenant)) {
    throw new Error(
      `realtime server: invalid \`tenant\` ${JSON.stringify(tenant)} — a tenant name is alphanumeric with dashes ` +
        `(e.g. "xxxx-xxxx-xxxx"). It rides as a "<tenant>:<canonical>" prefix, so ":" and "/" cannot appear in it.`,
    );
  }
  return tenant;
}

/**
 * A `realtimeServer()` handle: the def plus `getCanonical()` and the websocket
 * connection accessors `getPath()`/`getUrl()`, so a client derives its socket
 * URL from the def instead of hardcoding it (the same derive-don't-hardcode
 * contract `query.getPath()` and `mcpServer().getUrl()` give). The accessors are
 * dropped by `JSON.stringify` and ignored by `encodeRealtimeServer`, so
 * serialization is unaffected (mirrors {@link McpServerHandle}).
 *
 * WIRE PROTOCOL (what to do once the socket is open), for reference:
 *  - Auth is a bearer token carried as the websocket SUBPROTOCOL
 *    (`new WebSocket(url, token)` — `Sec-WebSocket-Protocol`), not a query
 *    param. No token = an anonymous client, admitted only by channels with
 *    `anonymousClients: true`.
 *  - The server builds its context during the handshake; a frame sent
 *    immediately after `open` can be refused as not-ready. Wait out a short
 *    settle window before the first frame — there is no explicit ready frame.
 *  - Client frames are JSON `{ action, channel, type?, payload?, options?, id? }`
 *    where `action` is `join` | `leave` | `broadcast` | `ack`, `channel` is the
 *    resolved channel path (`realtimeChannel().getChannel()`) and `type` is the
 *    `realtimeMessage()` name. You must `join` before you may `broadcast`.
 *  - Server frames carry `action`: `join` (ack — with `params`, plus
 *    `cursor`/`resumed` on an `at_least_once` channel), `message`, `replay`,
 *    `presence_full`/`presence_join`/`presence_leave`,
 *    `conversation_start`/`conversation_end` (replayed transcript frames are
 *    flagged `conversation: true` so they are distinguishable from live
 *    traffic), and `error` (`payload.message`, plus `payload.code` /
 *    `payload.retry_after` when rate limited). An `error` is a per-frame
 *    refusal, not a disconnect.
 */
export type RealtimeServerHandle = RealtimeServerDef & {
  /** The server's resolved `canonical` token; throws if none resolves. */
  getCanonical(opts?: { canonical?: string }): string;
  /**
   * The websocket connection PATH — `/ws/<canonical>`, or
   * `/ws/<tenant>:<canonical>` when `tenant` is given — ready to prepend a host
   * to. The `canonical` is resolved from the def's `canonical` (or
   * `opts.canonical`, or the value frozen in `xano.lock`); it throws if none
   * resolves.
   */
  getPath(opts?: RealtimeUrlOptions): string;
  /**
   * The absolute websocket URL — `baseUrl` + {@link getPath}, with the scheme
   * normalized to `ws`/`wss` (`https://x.xano.io` → `wss://x.xano.io/ws/…`), so
   * the instance base URL you already have can be passed straight in.
   *
   * A remote host must end up `wss://`: instances do not serve plain websockets
   * and browsers block a `ws://` socket from an https page — both surface as an
   * opaque 1006 close with no reason. Pass `https://…` (or `wss://…`) for
   * anything but a local dev server.
   */
  getUrl(baseUrl: string, opts?: RealtimeUrlOptions): string;
};

/**
 * Author a realtime server — the container that owns realtime channels.
 * Returns a {@link RealtimeServerHandle}: the def plus `getCanonical()` and
 * `getPath()`/`getUrl()`.
 *
 * Pass the handle (not a bare name) to `realtimeChannel({ server })` so the
 * channel and the server agree on identity even when the server pins an
 * explicit `guid`.
 */
export function realtimeServer(def: RealtimeServerDef): RealtimeServerHandle {
  const getCanonical = (opts?: { canonical?: string }): string =>
    resolveRealtimeServerCanonical(def, opts?.canonical);
  const getPath = (opts?: RealtimeUrlOptions): string => {
    const canonical = getCanonical(opts);
    const prefix = opts?.tenant ? `${assertTenant(opts.tenant)}:` : "";
    return `/ws/${prefix}${canonical}`;
  };
  const getUrl = (baseUrl: string, opts?: RealtimeUrlOptions): string => {
    const base = baseUrl.trim().replace(/\/+$/, "");
    if (!base) throw new Error("realtimeServer: `getUrl` needs a base URL (e.g. \"https://x.dev.xano.io\").");
    // http(s) is what a caller has on hand (the instance base URL); ws(s) is
    // what a socket needs. A scheme-less host is assumed secure — the only
    // scheme a deployed instance accepts.
    const socketBase = /^wss?:\/\//i.test(base)
      ? base
      : /^https?:\/\//i.test(base)
        ? base.replace(/^http/i, "ws")
        : `wss://${base}`;
    return `${socketBase}${getPath(opts)}`;
  };
  return { ...def, getCanonical, getPath, getUrl };
}
