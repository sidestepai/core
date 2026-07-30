import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCK_VERSION,
  emptyLock,
  parseLock,
  serializeLock,
  mintCanonical,
  resolvePayloadKey,
  lockKey,
  type LockFile,
} from "../../src/lock/lock.js";
import { readLockFile, writeLockFile } from "../../src/lock/io.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sidestep-lock-"));
}

describe("lock file model", () => {
  it("round-trips through serialize/parse and sorts keys", () => {
    const lock: LockFile = {
      version: LOCK_VERSION,
      objects: {
        "function:zeta": { guid: "b".repeat(32) },
        "app:public": { guid: "a".repeat(32), canonical: "AbC12dEf" },
        workspace: { canonical: "WsCanon1" },
        "dbo:users": { guid: "c".repeat(32) },
      },
    };
    const text = serializeLock(lock);
    expect(parseLock(text)).toEqual(lock);
    // Keys emerge sorted regardless of insertion order.
    const keys = Object.keys((JSON.parse(text) as LockFile).objects);
    expect(keys).toEqual([...keys].sort());
    // Serialization is stable: re-serializing the parse is byte-identical.
    expect(serializeLock(parseLock(text))).toBe(text);
  });

  it("rejects duplicate raw keys (the botched-merge case JSON.parse hides)", () => {
    const text = `{
      "version": 1,
      "objects": {
        "function:a": { "guid": "${"a".repeat(32)}" },
        "function:a": { "guid": "${"b".repeat(32)}" }
      }
    }`;
    expect(JSON.parse(text)).toBeTruthy(); // sanity: plain parse swallows it
    expect(() => parseLock(text)).toThrow(/duplicate key "function:a"/);
  });

  it("catches duplicate keys written with escape variants", () => {
    // `"function:a"` and `"function:a"` are the same key to JSON.parse —
    // the raw-text scan must compare decoded keys, not raw escaped text.
    const text = `{
      "version": 1,
      "objects": {
        "function:a": { "guid": "${"a".repeat(32)}" },
        "function:\\u0061": { "guid": "${"b".repeat(32)}" }
      }
    }`;
    expect(() => parseLock(text)).toThrow(/duplicate key "function:a"/);
  });

  it("rejects identity values on kinds that cannot carry them", () => {
    // Canonicals only exist on api groups / toolsets (and the workspace keys);
    // workspace keys are canonical-only.
    expect(() =>
      parseLock(
        `{"version":1,"objects":{"function:a":{"guid":"${"a".repeat(32)}","canonical":"Tok1"}}}`,
      ),
    ).toThrow(/cannot carry a `canonical`/);
    expect(() =>
      parseLock(`{"version":1,"objects":{"workspace":{"canonical":"Tok1","guid":"${"a".repeat(32)}"}}}`),
    ).toThrow(/cannot carry a `guid`/);
  });

  it("does not false-positive on same key names in different scopes", () => {
    const a = "a".repeat(32);
    const b = "b".repeat(32);
    const text = `{"version":1,"objects":{"function:a":{"guid":"${a}"},"function:b":{"guid":"${b}"}}}`;
    expect(() => parseLock(text)).not.toThrow();
  });

  it("rejects duplicate guid values naming both keys", () => {
    const guid = "d".repeat(32);
    const lock = {
      version: 1,
      objects: { "function:a": { guid }, "function:b": { guid } },
    };
    expect(() => parseLock(JSON.stringify(lock))).toThrow(
      /"function:a" and "function:b" share the same guid/,
    );
  });

  it("rejects duplicate canonical values naming both keys", () => {
    const lock = {
      version: 1,
      objects: {
        "app:a": { guid: "a".repeat(32), canonical: "SameTok1" },
        "app:b": { guid: "b".repeat(32), canonical: "SameTok1" },
      },
    };
    expect(() => parseLock(JSON.stringify(lock))).toThrow(
      /"app:a" and "app:b" share the same canonical/,
    );
  });

  it("rejects an unknown version with an upgrade hint", () => {
    expect(() => parseLock(`{"version":2,"objects":{}}`)).toThrow(/Upgrade sidestep/);
  });

  it("rejects unparseable JSON naming the file path", () => {
    expect(() => parseLock("{nope", "/some/dir/xano.lock")).toThrow(
      /\/some\/dir\/xano\.lock.*unparseable JSON/s,
    );
  });

  it("rejects entries with neither guid nor canonical, or malformed values", () => {
    expect(() =>
      parseLock(`{"version":1,"objects":{"function:a":{}}}`),
    ).toThrow(/neither `guid` nor `canonical`/);
    expect(() =>
      parseLock(`{"version":1,"objects":{"function:a":{"guid":42}}}`),
    ).toThrow(/non-string or empty `guid`/);
    expect(() =>
      parseLock(`{"version":1,"objects":{"function:a":{"guid":""}}}`),
    ).toThrow(/non-string or empty `guid`/);
  });

  it("tolerates unknown extra fields inside an entry (v1 forward tolerance)", () => {
    const guid = "a".repeat(32);
    const lock = parseLock(
      `{"version":1,"objects":{"function:a":{"guid":"${guid}","future":"x"}}}`,
    );
    expect(lock.objects["function:a"]).toEqual({ guid });
  });

  it("accepts the fixed workspace key and rejects workspace:<name> style keys", () => {
    const ok = { version: 1, objects: { workspace: { canonical: "Tok1" } } };
    expect(() => parseLock(JSON.stringify(ok))).not.toThrow();
    expect(() =>
      parseLock(`{"version":1,"objects":{"workspace:my-app":{"canonical":"Tok3"}}}`),
    ).toThrow(/not a lockable workspace identity/);
  });

  it("tells a stale lock that workspace:realtime is retired, not that it is a typo", () => {
    // The key this build used to write deserves a specific diagnosis — otherwise a
    // lock written by an older version reads as a hand-edit mistake.
    expect(() =>
      parseLock(`{"version":1,"objects":{"workspace:realtime":{"canonical":"Tok2"}}}`),
    ).toThrow(/retired/);
    expect(() =>
      parseLock(`{"version":1,"objects":{"workspace:realtime":{"canonical":"Tok2"}}}`),
    ).toThrow(/Remove the entry/);
  });

  it("rejects keys with unknown payload prefixes or missing names", () => {
    expect(() =>
      parseLock(`{"version":1,"objects":{"gadget:a":{"guid":"${"a".repeat(32)}"}}}`),
    ).toThrow(/known payload key/);
    expect(() =>
      parseLock(`{"version":1,"objects":{"function:":{"guid":"${"a".repeat(32)}"}}}`),
    ).toThrow(/known payload key/);
  });

  it("writes idempotently and atomically", () => {
    const dir = tempDir();
    const path = join(dir, "xano.lock");
    try {
      const lock = emptyLock();
      lock.objects[lockKey("function", "a")] = { guid: "a".repeat(32) };
      expect(writeLockFile(path, lock)).toBe(true);
      const bytes = readFileSync(path, "utf8");
      const mtime = statSync(path).mtimeMs;
      // Unchanged content is not rewritten.
      expect(writeLockFile(path, lock)).toBe(false);
      expect(statSync(path).mtimeMs).toBe(mtime);
      expect(readFileSync(path, "utf8")).toBe(bytes);
      // Changed content replaces the file, and read-back round-trips.
      lock.objects["dbo:users"] = { guid: "b".repeat(32) };
      expect(writeLockFile(path, lock)).toBe(true);
      expect(readLockFile(path)).toEqual(lock);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readLockFile reports a missing file with its path", () => {
    expect(() => readLockFile("/definitely/missing/xano.lock")).toThrow(
      /Cannot read lock file \/definitely\/missing\/xano\.lock/,
    );
  });

  it("readLockFile refuses a corrupt on-disk file", () => {
    const dir = tempDir();
    const path = join(dir, "xano.lock");
    try {
      writeFileSync(path, "{broken", "utf8");
      expect(() => readLockFile(path)).toThrow(/unparseable JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mints 8-char websafe canonicals", () => {
    for (let i = 0; i < 50; i++) {
      expect(mintCanonical()).toMatch(/^[A-Za-z0-9_-]{8}$/);
    }
  });

  it("resolves kind aliases to payload keys and rejects unknown kinds", () => {
    expect(resolvePayloadKey("table")).toBe("dbo");
    expect(resolvePayloadKey("api_group")).toBe("app");
    expect(resolvePayloadKey("dbo")).toBe("dbo");
    expect(resolvePayloadKey("function")).toBe("function");
    expect(() => resolvePayloadKey("gadget")).toThrow(/Unknown object kind "gadget"/);
  });
});
