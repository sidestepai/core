/**
 * Cross-object reference resolution (U10 call-family foundation).
 *
 * Xano statements that invoke another workspace object (the call family —
 * `function.run`/`function.call`/`api.call`/…) store a reference to the target.
 * In a `packageExport` bundle that reference is the target's **guid** (the
 * engine converts a local numeric id → the object's
 * guid on export, and remaps it back on import). Engine object guids are
 * 32-char lowercase hex strings (e.g. `276ca71d0ecb26851107a4383daff23b`).
 *
 * sidestep authors objects without engine ids, so it assigns its own
 * **deterministic** guids: `md5(type:name)`. Determinism is the whole trick —
 * the target object emits `deriveGuid(type, name)` as its payload `guid`, and a
 * call referencing it computes the identical guid from the same `(type, name)`,
 * so the two sides agree with no shared mutable registry. The engine remaps
 * these guids to fresh local ids on import; they only need to be unique within
 * the bundle and consistent between reference and target, which md5(type:name)
 * guarantees (names are unique per type, and the type prefix avoids cross-type
 * collisions).
 */
import { md5Hex } from "../util/hash.js";
import { getLockedGuid } from "../lock/store.js";

/**
 * Object kinds (by kind `name`) that carry a deterministic `guid` at export.
 *
 * The guid is the engine's **identity anchor**: on a partial/sync import the
 * engine matches an incoming object to an existing one by `(workspace, branch,
 * guid)` and UPDATES it in place — no guid match means a brand-new row. So a
 * *stable* guid per logical object is what makes repeated syncs idempotent
 * (same code → same guids → updates, never duplicates). Because the SDK is the
 * source of truth, we derive a stable guid from `(type, name)` by default — no
 * need to capture Xano's random guids. A def may also set an explicit `guid`
 * (used verbatim) to pin identity across a rename, or to match an object in an
 * existing Xano workspace being adopted into code.
 *
 * Every top-level object the engine tracks by guid belongs here. The guid's
 * *type* prefix is the kind's `payloadKey` (the engine's migrate type):
 * function/query/tool/task/trigger/middleware/addon map name-for-name;
 * `table` → `dbo`, `api_group` → `app`, and `mcp_server`/`agent` → `toolset`
 * (both AI primitives share the toolset migrate type). A reference (call/db
 * statement, a trigger's toolset binding, or a
 * query's `app` binding) resolves its target with that same migrate type, so
 * both sides agree.
 */
export const REFERENCEABLE_KIND_PAYLOAD_KEYS: Readonly<Record<string, string>> = {
  function: "function",
  query: "query",
  tool: "tool",
  // MCP servers and agents are distinct kinds that both persist as
  // obj_type=toolset — they share the "toolset" migrate type, so both derive
  // md5("toolset:"+name) and a same-name pair correctly collides. A trigger
  // binds either by resolving against this same "toolset" migrate type.
  mcp_server: "toolset",
  agent: "toolset",
  task: "task",
  trigger: "trigger",
  middleware: "middleware",
  addon: "addon",
  table: "dbo",
  api_group: "app",
};

export const REFERENCEABLE_KINDS = new Set(Object.keys(REFERENCEABLE_KIND_PAYLOAD_KEYS));

/**
 * A reference to another workspace object: its def handle, or a bare name.
 *
 * A def may carry an explicit `guid` (its Xano identity). When present it's used
 * verbatim; otherwise the guid is derived from `name`. Pass def handles (which
 * carry the `guid`) rather than bare names when an object sets an explicit guid,
 * so the reference and the target agree on the *same* guid.
 */
export type ObjectRef = string | { name: string; guid?: string };

/**
 * The pure name-derivation: md5 of the `type:name` seed (== the lock key),
 * with NO lock consultation. The single home of the identity formula — the
 * lock module compares against it to recognize "this guid is just the
 * derivation" (rename fix-ups, seeding-contract checks).
 */
export function rawDeriveGuid(seed: string): string {
  return md5Hex(seed);
}

/**
 * The guid for a `(type, name)` pair. A seeded `xano.lock` override wins (the
 * lock freezes identity across renames — see lock/store.ts); otherwise the
 * deterministic 32-char hex derivation. Every reference and every emitted
 * target flows through here, so a lock override propagates everywhere by
 * construction — including guids embedded inside strings at authoring time.
 */
export function deriveGuid(type: string, name: string): string {
  const seed = `${type}:${name}`;
  return getLockedGuid(seed) ?? rawDeriveGuid(seed);
}

/** Resolve a reference target (def handle or name) to the referenced object's guid. */
export function resolveRef(type: string, target: ObjectRef): string {
  if (typeof target !== "string" && target.guid) return target.guid;
  const name = typeof target === "string" ? target : target.name;
  if (!name) {
    throw new Error(`Cannot resolve ${type} reference: target has no name or guid.`);
  }
  return deriveGuid(type, name);
}
