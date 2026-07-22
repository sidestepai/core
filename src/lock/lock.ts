/**
 * The `xano.lock` identity lock file (feat: xano-lock).
 *
 * sidestep derives object identity deterministically — `guid = md5(payloadKey:name)`
 * (see refs/guid.ts) — so a rename silently changes the guid and the engine
 * (which upserts by `(workspace, branch, guid)` on a partial import) treats the
 * rename as delete+create. Api groups and toolsets additionally carry a
 * `canonical` (the public URL token) that the engine randomizes at creation
 * when the bundle leaves it empty, so fresh imports of the same code land on
 * different URLs.
 *
 * The lock file freezes both: every auto-derived guid and every minted
 * canonical is recorded here at export, keyed by the same `payloadKey:name`
 * seed the derivation uses (`dbo:users`, `app:public`, `function:sayHello`).
 * Workspace-level canonicals live under fixed keys (`workspace`,
 * `workspace:realtime`) — NOT keyed by the renameable workspace name.
 * Precedence at emit is: explicit in-code value > lock entry > derivation.
 * The lock records explicit values too, so later removing an explicit `guid`
 * from code resolves through the lock to the same value instead of silently
 * reverting to `md5(name)` (a delete+create on next sync).
 *
 * This module owns the lock model end to end: the file format (parse, strict
 * validation, serialize, atomic write), the export-side participation helpers
 * (`LockExportContext`, `recordObserved`, `mergeObserved` — used by
 * `Xano.export({ lock })` and the CLI), and the pure maintenance transforms
 * behind the `sidestep lock` subcommands (`renameLockEntry`, `adoptFromBundle`).
 * What it does NOT know about is emission itself — no imports from the
 * workspace/emit layers. Validation is deliberately hard-line (R11): an
 * unparseable file, unknown version, duplicate raw-text keys (a botched git
 * merge survives `JSON.parse` silently — parse keeps the last duplicate), or
 * duplicate guid/canonical values is an error. A broken lock must never
 * degrade to a silent unlocked export.
 *
 * The file is human-editable JSON; keys are sorted on write for stable diffs,
 * and hand-editing an entry is a supported fix-up path alongside the
 * `sidestep lock` subcommands.
 */
import { randomBytes } from "../util/hash.js";
import { rawDeriveGuid, REFERENCEABLE_KIND_PAYLOAD_KEYS } from "../refs/guid.js";

/** The only lock format version this build reads or writes. */
export const LOCK_VERSION = 1;

/** Fixed key for the workspace's own `canonical` (never keyed by workspace name). */
export const WORKSPACE_KEY = "workspace";
/** Fixed key for the workspace's `realtime.canonical`. */
export const WORKSPACE_REALTIME_KEY = "workspace:realtime";

/**
 * Payload keys whose objects carry an engine-tracked guid and are authorable
 * in sidestep — the valid `<payloadKey>:` prefixes for lock object keys. Derived
 * from the identity table in refs/guid.ts (the single source), so a kind added
 * there participates in locking automatically. Marketplace/install sections
 * (`vault`, `market_item`, …) are out of scope by design.
 */
export const LOCK_PAYLOAD_KEYS = new Set(Object.values(REFERENCEABLE_KIND_PAYLOAD_KEYS));

/**
 * Payload keys whose objects carry a mintable `canonical` (the public URL
 * token) — api groups and toolsets. Workspace canonicals live under the fixed
 * keys instead. Entries for any other kind must not carry a canonical.
 */
export const CANONICAL_PAYLOAD_KEYS = new Set(["app", "toolset"]);

/**
 * Kind-name aliases accepted at the CLI boundary (`sidestep lock rename table …`),
 * resolved to the payloadKey the lock actually uses: every referenceable kind
 * whose name differs from its payloadKey (`table` → `dbo`, `api_group` → `app`).
 * PayloadKeys themselves are accepted verbatim.
 */
const KIND_ALIASES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(REFERENCEABLE_KIND_PAYLOAD_KEYS).filter(([name, key]) => name !== key),
);

/** Resolve a user-facing kind name or payloadKey to the lock's payloadKey. */
export function resolvePayloadKey(kindOrPayloadKey: string): string {
  if (LOCK_PAYLOAD_KEYS.has(kindOrPayloadKey)) return kindOrPayloadKey;
  const key = REFERENCEABLE_KIND_PAYLOAD_KEYS[kindOrPayloadKey];
  if (key === undefined) {
    throw new Error(
      `Unknown object kind "${kindOrPayloadKey}". Expected one of: ` +
        `${[...LOCK_PAYLOAD_KEYS].join(", ")} (or the aliases ${Object.keys(KIND_ALIASES).join(", ")}).`,
    );
  }
  return key;
}

/** Build the lock key for an object — the same seed `deriveGuid` hashes. */
export function lockKey(payloadKey: string, name: string): string {
  return `${payloadKey}:${name}`;
}

/** One locked identity. At least one of `guid`/`canonical` is present. */
export interface LockEntry {
  guid?: string;
  canonical?: string;
}

export interface LockFile {
  version: typeof LOCK_VERSION;
  objects: Record<string, LockEntry>;
}

/** A fresh, empty lock model. */
export function emptyLock(): LockFile {
  return { version: LOCK_VERSION, objects: {} };
}

/**
 * Scan raw JSON text for duplicate keys within a single object scope.
 *
 * `JSON.parse` silently keeps the LAST duplicate — exactly what a botched git
 * merge produces (`"function:a": {…}` twice) — so the raw text is scanned
 * before parsing. Tracks string/escape state and a stack of per-object key
 * sets; a string is a key when the container is an object and the next
 * non-whitespace char is `:`.
 */
function findDuplicateRawKey(text: string): string | undefined {
  const stack: Array<Set<string> | null> = []; // Set for objects, null for arrays
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{") {
      stack.push(new Set());
      i++;
    } else if (ch === "[") {
      stack.push(null);
      i++;
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      i++;
    } else if (ch === '"') {
      // Consume the string literal.
      let j = i + 1;
      let value = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") {
          value += text[j]! + (text[j + 1] ?? "");
          j += 2;
        } else {
          value += text[j];
          j++;
        }
      }
      j++; // past closing quote
      // A key iff the next non-ws char is `:` and the container is an object.
      let k = j;
      while (k < text.length && /\s/.test(text[k]!)) k++;
      if (text[k] === ":") {
        const scope = stack[stack.length - 1];
        if (scope) {
          // Compare the DECODED key, not the raw escaped text — `"a"` and
          // `"a"` are the same key to JSON.parse, so an escape-variant
          // duplicate must not slip past the scan.
          let decoded = value;
          try {
            decoded = JSON.parse(`"${value}"`) as string;
          } catch {
            // Malformed escape — keep the raw form; JSON.parse of the whole
            // text will reject the file anyway.
          }
          if (scope.has(decoded)) return decoded;
          scope.add(decoded);
        }
      }
      i = j;
    } else {
      i++;
    }
  }
  return undefined;
}

function fail(path: string, message: string): never {
  throw new Error(`Invalid lock file ${path}: ${message}`);
}

/**
 * Parse + strictly validate lock file text. Every failure is a hard error
 * (R11) — the caller must never fall back to an unlocked export when a lock
 * file exists but is broken.
 */
export function parseLock(text: string, path = "xano.lock"): LockFile {
  const dup = findDuplicateRawKey(text);
  if (dup !== undefined) {
    fail(
      path,
      `duplicate key "${dup}" in the raw text (likely a bad merge — ` +
        `JSON keeps only the last one silently). Resolve the duplicate and re-run.`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    fail(path, `unparseable JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fail(path, "expected a top-level object.");
  }
  const obj = data as Record<string, unknown>;
  if (obj.version !== LOCK_VERSION) {
    fail(
      path,
      `unknown version ${JSON.stringify(obj.version)} (this sidestep reads version ${LOCK_VERSION}). ` +
        `Upgrade sidestep to a release that understands this lock format.`,
    );
  }
  if (!obj.objects || typeof obj.objects !== "object" || Array.isArray(obj.objects)) {
    fail(path, "expected an `objects` map.");
  }
  return { version: LOCK_VERSION, objects: validateLockObjects(obj.objects, path) };
}

/**
 * Re-run the model-level invariants (key shape, entry shape, duplicate
 * guid/canonical values) on an in-memory lock. The CLI calls this on the
 * merged lock BEFORE writing it, so an export can never persist a lock that
 * the next run's `parseLock` would reject (e.g. two api groups given the same
 * explicit `canonical` in code).
 */
export function validateLockModel(lock: LockFile, label: string): void {
  validateLockObjects(lock.objects, label);
}

/**
 * Validate an `objects` map — key shape, entry shape, and identity-value
 * uniqueness — returning the cleaned model. Shared by `parseLock` (on-disk
 * files) and `adoptFromBundle` (a merged model built from an engine bundle).
 */
function validateLockObjects(raw: object, path: string): Record<string, LockEntry> {
  const objects: Record<string, LockEntry> = {};
  const guidOwners = new Map<string, string>();
  const canonicalOwners = new Map<string, string>();
  for (const [key, entryRaw] of Object.entries(raw as Record<string, unknown>)) {
    validateKey(key, path);
    if (!entryRaw || typeof entryRaw !== "object" || Array.isArray(entryRaw)) {
      fail(path, `entry "${key}" must be an object.`);
    }
    // Tolerate unknown extra fields within version 1 (forward compatibility);
    // only `guid`/`canonical` are read.
    const { guid, canonical } = entryRaw as Record<string, unknown>;
    if (guid !== undefined && (typeof guid !== "string" || guid === "")) {
      fail(path, `entry "${key}" has a non-string or empty \`guid\`.`);
    }
    if (canonical !== undefined && (typeof canonical !== "string" || canonical === "")) {
      fail(path, `entry "${key}" has a non-string or empty \`canonical\`.`);
    }
    if (guid === undefined && canonical === undefined) {
      fail(path, `entry "${key}" carries neither \`guid\` nor \`canonical\`.`);
    }
    // Identity values only make sense on the kinds that carry them: workspace
    // keys are canonical-only, and only api groups / toolsets mint canonicals.
    // A misplaced value is almost certainly a hand-edit mistake that would
    // otherwise sit silently unused.
    const isWorkspaceKey = key === WORKSPACE_KEY || key === WORKSPACE_REALTIME_KEY;
    if (isWorkspaceKey && guid !== undefined) {
      fail(path, `entry "${key}" cannot carry a \`guid\` (workspace identities are canonical-only).`);
    }
    if (!isWorkspaceKey && canonical !== undefined) {
      const prefix = key.slice(0, key.indexOf(":"));
      if (!CANONICAL_PAYLOAD_KEYS.has(prefix)) {
        fail(
          path,
          `entry "${key}" cannot carry a \`canonical\` — only ` +
            `${[...CANONICAL_PAYLOAD_KEYS].join("/")} objects and the workspace keys have one.`,
        );
      }
    }
    // A guid (or canonical) is an identity — two entries sharing one would
    // make the engine upsert two objects onto one row (or serve two APIs from
    // one URL token). Refuse the file outright.
    if (typeof guid === "string") {
      const owner = guidOwners.get(guid);
      if (owner !== undefined) {
        fail(path, `entries "${owner}" and "${key}" share the same guid (${guid}).`);
      }
      guidOwners.set(guid, key);
    }
    if (typeof canonical === "string") {
      const owner = canonicalOwners.get(canonical);
      if (owner !== undefined) {
        fail(path, `entries "${owner}" and "${key}" share the same canonical (${canonical}).`);
      }
      canonicalOwners.set(canonical, key);
    }
    const entry: LockEntry = {};
    if (typeof guid === "string") entry.guid = guid;
    if (typeof canonical === "string") entry.canonical = canonical;
    objects[key] = entry;
  }
  return objects;
}

/**
 * Keys are either the fixed workspace keys or `<payloadKey>:<name>`. A
 * `workspace:<anything-else>` key is REJECTED (not normalized): the workspace
 * section has exactly two lockable identities, and a stray
 * `workspace:my-app`-style key is almost certainly a hand-edit mistake that
 * would otherwise sit silently unused.
 */
function validateKey(key: string, path: string): void {
  if (key === WORKSPACE_KEY || key === WORKSPACE_REALTIME_KEY) return;
  const idx = key.indexOf(":");
  const prefix = idx === -1 ? key : key.slice(0, idx);
  const name = idx === -1 ? "" : key.slice(idx + 1);
  if (prefix === "workspace") {
    fail(
      path,
      `key "${key}" is not a lockable workspace identity ` +
        `(only "${WORKSPACE_KEY}" and "${WORKSPACE_REALTIME_KEY}" exist).`,
    );
  }
  if (idx === -1 || name === "" || !LOCK_PAYLOAD_KEYS.has(prefix)) {
    fail(
      path,
      `key "${key}" is not \`<payloadKey>:<name>\` with a known payload key ` +
        `(${[...LOCK_PAYLOAD_KEYS].join(", ")}).`,
    );
  }
}

/** Serialize with sorted keys (stable diffs) and a trailing newline. */
export function serializeLock(lock: LockFile): string {
  const objects: Record<string, LockEntry> = {};
  for (const key of Object.keys(lock.objects).sort()) {
    const src = lock.objects[key]!;
    // Field order inside an entry is fixed too (guid, canonical).
    const entry: LockEntry = {};
    if (src.guid !== undefined) entry.guid = src.guid;
    if (src.canonical !== undefined) entry.canonical = src.canonical;
    objects[key] = entry;
  }
  return JSON.stringify({ version: lock.version, objects }, null, 2) + "\n";
}

/**
 * Mint a canonical: 8 chars of websafe base64 from crypto randomness, the
 * engine's canonical format. Random (NOT name-derived — a
 * canonical is a public URL token; deriving it from names would make API paths
 * guessable). This is the repo's only intentional randomness; determinism is
 * preserved because a minted value is immediately frozen in the lock.
 */
export function mintCanonical(): string {
  // 6 random bytes → exactly 8 base64 chars, no padding.
  let bin = "";
  for (const b of randomBytes(6)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_");
}

// ---------------------------------------------------------------------------
// Export-side lock participation (used by `Xano.export({ lock })` and the CLI)
// ---------------------------------------------------------------------------

/**
 * The channel between the CLI (or a programmatic caller) and `Xano.export()`.
 * The caller creates it from the validated on-disk lock; `export()` MUTATES it,
 * filling `observed` with every identity the bundle actually emitted. The
 * caller then merges `observed` back into the lock via {@link mergeObserved}.
 *
 * `observed` (not the global override store) is the write-back source so a
 * process exporting multiple workspaces cannot leak one workspace's entries
 * into another's lock file.
 */
export interface LockExportContext {
  /** The validated lock the export runs against (empty for a first lock). */
  lock: LockFile;
  /** Filled by `export()`: lock key → identity actually emitted in the bundle. */
  observed: Record<string, LockEntry>;
}

/** Create the context `Xano.export({ lock })` fills. */
export function createLockContext(lock: LockFile = emptyLock()): LockExportContext {
  return { lock, observed: {} };
}

/**
 * Record one emitted identity into `ctx.observed`, hard-erroring on an
 * explicit-vs-lock guid split (R3): within one bundle every reference resolves
 * through the seeded lock, so an object whose payload guid disagrees with its
 * lock entry would ship a bundle where references point at a guid the target
 * no longer carries — never emit that silently.
 */
export function recordObserved(
  ctx: LockExportContext,
  key: string,
  identity: LockEntry,
): void {
  // Two exported objects collapsing onto one lock key can only happen with
  // DISTINCT explicit guids (identical guids die in assertUniqueGuids): e.g. a
  // GET/POST query verb pair sharing a name, each pinning its own guid. The
  // lock keys by (type, name) and cannot represent both — silently recording
  // last-wins would wedge the NEXT export on an explicit-vs-lock conflict, so
  // refuse at the first locked export instead.
  const prior = ctx.observed[key];
  if (
    prior?.guid !== undefined &&
    identity.guid !== undefined &&
    prior.guid !== identity.guid
  ) {
    throw new Error(
      `Two exported objects collapse onto lock key "${key}" with different guids ` +
        `(${prior.guid} vs ${identity.guid}) — likely two same-kind objects sharing a name ` +
        `(a query verb pair). The lock keys identity by (type, name) and cannot track both; ` +
        `rename one of the objects.`,
    );
  }
  const entry = ctx.lock.objects[key];
  if (identity.guid !== undefined && entry?.guid !== undefined && identity.guid !== entry.guid) {
    if (identity.guid === rawDeriveGuid(key)) {
      // The payload carries the plain name-derivation while the lock pins a
      // different value — the overrides were never seeded, so references baked
      // at authoring time disagree with the lock.
      throw new Error(
        `"${key}" emitted its name-derived guid (${identity.guid}) but xano.lock pins ` +
          `${entry.guid}. The lock overrides were not seeded before the workspace module ` +
          `loaded — programmatic exports must call seedLockOverrides(lock) before importing ` +
          `any def module (the CLI does this automatically).`,
      );
    }
    throw new Error(
      `"${key}" has an explicit guid (${identity.guid}) that differs from its xano.lock ` +
        `entry (${entry.guid}), so references resolved through the lock would split from ` +
        `the object itself. Update the xano.lock entry to the explicit guid, or remove ` +
        `the explicit guid from code, then re-export.`,
    );
  }
  ctx.observed[key] = { ...ctx.observed[key], ...identity };
}

/** Result of `renameLockEntry`. */
export interface RenameResult {
  lock: LockFile;
  /** A fresh name-derived entry the export already appended for the new name, replaced by the move. */
  discardedNewcomer?: LockEntry;
}

/**
 * Move a lock entry to a new name keeping its identity values (R7), so the
 * next export emits the ORIGINAL guid under the new name and the engine
 * renames in place.
 *
 * The normal sequence is rename-in-code → export (which warns about the
 * orphan and appends a fresh entry for the new name) → `lock rename`. So an
 * existing entry under the new key is expected — but ONLY when it is the
 * fresh name-derivation the export just appended. That newcomer is replaced
 * (its guid was never the object's real identity; a canonical minted for it is
 * discarded and reported). Any OTHER entry under the new key is a real pinned
 * identity and the rename refuses to clobber it.
 */
export function renameLockEntry(
  lock: LockFile,
  payloadKey: string,
  oldName: string,
  newName: string,
): RenameResult {
  const oldKey = lockKey(payloadKey, oldName);
  const newKey = lockKey(payloadKey, newName);
  const entry = lock.objects[oldKey];
  if (entry === undefined) {
    throw new Error(
      `No lock entry "${oldKey}". \`lock rename\` moves an existing entry — check the kind and ` +
        `old name (kinds accept payload keys or the aliases table/api_group).`,
    );
  }
  const objects = { ...lock.objects };
  let discardedNewcomer: LockEntry | undefined;
  const existing = objects[newKey];
  if (existing !== undefined) {
    if (existing.guid !== rawDeriveGuid(newKey)) {
      throw new Error(
        `Lock entry "${newKey}" already exists and is not the fresh name-derivation ` +
          `(it pins ${existing.guid ?? "a canonical"}). Refusing to overwrite a real identity — ` +
          `resolve the conflict by hand-editing xano.lock if this is intended.`,
      );
    }
    discardedNewcomer = existing;
  }
  delete objects[oldKey];
  objects[newKey] = { ...entry };
  return { lock: { version: lock.version, objects }, discardedNewcomer };
}

/** One entry-level change `adoptFromBundle` would apply. */
export interface AdoptChange {
  key: string;
  before: LockEntry;
  after: LockEntry;
}

/** Result of `adoptFromBundle`. */
export interface AdoptResult {
  lock: LockFile;
  /** Keys newly added to the lock. */
  added: string[];
  /** Existing entries whose values the bundle overwrites. */
  changed: AdoptChange[];
  /** True when at least one adopted object carried a canonical. */
  canonicalsSeen: boolean;
  /** Number of `vault` payload entries in the source bundle (secrets!). */
  vaultCount: number;
}

/**
 * Seed/update the lock from a live engine `packageExport` bundle (R9) —
 * capturing the workspace's random guids and canonicals by `(type, name)` so
 * an existing workspace can be adopted into code without a delete+create sync.
 *
 * Adopted values win over existing lock values field-by-field; a lock-held
 * canonical is KEPT when the bundle has none for that object (the engine's
 * standard partial export strips canonicals — erasing ours would lose minted
 * values). Two same-named objects in one section (e.g. a GET/POST query verb
 * pair) are a hard error: the lock keys by `(type, name)` and silently keeping
 * one of the two would weld the wrong identity onto both.
 */
export function adoptFromBundle(lock: LockFile, bundle: unknown, bundlePath: string): AdoptResult {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error(`${bundlePath} is not a packageExport bundle (expected a top-level object).`);
  }
  const payload = (bundle as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${bundlePath} is not a packageExport bundle (missing \`payload\`).`);
  }
  const sections = payload as Record<string, unknown>;
  const objects = { ...lock.objects };
  for (const key of Object.keys(objects)) objects[key] = { ...objects[key]! };
  const added: string[] = [];
  const changed: AdoptChange[] = [];
  let canonicalsSeen = false;

  const applyEntry = (key: string, incoming: LockEntry): void => {
    const before = objects[key];
    const after: LockEntry = { ...before, ...incoming };
    if (before === undefined) {
      objects[key] = after;
      added.push(key);
    } else if (before.guid !== after.guid || before.canonical !== after.canonical) {
      changed.push({ key, before, after });
      objects[key] = after;
    }
  };

  for (const payloadKey of LOCK_PAYLOAD_KEYS) {
    const arr = sections[payloadKey];
    if (!Array.isArray(arr)) continue;
    const namesSeen = new Set<string>();
    for (const obj of arr) {
      if (!obj || typeof obj !== "object") continue;
      const o = obj as { name?: unknown; guid?: unknown; canonical?: unknown };
      if (typeof o.name !== "string" || typeof o.guid !== "string" || o.guid === "") continue;
      if (namesSeen.has(o.name)) {
        throw new Error(
          `${bundlePath} contains two "${payloadKey}" objects named "${o.name}" (a query verb ` +
            `pair, most likely). The lock keys by (type, name) and cannot represent both — ` +
            `adoption aborted. Rename one of them engine-side so names are unique, then re-export ` +
            `and re-adopt.`,
        );
      }
      namesSeen.add(o.name);
      const incoming: LockEntry = { guid: o.guid };
      if (typeof o.canonical === "string" && o.canonical !== "") {
        incoming.canonical = o.canonical;
        canonicalsSeen = true;
      }
      applyEntry(lockKey(payloadKey, o.name), incoming);
    }
  }

  // Workspace canonicals land under the fixed keys.
  const ws = sections["workspace"];
  if (ws && typeof ws === "object" && !Array.isArray(ws)) {
    const w = ws as { canonical?: unknown; realtime?: { canonical?: unknown } };
    if (typeof w.canonical === "string" && w.canonical !== "") {
      canonicalsSeen = true;
      applyEntry(WORKSPACE_KEY, { canonical: w.canonical });
    }
    if (typeof w.realtime?.canonical === "string" && w.realtime.canonical !== "") {
      canonicalsSeen = true;
      applyEntry(WORKSPACE_REALTIME_KEY, { canonical: w.realtime.canonical });
    }
  }

  const vault = sections["vault"];
  const vaultCount = Array.isArray(vault) ? vault.length : 0;

  // Re-validate the merged model (duplicate guid/canonical values, key shape) —
  // engine bundles are outside our control and a broken lock must never land.
  const merged: LockFile = {
    version: lock.version,
    objects: validateLockObjects(objects, "the adopted lock"),
  };
  return { lock: merged, added: added.sort(), changed, canonicalsSeen, vaultCount };
}

/** Result of folding an export's observed identities back into the lock. */
export interface MergeResult {
  lock: LockFile;
  /** Lock keys no exported object matched — candidates for `lock rename`/`prune`. */
  orphans: string[];
  /** Orphans dropped because their GUID re-appeared under a live key. */
  dropped: string[];
  /** Orphans kept, but whose canonical was ceded to a live entry that now emits it. */
  cededCanonicals: string[];
}

/**
 * Merge observed identities into the lock (pure — returns a new model).
 *
 * Observed values win field-by-field (an explicit in-code value updates the
 * recorded one, per R2). Entries nothing matched are kept as orphans and
 * reported — renames are never guessed (R6) — with one exception: an orphan
 * whose GUID now belongs to a LIVE entry is dropped. That happens when a
 * rename is reverted after a `lock rename` fix-up (the old name re-derives the
 * pinned guid): keeping the orphan would wedge the lock on its own
 * duplicate-identity validation forever.
 *
 * A canonical-only match is NOT grounds for dropping: the orphan's guid may be
 * a real adopted engine identity, and deleting it would delete+create the
 * server object on the next rename fix-up. Instead the orphan stays (with its
 * guid) and only its canonical is ceded to the live entry that now emits it —
 * which also keeps the merged lock free of duplicate canonical values.
 */
export function mergeObserved(
  lock: LockFile,
  observed: Record<string, LockEntry>,
): MergeResult {
  const objects: Record<string, LockEntry> = {};
  for (const [key, identity] of Object.entries(observed)) {
    objects[key] = { ...lock.objects[key], ...identity };
  }
  const liveGuids = new Set(Object.values(objects).map((e) => e.guid).filter(Boolean));
  const liveCanonicals = new Set(
    Object.values(objects).map((e) => e.canonical).filter(Boolean),
  );
  const orphans: string[] = [];
  const dropped: string[] = [];
  const cededCanonicals: string[] = [];
  for (const [key, entry] of Object.entries(lock.objects)) {
    if (key in objects) continue;
    if (entry.guid !== undefined && liveGuids.has(entry.guid)) {
      dropped.push(key);
      continue;
    }
    if (entry.canonical !== undefined && liveCanonicals.has(entry.canonical)) {
      const kept: LockEntry = { ...entry };
      delete kept.canonical;
      if (kept.guid === undefined) {
        // Canonical-only entry (a workspace key) fully claimed by a live one.
        dropped.push(key);
        continue;
      }
      objects[key] = kept;
      orphans.push(key);
      cededCanonicals.push(key);
      continue;
    }
    objects[key] = entry;
    orphans.push(key);
  }
  return {
    lock: { version: lock.version, objects },
    orphans: orphans.sort(),
    dropped: dropped.sort(),
    cededCanonicals: cededCanonicals.sort(),
  };
}
