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
import { lockKey } from "../lock/lock.js";
import { getLockedCanonical } from "../lock/store.js";

export interface RealtimeServerDef {
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  docs?: string;
  /**
   * Whether the server accepts connections. Defaults to **false** — a realtime
   * server is off until explicitly enabled.
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

export interface RealtimeServerXdo {
  name: string;
  description: string;
  docs: string;
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
  if (override) return override;
  if (typeof def.canonical === "string" && def.canonical !== "") return def.canonical;
  const locked = getLockedCanonical(lockKey("realtime_server", def.name));
  if (locked) return locked;
  throw new Error(
    `realtime server "${def.name}": cannot resolve the \`canonical\` URL token. ` +
      `Set an explicit \`canonical\` in code, or run \`sidestep export --lock\` once (it ` +
      `mints a unique canonical and freezes it in xano.lock) and seed that lock before ` +
      `importing defs — the CLI does this automatically. As a last resort pass one ` +
      `directly (e.g. \`getCanonical({ canonical: "..." })\`). (Minting here is unsafe — ` +
      `canonicals must be unique per instance across all workspaces, so they are only ` +
      `generated at locked export.)`,
  );
}

export function encodeRealtimeServer(def: RealtimeServerDef): RealtimeServerXdo {
  if (!def.name) throw new Error("realtimeServer: `name` is required.");
  return {
    name: def.name,
    description: def.description ?? "",
    docs: def.docs ?? "",
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

/**
 * A `realtimeServer()` handle: the def plus a `getCanonical()` accessor. There
 * is no `getUrl()` — the connection URL shape for a realtime server is the
 * engine's to define, and fabricating one here would be a guess clients would
 * hardcode. The accessor is dropped by `JSON.stringify` and ignored by
 * `encodeRealtimeServer`, so serialization is unaffected (mirrors
 * {@link AgentHandle}).
 */
export type RealtimeServerHandle = RealtimeServerDef & {
  /** The server's resolved `canonical` token; throws if none resolves. */
  getCanonical(opts?: { canonical?: string }): string;
};

/**
 * Author a realtime server — the container that owns realtime channels.
 * Returns a {@link RealtimeServerHandle}: the def plus `getCanonical()`.
 *
 * Pass the handle (not a bare name) to `realtimeChannel({ server })` so the
 * channel and the server agree on identity even when the server pins an
 * explicit `guid`.
 */
export function realtimeServer(def: RealtimeServerDef): RealtimeServerHandle {
  const getCanonical = (opts?: { canonical?: string }): string =>
    resolveRealtimeServerCanonical(def, opts?.canonical);
  return { ...def, getCanonical };
}
