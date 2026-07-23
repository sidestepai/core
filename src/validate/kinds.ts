/**
 * Registry of authored kinds the `sidestep validate` round-trip can read back,
 * plus the identity + matching helpers the loop uses to pair a compiled object
 * with the one the engine persisted (U1).
 *
 * A kind being *registered* here means "attempt a round-trip". Whether the
 * export actually surfaces it as a populated top-level array is decided at run
 * time by the loop: an empty fetched array demotes the whole kind to
 * `unchecked` rather than emitting a false per-object `missing` (R3) — this is
 * how nested/attached kinds like `tool` (persisted under `toolset`) stay honest.
 *
 * Deploy-target / server blobs (`workspace`, `branch`, `market_item`, `app`,
 * `vault`, `env`, `service`, `run_install`, `workflow_test`) are deliberately
 * absent: they are never authored objects, and the residual `unchecked` set is
 * an allowlist of these registered kinds, never "any payload key not listed".
 */

/** One round-trippable kind: its payload array key + the corpus/capture dir. */
export interface RoundTripKind {
  /** Payload array key in the bundle (e.g. "dbo", "function"). */
  key: string;
  /**
   * Capture/fixture subdirectory, aligned to the ACTUAL `test/fixtures/` layout
   * (KTD-5), not a blind `<key>s`. Notably `function` goldens live under
   * `statements/`, and `tool` shares `toolset/`. Kinds whose corpus dir does not
   * exist yet (`task`, `middleware`, `addon`) capture to a same-named subdir the
   * maintainer creates on first promotion.
   */
  fixtureDir: string;
  /**
   * Invocable via the meta `function/run` route (what `--runtime` smoke-runs).
   * Only `function` today; kept as kind metadata here so the `--runtime` gate
   * reads the registry instead of hardcoding a kind string elsewhere.
   */
  runnable?: boolean;
}

export const ROUND_TRIP_KINDS: RoundTripKind[] = [
  { key: "dbo", fixtureDir: "tables" },
  { key: "function", fixtureDir: "statements", runnable: true },
  { key: "query", fixtureDir: "query" },
  { key: "trigger", fixtureDir: "triggers" },
  { key: "task", fixtureDir: "task" },
  { key: "toolset", fixtureDir: "toolset" },
  { key: "tool", fixtureDir: "toolset" },
  { key: "middleware", fixtureDir: "middleware" },
  { key: "addon", fixtureDir: "addon" },
];

const FIXTURE_DIR_BY_KIND = new Map(ROUND_TRIP_KINDS.map((k) => [k.key, k.fixtureDir]));
const RUNNABLE_KINDS = new Set(ROUND_TRIP_KINDS.filter((k) => k.runnable).map((k) => k.key));

/** The capture subdir for a kind, or undefined when the kind is not registered. */
export function fixtureDirForKind(key: string): string | undefined {
  return FIXTURE_DIR_BY_KIND.get(key);
}

/** Whether a kind is invocable via the function/run route (`--runtime` smoke-run). */
export function kindIsRunnable(key: string): boolean {
  return RUNNABLE_KINDS.has(key);
}

/** Read a string field, treating "" and non-strings as absent. */
function strField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * An index of fetched objects for one kind, keyed by both `guid` and `name`, so
 * a compiled object can be matched guid-first with a name fallback. Read from
 * the RAW objects — `normalize()` strips `guid`, so matching must happen before
 * normalization.
 */
export interface IdentityIndex {
  byGuid: Map<string, Record<string, unknown>>;
  byName: Map<string, Record<string, unknown>>;
  duplicateGuids: Set<string>;
  duplicateNames: Set<string>;
}

export function indexByIdentity(objects: Array<Record<string, unknown>>): IdentityIndex {
  const byGuid = new Map<string, Record<string, unknown>>();
  const byName = new Map<string, Record<string, unknown>>();
  const duplicateGuids = new Set<string>();
  const duplicateNames = new Set<string>();
  for (const obj of objects) {
    const guid = strField(obj, "guid");
    if (guid !== undefined) {
      if (byGuid.has(guid)) duplicateGuids.add(guid);
      else byGuid.set(guid, obj);
    }
    const name = strField(obj, "name");
    if (name !== undefined) {
      if (byName.has(name)) duplicateNames.add(name);
      else byName.set(name, obj);
    }
  }
  return { byGuid, byName, duplicateGuids, duplicateNames };
}

/** How a compiled object resolved against a fetched index. */
export type MatchResolution =
  | { outcome: "found"; fetched: Record<string, unknown> }
  | { outcome: "missing" }
  | { outcome: "ambiguous" };

/**
 * Resolve one compiled object to its fetched counterpart. Prefer `guid` (the
 * engine's identity anchor, unique where a bare `name` can collide across API
 * groups); fall back to `name` when the compiled object carries no guid or its
 * guid isn't present on the fetched side. If the chosen key collides within the
 * kind, report `ambiguous` rather than guessing a match.
 */
export function resolveMatch(
  compiled: Record<string, unknown>,
  index: IdentityIndex,
): MatchResolution {
  const guid = strField(compiled, "guid");
  if (guid !== undefined && index.byGuid.has(guid)) {
    if (index.duplicateGuids.has(guid)) return { outcome: "ambiguous" };
    return { outcome: "found", fetched: index.byGuid.get(guid)! };
  }
  const name = strField(compiled, "name");
  if (name !== undefined && index.byName.has(name)) {
    if (index.duplicateNames.has(name)) return { outcome: "ambiguous" };
    return { outcome: "found", fetched: index.byName.get(name)! };
  }
  return { outcome: "missing" };
}
