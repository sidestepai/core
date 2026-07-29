/**
 * Aggregate `packageExport` bundle assembly (KTD-1). Mirrors the Xano engine's
 * package-migration format:
 *
 *   { app:"xano", version:"1.03", type, payload:{ partial, <kind keys...>, workspace }, sig }
 *
 * The `sig` is computed exactly as the engine's signature routine: sort the
 * top-level keys ({app,payload,type,version}), PHP-`json_encode` them, SHA1 the
 * bytes, and websafe-base64 the digest (`+/=` -> `-_.`, padding kept as `.`).
 * PHP `json_encode` escapes `/` and non-ASCII; we replicate that so the
 * signature bytes match. Byte-exact import compatibility verified against a
 * live engine import.
 */
import { sha1Bytes } from "../util/hash.js";
import type { LockFile } from "../lock/lock.js";

export const BUNDLE_APP = "xano";
export const BUNDLE_VERSION_JSON = "1.03";

/** Bundle `type` (workspace | schema | content | share). */
export type BundleType = "workspace" | "schema" | "content" | "share";

/**
 * Canonical payload key order, matching the engine's partial-export order. Each kind's
 * encoded objects land under its key; unsupported sections stay empty arrays so
 * the bundle shape matches the engine's full export.
 */
export const PAYLOAD_ARRAY_KEYS = [
  "dbo",
  "addon",
  "function",
  "middleware",
  "trigger",
  "task",
  "query",
  "tool",
  "toolset",
  "app",
  // Realtime, in dependency order: a channel resolves its server, and a message
  // resolves both. They sit after `app` so every object they can reference
  // (tables for auth, api groups) is already in place.
  "realtime_server",
  "channel",
  "message",
  "vault",
  "market_item",
  "run_install",
  "action_package_install",
  "env",
  "workflow_test",
  "service",
  "branch",
] as const;

export type PayloadArrayKey = (typeof PAYLOAD_ARRAY_KEYS)[number];

export interface BundlePayload {
  partial: boolean;
  workspace: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Bundle {
  app: string;
  version: string;
  type: BundleType;
  payload: BundlePayload;
  sig: string;
}

/**
 * Replicates the engine's canonical JSON encoding, which is what the
 * signature routine hashes. Its flags are
 * `JSON_HEX_QUOT | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS |
 *  JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE`, i.e.:
 *
 *   - `"` → `"`, `<` → `<`, `>` → `>`, `&` → `&`,
 *     `'` → `'` (the HEX_* flags — note PHP emits UPPERCASE hex here),
 *   - `/` and non-ASCII are left RAW (UNESCAPED_SLASHES/UNICODE),
 *   - other control chars (`< 0x20`) use the standard short escapes or
 *     lowercase `\u00xx`, exactly like PHP's default.
 *
 * The previous implementation post-processed `JSON.stringify` and instead
 * escaped `/` and non-ASCII (the inverse of the engine) and never applied the
 * HEX_* substitutions, so any bundle containing `'`, `"`, `<`, `>`, `&`, a
 * slash, or non-ASCII produced a signature the engine rejected with
 * "Invalid workspace signature". A recursive encoder (rather than a regex over
 * `JSON.stringify` output) is used so the `"` → `"` substitution stays
 * correct around backslashes. Byte-verified against a live engine import.
 */
function phpEncodeString(str: string): string {
  let out = '"';
  for (const ch of str) {
    const code = ch.codePointAt(0)!;
    switch (ch) {
      case '"': out += "\\u0022"; break; // JSON_HEX_QUOT
      case "\\": out += "\\\\"; break;
      case "<": out += "\\u003C"; break; // JSON_HEX_TAG
      case ">": out += "\\u003E"; break; // JSON_HEX_TAG
      case "&": out += "\\u0026"; break; // JSON_HEX_AMP
      case "'": out += "\\u0027"; break; // JSON_HEX_APOS
      case "\b": out += "\\b"; break;
      case "\f": out += "\\f"; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      default:
        // Control chars escape as lowercase `\u00xx`; everything else
        // (including `/` and multibyte unicode) is emitted raw.
        out += code < 0x20 ? "\\u" + code.toString(16).padStart(4, "0") : ch;
    }
  }
  return out + '"';
}

export function phpJsonEncode(value: unknown): string {
  if (value === null || value === undefined) return "null";
  switch (typeof value) {
    case "string":
      return phpEncodeString(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "0";
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map((v) => phpJsonEncode(v === undefined ? null : v)).join(",") + "]";
      }
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(obj)) {
        // Mirror JSON.stringify: object properties set to `undefined` are dropped.
        if (obj[key] === undefined) continue;
        parts.push(phpEncodeString(key) + ":" + phpJsonEncode(obj[key]));
      }
      return "{" + parts.join(",") + "}";
    }
    default:
      return "null";
  }
}

// Xano's websafe base64 maps `+/=` to `-_.` — note it
// maps the padding `=` to `.` rather than stripping it (so it is NOT standard
// base64url). The engine recomputes and compares byte-for-byte, so the `.` must
// be preserved or the import fails with "Invalid workspace signature".
function base64websafe(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ".");
}

/** Replicates the engine's signature routine: sort top-level keys, encode, sha1, websafe base64. */
export function calcSignatureJson(exportObj: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(exportObj).sort()) {
    sorted[key] = exportObj[key];
  }
  return base64websafe(sha1Bytes(phpJsonEncode(sorted)));
}

export interface BuildBundleArgs {
  type?: BundleType;
  partial?: boolean;
  workspace?: Record<string, unknown>;
  /** Encoded objects keyed by their payload key (e.g. function, dbo, query). */
  sections: Partial<Record<PayloadArrayKey, unknown[]>>;
  /** When exporting under a lock: lets guid-collision errors name the lock entry. */
  lock?: LockFile;
}

/**
 * Guard against two objects sharing a guid. The guid is the engine's identity
 * anchor — it upserts by guid on import — so a collision silently makes one
 * object clobber the other. Identity is derived from `(type, name)`, so the
 * usual cause is two objects of the same kind with the same name (e.g. a
 * `GET /posts` and `POST /posts` query, since a query's identity ignores its
 * verb). Surface it loudly instead of shipping a lossy bundle.
 */
function assertUniqueGuids(payload: BundlePayload, lock?: LockFile): void {
  const seen = new Map<string, string>();
  for (const key of PAYLOAD_ARRAY_KEYS) {
    const arr = payload[key];
    if (!Array.isArray(arr)) continue;
    for (const obj of arr) {
      if (!obj || typeof obj !== "object") continue;
      const guid = (obj as { guid?: unknown }).guid;
      if (typeof guid !== "string") continue;
      const name = (obj as { name?: unknown }).name;
      const label = `${key}/${typeof name === "string" ? name : "<unnamed>"}`;
      const prev = seen.get(guid);
      if (prev !== undefined) {
        // With a lock in play the usual cause shifts: after a rename fix-up the
        // moved entry still pins the old name's derivation, so a NEW object
        // taking the old name re-derives the pinned guid. Point at the entry
        // rather than the misleading "two objects share a name."
        const pinnedBy = lock
          ? Object.entries(lock.objects).find(([, e]) => e.guid === guid)?.[0]
          : undefined;
        const lockNote = pinnedBy
          ? ` This guid is pinned by lock entry "${pinnedBy}" — if that entry was moved by ` +
            `\`sidestep lock rename\`, a new object now re-derives the old name's guid. Pin a ` +
            `distinct explicit \`guid\` on the new object, or update the lock entry.`
          : ` Object identity is derived from (type, name) — two objects of the same kind ` +
            `share a name. Rename one, or pin a distinct explicit \`guid\`.`;
        throw new Error(`Duplicate object guid (${guid}) shared by "${prev}" and "${label}".` + lockNote);
      }
      seen.set(guid, label);
    }
  }
}

/**
 * A signed `type:"content"` envelope — the shape each `content/<guid>-<page>.json`
 * archive entry holds. Unlike a workspace {@link Bundle} (whose `payload` is the
 * keyed object), a content payload is a plain array of table rows the engine
 * inserts on import. Signed by the identical routine, so the engine accepts it.
 */
export interface ContentEnvelope {
  app: string;
  version: string;
  type: "content";
  payload: unknown[];
  sig: string;
}

/**
 * Wrap one page of seed rows as a signed `type:"content"` envelope. The rows are
 * emitted verbatim (already coerced to their wire shape by the caller); the sig
 * is computed over `{app,payload,type,version}` exactly as {@link buildBundle}
 * signs a workspace bundle, so both ride the same byte-exact signature routine.
 */
export function buildContentEnvelope(rows: unknown[]): ContentEnvelope {
  const unsigned = {
    app: BUNDLE_APP,
    version: BUNDLE_VERSION_JSON,
    type: "content" as const,
    payload: rows,
  };
  return { ...unsigned, sig: calcSignatureJson(unsigned) };
}

/** Assemble a signed `packageExport` bundle from encoded sections. */
export function buildBundle(args: BuildBundleArgs): Bundle {
  // The import applies workspace env vars from the TOP-LEVEL `payload.env` array,
  // not from the workspace object's own `env` field (which the import ignores).
  // Lift any authored env off the workspace object so it lands where the import
  // reads it; leave `workspace.env` empty to avoid duplicating values in the bundle.
  // (Verified against a live engine round-trip — the offline shape check can't see this.)
  const workspace: Record<string, unknown> = { ...(args.workspace ?? {}) };
  const wsEnv = workspace.env;
  const payload: BundlePayload = { partial: args.partial ?? false, workspace };
  for (const key of PAYLOAD_ARRAY_KEYS) {
    payload[key] = args.sections[key] ?? [];
  }
  // Only relocate when there are actual env vars — leave an unconfigured/empty
  // workspace object untouched (don't inject an `env` key it never had).
  if (Array.isArray(wsEnv) && wsEnv.length > 0) {
    payload.env = wsEnv;
    workspace.env = [];
  }
  assertUniqueGuids(payload, args.lock);
  const unsigned = {
    app: BUNDLE_APP,
    version: BUNDLE_VERSION_JSON,
    type: args.type ?? ("workspace" as BundleType),
    payload,
  };
  return { ...unsigned, sig: calcSignatureJson(unsigned) };
}
