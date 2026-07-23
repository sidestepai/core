/**
 * Lock-aware `Xano.export({ lock })` (U3): canonical fill/mint, observed
 * identity collection, and explicit-vs-lock conflict detection.
 *
 * NOTE: assertions run on RAW bundles — `test/helpers/normalize.ts` strips
 * `guid`, so normalized fixtures would pass vacuously here.
 */
import { describe, it, expect, afterEach } from "vitest";
import "../../src/index.js"; // register kinds + statements
import { Xano } from "../../src/workspace/xano.js";
import { defineFunction } from "../../src/function/define.js";
import { table } from "../../src/kinds/table.js";
import { tableTrigger } from "../../src/kinds/trigger.js";
import { apiGroup } from "../../src/kinds/api-group.js";
import { query } from "../../src/kinds/query.js";
import { mcpServer } from "../../src/kinds/mcp-server.js";
import { deriveGuid } from "../../src/refs/guid.js";
import {
  createLockContext,
  emptyLock,
  mergeObserved,
  LOCK_VERSION,
  type LockFile,
} from "../../src/lock/lock.js";
import { seedLockOverrides, resetLockOverrides } from "../../src/lock/store.js";

const CANON = /^[A-Za-z0-9_-]{8}$/;

afterEach(() => resetLockOverrides());

function lockWith(objects: LockFile["objects"]): LockFile {
  return { version: LOCK_VERSION, objects };
}

/** A fresh registry per test — export() mutates encoded payloads (canonical fill). */
function buildWorkspace() {
  return new Xano()
    .registerWorkspace({ name: "example" })
    .registerApiGroups([apiGroup({ name: "public" })])
    .registerFunctions([defineFunction({ name: "sayHello", stack: [] })]);
}

describe("lock-aware export", () => {
  it("mints an 8-char websafe canonical for a first locked export and reports it", () => {
    const ctx = createLockContext(emptyLock());
    const bundle = buildWorkspace().export({ lock: ctx });
    const app = (bundle.payload.app as Array<{ name: string; guid: string; canonical: string }>)[0]!;
    expect(app.canonical).toMatch(CANON);
    expect(ctx.observed["app:public"]).toEqual({ guid: app.guid, canonical: app.canonical });
    expect(ctx.observed["function:sayHello"]).toEqual({ guid: deriveGuid("function", "sayHello") });
  });

  it("emits the locked canonical (no re-mint) when the lock already carries one", () => {
    const lock = lockWith({
      "app:public": { guid: deriveGuid("app", "public"), canonical: "AbC12dEf" },
    });
    const ctx = createLockContext(lock);
    const bundle = buildWorkspace().export({ lock: ctx });
    const app = (bundle.payload.app as Array<{ canonical: string }>)[0]!;
    expect(app.canonical).toBe("AbC12dEf");
    expect(ctx.observed["app:public"]?.canonical).toBe("AbC12dEf");
  });

  it("an explicit in-code canonical is emitted verbatim and recorded — the lock never overrides it", () => {
    const lock = lockWith({
      "app:public": { guid: deriveGuid("app", "public"), canonical: "Lockd123" },
    });
    const ctx = createLockContext(lock);
    const x = new Xano()
      .registerWorkspace({ name: "example" })
      .registerApiGroups([apiGroup({ name: "public", canonical: "ExPl1cit" })]);
    const bundle = x.export({ lock: ctx });
    const app = (bundle.payload.app as Array<{ canonical: string }>)[0]!;
    expect(app.canonical).toBe("ExPl1cit");
    expect(ctx.observed["app:public"]?.canonical).toBe("ExPl1cit");
  });

  it("an explicit guid matching the lock entry exports cleanly", () => {
    const lock = lockWith({ "function:pinned": { guid: "my-explicit-guid" } });
    const ctx = createLockContext(lock);
    const x = new Xano()
      .registerWorkspace({ name: "example" })
      .registerFunctions([defineFunction({ name: "pinned", guid: "my-explicit-guid", stack: [] })]);
    const bundle = x.export({ lock: ctx });
    const fn = (bundle.payload.function as Array<{ guid: string }>)[0]!;
    expect(fn.guid).toBe("my-explicit-guid");
    expect(ctx.observed["function:pinned"]).toEqual({ guid: "my-explicit-guid" });
  });

  it("an explicit guid differing from the lock entry throws the conflict error naming both", () => {
    const lock = lockWith({ "function:pinned": { guid: "locked-guid" } });
    const ctx = createLockContext(lock);
    const x = new Xano()
      .registerWorkspace({ name: "example" })
      .registerFunctions([defineFunction({ name: "pinned", guid: "explicit-guid", stack: [] })]);
    expect(() => x.export({ lock: ctx })).toThrow(
      /"function:pinned".*explicit guid \(explicit-guid\).*\(locked-guid\).*Update the xano\.lock entry/s,
    );
  });

  it("detects an unseeded store (name-derived guid vs a lock that pins another value)", () => {
    // The lock pins a foreign guid but the store is NOT seeded, so the payload
    // carries the plain md5 derivation — the seed-before-import contract broke.
    const lock = lockWith({ "function:sayHello": { guid: "adopted-live-guid" } });
    const ctx = createLockContext(lock);
    expect(() => buildWorkspace().export({ lock: ctx })).toThrow(/seedLockOverrides/);
  });

  it("collects observed identities across all guid-bearing kinds plus workspace canonicals", () => {
    const users = table({ name: "users", schema: [] });
    const group = apiGroup({ name: "public" });
    const x = new Xano()
      .registerWorkspace({ name: "example", canonical: "WsTok11", realtime: { canonical: "RtTok11" } })
      .registerTables([users])
      .registerApiGroups([group])
      .registerFunctions([defineFunction({ name: "sayHello", stack: [] })])
      .registerQueries([query({ name: "list_users", verb: "GET", apiGroup: group })])
      .registerMcpServers([mcpServer({ name: "assistant" })])
      .registerTriggers([
        tableTrigger({ name: "on_insert", objId: 1, actions: { insert: true }, stack: () => [] }),
      ]);
    const ctx = createLockContext(emptyLock());
    x.export({ lock: ctx });
    expect(Object.keys(ctx.observed).sort()).toEqual([
      "app:public",
      "dbo:users",
      "function:sayHello",
      "query:list_users",
      "toolset:assistant",
      "trigger:on_insert",
      "workspace",
      "workspace:realtime",
    ]);
    expect(ctx.observed["dbo:users"]?.guid).toBe(deriveGuid("dbo", "users"));
    expect(ctx.observed["workspace"]).toEqual({ canonical: "WsTok11" });
    expect(ctx.observed["workspace:realtime"]).toEqual({ canonical: "RtTok11" });
    expect(ctx.observed["toolset:assistant"]?.canonical).toMatch(CANON);
  });

  it("fills an empty workspace canonical from the lock (adopt round-trip) but never mints one", () => {
    const lock = lockWith({ workspace: { canonical: "AdoptdWs" } });
    const ctx = createLockContext(lock);
    const bundle = buildWorkspace().export({ lock: ctx });
    const ws = bundle.payload.workspace as { canonical: string; realtime: { canonical: string } };
    expect(ws.canonical).toBe("AdoptdWs");
    // No lock entry for realtime → stays empty, is not minted, not observed.
    expect(ws.realtime.canonical).toBe("");
    expect(ctx.observed["workspace:realtime"]).toBeUndefined();
  });

  it("duplicate-guid error points at the lock entry after a rename fix-up collision", () => {
    // `old` was renamed to `new` + `lock rename` moved the entry (still pinning
    // md5(function:old)). A NEW object then takes the name `old` and re-derives
    // that same guid.
    const pinned = deriveGuid("function", "old");
    const lock = lockWith({ "function:new": { guid: pinned } });
    seedLockOverrides(lock);
    const ctx = createLockContext(lock);
    const x = new Xano()
      .registerWorkspace({ name: "example" })
      .registerFunctions([
        defineFunction({ name: "new", stack: [] }),
        defineFunction({ name: "old", stack: [] }),
      ]);
    expect(() => x.export({ lock: ctx })).toThrow(/pinned by lock entry "function:new"/);
  });

  it("hard-errors when two objects collapse onto one lock key with distinct explicit guids", () => {
    // A GET/POST verb pair sharing a name, each pinning its own guid: passes
    // assertUniqueGuids (guids differ) but cannot be represented by the lock.
    const ctx = createLockContext(emptyLock());
    const x = new Xano()
      .registerWorkspace({ name: "example" })
      .registerQueries([
        query({ name: "posts", verb: "GET", guid: "guid-get-posts" }),
        query({ name: "posts", verb: "POST", guid: "guid-post-posts" }),
      ]);
    expect(() => x.export({ lock: ctx })).toThrow(/collapse onto lock key "query:posts"/);
  });

  it("reuses a guid-matched orphan's canonical instead of minting (reverted rename)", () => {
    // app `old` was renamed + `lock rename`d to `new` (keeping guid+canonical),
    // then the code rename was reverted. The object re-derives its old guid; its
    // canonical must come from the moved entry, not a fresh mint.
    const pinned = deriveGuid("app", "old");
    const lock = lockWith({ "app:new": { guid: pinned, canonical: "KeptTok1" } });
    seedLockOverrides(lock);
    const ctx = createLockContext(lock);
    const x = new Xano()
      .registerWorkspace({ name: "example" })
      .registerApiGroups([apiGroup({ name: "old" })]);
    const bundle = x.export({ lock: ctx });
    const app = (bundle.payload.app as Array<{ guid: string; canonical: string }>)[0]!;
    expect(app.guid).toBe(pinned);
    expect(app.canonical).toBe("KeptTok1");
    // The merge then drops the moved entry cleanly — nothing lost.
    const { lock: merged, dropped } = mergeObserved(lock, ctx.observed);
    expect(dropped).toEqual(["app:new"]);
    expect(merged.objects["app:old"]).toEqual({ guid: pinned, canonical: "KeptTok1" });
  });

  it("a query's `auth` reference tracks a locked auth-table guid (stable across a rename)", () => {
    // The auth table's identity is frozen in the lock (e.g. it was renamed and
    // `lock rename`d). The query authenticates against it by def handle, so its
    // stored `auth` must resolve to the SAME pinned guid the table emits —
    // otherwise a re-sync would orphan the auth binding.
    const pinned = "a".repeat(32);
    const lock = lockWith({ "dbo:user": { guid: pinned } });
    seedLockOverrides(lock);
    const ctx = createLockContext(lock);
    const user = table({ name: "user", auth: true, schema: {} });
    const bundle = new Xano()
      .registerWorkspace({ name: "example" })
      .registerTables([user])
      .registerQueries([query({ name: "login", verb: "POST", auth: user })])
      .export({ lock: ctx });
    const dboGuid = (bundle.payload.dbo as Array<{ name: string; guid: string }>).find(
      (d) => d.name === "user",
    )!.guid;
    const authRef = (bundle.payload.query as Array<{ auth: string }>)[0]!.auth;
    expect(dboGuid).toBe(pinned);
    expect(authRef).toBe(pinned); // reference and target agree on the frozen guid
  });

  it("export() without options stays lock-free (canonicals empty, nothing observed)", () => {
    const bundle = buildWorkspace().export();
    const app = (bundle.payload.app as Array<{ canonical: string }>)[0]!;
    expect(app.canonical).toBe("");
  });
});

describe("mergeObserved", () => {
  const G1 = "1".repeat(32);
  const G2 = "2".repeat(32);

  it("appends new entries and keeps orphans, reporting them", () => {
    const lock = lockWith({ "function:gone": { guid: G1 } });
    const { lock: merged, orphans, dropped } = mergeObserved(lock, {
      "function:fresh": { guid: G2 },
    });
    expect(merged.objects).toEqual({
      "function:gone": { guid: G1 },
      "function:fresh": { guid: G2 },
    });
    expect(orphans).toEqual(["function:gone"]);
    expect(dropped).toEqual([]);
  });

  it("observed values win field-by-field while preserving unobserved fields", () => {
    const lock = lockWith({ "app:public": { guid: G1, canonical: "KeepMe11" } });
    const { lock: merged } = mergeObserved(lock, { "app:public": { guid: G2 } });
    expect(merged.objects["app:public"]).toEqual({ guid: G2, canonical: "KeepMe11" });
  });

  it("drops an orphan whose guid reappears under a live key (revert-after-rename)", () => {
    // `lock rename old→new` pinned md5(old) under function:new; the code rename
    // was then reverted, so `old` re-derives that same guid. Keeping the orphan
    // would wedge the lock on duplicate-guid validation forever.
    const lock = lockWith({ "function:new": { guid: G1 } });
    const { lock: merged, orphans, dropped } = mergeObserved(lock, {
      "function:old": { guid: G1 },
    });
    expect(merged.objects).toEqual({ "function:old": { guid: G1 } });
    expect(orphans).toEqual([]);
    expect(dropped).toEqual(["function:new"]);
  });

  it("a canonical-only match keeps the orphan's guid and cedes only the canonical", () => {
    // The orphan may pin a REAL adopted engine guid — deleting it because a
    // live object took its canonical (an explicit in-code value) would
    // delete+create the server object at the next rename fix-up.
    const engineGuid = "AbCdEfGhIjKlMnOpQrStUvWxYz1";
    const lock = lockWith({ "app:old_api": { guid: engineGuid, canonical: "LiveUrl1" } });
    const { lock: merged, orphans, dropped, cededCanonicals } = mergeObserved(lock, {
      "app:new_api": { guid: G2, canonical: "LiveUrl1" },
    });
    expect(merged.objects["app:old_api"]).toEqual({ guid: engineGuid }); // guid survives
    expect(merged.objects["app:new_api"]).toEqual({ guid: G2, canonical: "LiveUrl1" });
    expect(orphans).toEqual(["app:old_api"]);
    expect(cededCanonicals).toEqual(["app:old_api"]);
    expect(dropped).toEqual([]);
  });
});
