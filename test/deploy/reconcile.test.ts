import { describe, it, expect } from "vitest";
import { reconcileServerLock } from "../../src/lock/reconcile.js";
import { LOCK_VERSION, type LockFile } from "../../src/lock/lock.js";

/** Build a LockFile from an objects map. */
function lock(objects: LockFile["objects"]): LockFile {
  return { version: LOCK_VERSION, objects };
}

/** A raw server-lock JSON value (as it arrives off the deploy response). */
function serverLock(objects: Record<string, unknown>, version = LOCK_VERSION): unknown {
  return { version, objects };
}

describe("reconcileServerLock", () => {
  it("non-reset merge: server wins per key, preserves local-only, adds server-only", () => {
    const local = lock({ "dbo:users": { guid: "g1" }, "app:foo": { guid: "a1", canonical: "c1" } });
    const server = serverLock({ "app:foo": { guid: "a1", canonical: "c2" }, "dbo:posts": { guid: "g2" } });

    const out = reconcileServerLock(local, server);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.lock.objects["app:foo"]).toEqual({ guid: "a1", canonical: "c2" }); // server wins
    expect(out.lock.objects["dbo:users"]).toEqual({ guid: "g1" }); // local-only preserved
    expect(out.lock.objects["dbo:posts"]).toEqual({ guid: "g2" }); // server-only added
  });

  it("reset: replaces wholesale, dropping local-only orphan entries", () => {
    const local = lock({ "dbo:users": { guid: "g1" }, "dbo:old": { guid: "gold" } });
    const server = serverLock({ "dbo:users": { guid: "g1" } });

    const out = reconcileServerLock(local, server, { reset: true });
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(Object.keys(out.lock.objects)).toEqual(["dbo:users"]);
    expect(out.lock.objects["dbo:old"]).toBeUndefined();
  });

  it("workspace-key mismatch refuses without --adopt-workspace", () => {
    const local = lock({ workspace: { canonical: "wc1" } });
    const server = serverLock({ workspace: { canonical: "wc2" } });

    const out = reconcileServerLock(local, server);
    expect(out).toEqual({ status: "workspace-mismatch", key: "workspace", local: "wc1", server: "wc2" });
  });

  it("--adopt-workspace rebinds the workspace key to the server value", () => {
    const local = lock({ workspace: { canonical: "wc1" } });
    const server = serverLock({ workspace: { canonical: "wc2" } });

    const out = reconcileServerLock(local, server, { adoptWorkspace: true });
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.lock.objects["workspace"]).toEqual({ canonical: "wc2" });
  });

  it("a matching or absent-local workspace canonical reconciles normally", () => {
    const match = reconcileServerLock(lock({ workspace: { canonical: "wc" } }), serverLock({ workspace: { canonical: "wc" } }));
    expect(match.status).toBe("ok");
    const absent = reconcileServerLock(lock({}), serverLock({ workspace: { canonical: "wc" } }));
    expect(absent.status).toBe("ok");
  });

  it("skips (non-fatal) on a newer server lock version", () => {
    const out = reconcileServerLock(lock({}), serverLock({}, LOCK_VERSION + 1));
    expect(out.status).toBe("skip");
    if (out.status !== "skip") return;
    expect(out.reason).toMatch(/newer than this CLI/i);
  });

  it("skips on an unknown kind/key the local model would reject", () => {
    const out = reconcileServerLock(lock({}), serverLock({ "bogus:x": { guid: "g" } }));
    expect(out.status).toBe("skip");
  });

  it("skips on an absent/null server lock (leaves the caller to keep local untouched)", () => {
    expect(reconcileServerLock(lock({ "dbo:users": { guid: "g1" } }), undefined).status).toBe("skip");
    expect(reconcileServerLock(lock({}), null).status).toBe("skip");
  });

  it("first deploy with no local lock: reconciles to the server objects", () => {
    const out = reconcileServerLock(lock({}), serverLock({ "dbo:users": { guid: "g1" } }));
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.lock.objects["dbo:users"]).toEqual({ guid: "g1" });
  });

  it("skips when a merge would collide two entries on one canonical", () => {
    // A stale local rename (app:foo) whose canonical the server moved to app:bar.
    const local = lock({ "app:foo": { guid: "a1", canonical: "X" } });
    const server = serverLock({ "app:bar": { guid: "a2", canonical: "X" } });
    const out = reconcileServerLock(local, server);
    expect(out.status).toBe("skip");
  });
});
