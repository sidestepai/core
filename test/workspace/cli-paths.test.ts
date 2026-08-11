import { describe, it, expect, vi, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/emit/cli.js";
import { serializeLock, LOCK_VERSION } from "../../src/lock/lock.js";
import { deriveGuid } from "../../src/refs/guid.js";

/** Write a xano.lock in a fresh temp dir and return its path. */
function writeLock(objects: Record<string, { guid?: string; canonical?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "sidestep-paths-lock-"));
  const path = join(dir, "xano.lock");
  writeFileSync(path, serializeLock({ version: LOCK_VERSION, objects }), "utf8");
  return path;
}

/** Capture everything a command writes to stdout during `fn()`. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return out;
}

const resolvedEntry = fileURLToPath(new URL("../fixtures/paths-workspace/index.ts", import.meta.url));
const noCanonEntry = fileURLToPath(new URL("../fixtures/paths-no-canonical/index.ts", import.meta.url));
const fnModule = fileURLToPath(new URL("../fixtures/function-module.ts", import.meta.url));

describe("sidestep paths", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists each query's verb + resolved api:<canonical>/<name> (in-code canonical, no lock)", async () => {
    const out = await captureStdout(() => run(["paths", resolvedEntry]));
    // Both queries, with their real verbs and the /api:<canonical>/<name> path.
    expect(out).toMatch(/GET\s+\/api:abc12345\/links_list\s+api:abc12345\/links_list/);
    expect(out).toMatch(/POST\s+\/api:abc12345\/links_create\s+api:abc12345\/links_create/);
    // The leading slash on "/links_create" is stripped in the emitted path.
    expect(out).not.toContain("/api:abc12345//links_create");
  });

  it("distinct verbs are preserved and rows are sorted by path", async () => {
    const out = await captureStdout(() => run(["paths", resolvedEntry]));
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(2);
    // Sorted by (canonical, name): links_create before links_list.
    expect(lines[0]).toContain("links_create");
    expect(lines[1]).toContain("links_list");
  });

  it("`routes` is an alias producing identical output", async () => {
    const viaPaths = await captureStdout(() => run(["paths", resolvedEntry]));
    const viaRoutes = await captureStdout(() => run(["routes", resolvedEntry]));
    expect(viaRoutes).toBe(viaPaths);
  });

  it("errors with the export --lock fix when a canonical can't resolve", async () => {
    await expect(run(["paths", noCanonEntry])).rejects.toThrow(/export --lock/);
    await expect(run(["paths", noCanonEntry])).rejects.toThrow(/links_list/);
  });

  it("resolves a group's canonical from the lock (no in-code canonical)", async () => {
    // The paths-no-canonical fixture's group "internal" has no in-code canonical;
    // a lock entry supplies the frozen token, keyed by group name.
    const lock = writeLock({
      "app:internal": { guid: deriveGuid("app", "internal"), canonical: "LockTok9" },
    });
    try {
      const out = await captureStdout(() => run(["paths", noCanonEntry, `--lock=${lock}`]));
      expect(out).toMatch(/GET\s+\/api:LockTok9\/links_list\s+api:LockTok9\/links_list/);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  });

  it("does NOT mint a canonical for a group absent from an existing lock (#145 read-only)", async () => {
    // A lock exists but doesn't know this group. `paths` must NOT invent a token
    // (export()'s applyLock would mint a random one) — it must report unresolved,
    // because a minted-but-unpersisted token would differ from the deployed URL.
    const lock = writeLock({
      "app:someOtherGroup": { guid: deriveGuid("app", "someOtherGroup"), canonical: "Unrelated1" },
    });
    try {
      const out = await captureStdout(() =>
        run(["paths", noCanonEntry, `--lock=${lock}`]).catch(() => {}),
      );
      // No fabricated token leaked to stdout...
      expect(out).not.toContain("/api:");
      // ...and the command fails with the actionable fix.
      await expect(run(["paths", noCanonEntry, `--lock=${lock}`])).rejects.toThrow(/export --lock/);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  });

  it("rejects a module that does not default-export a Xano registry", async () => {
    await expect(run(["paths", fnModule])).rejects.toThrow(/must default-export a Xano/);
  });
});
