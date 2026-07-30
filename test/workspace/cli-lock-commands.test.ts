/**
 * `sidestep lock rename|prune|adopt` (U5).
 *
 * Same module-cache discipline as cli-lock.test.ts: each scenario that needs a
 * fresh evaluation writes its own temp-dir workspace copy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../src/emit/cli.js";
import { deriveGuid } from "../../src/refs/guid.js";
import {
  parseLock,
  serializeLock,
  LOCK_VERSION,
  type LockFile,
} from "../../src/lock/lock.js";
import { resetLockOverrides } from "../../src/lock/store.js";

const SDK = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

// Engine-style identities (random base64websafe, NOT md5-of-name).
const LIVE_FN_GUID = "AbCdEfGhIjKlMnOpQrStUvWxYz1";
const LIVE_DBO_GUID = "ZyXwVuTsRqPoNmLkJiHgFeDcB2a";
const LIVE_APP_GUID = "QwErTyUiOpAsDfGhJkLzXcVbN3m";

function spyOnWrite(stream: NodeJS.WriteStream) {
  return vi.spyOn(stream, "write").mockImplementation(() => true);
}

let dir: string;
let stderrSpy: ReturnType<typeof spyOnWrite>;
let stdoutSpy: ReturnType<typeof spyOnWrite>;
let fileSeq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sidestep-lock-cmd-"));
  stderrSpy = spyOnWrite(process.stderr);
  stdoutSpy = spyOnWrite(process.stdout);
});

afterEach(() => {
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
  resetLockOverrides();
  rmSync(dir, { recursive: true, force: true });
});

function writeLockAt(path: string, objects: LockFile["objects"]): void {
  writeFileSync(path, serializeLock({ version: LOCK_VERSION, objects }), "utf8");
}

function readLockAt(path: string): LockFile {
  return parseLock(readFileSync(path, "utf8"), path);
}

function writeWorkspace(fnName: string): string {
  const path = join(dir, `ws-${process.pid}-${++fileSeq}.ts`);
  writeFileSync(
    path,
    `import { Xano, defineFunction, apiGroup } from ${JSON.stringify(SDK)};
export default new Xano()
  .registerWorkspace({ name: "locktest" })
  .registerApiGroups([apiGroup({ name: "public" })])
  .registerFunctions([defineFunction({ name: ${JSON.stringify(fnName)}, stack: [] })]);
`,
    "utf8",
  );
  return path;
}

function stdoutText(): string {
  return stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
}

function stderrText(): string {
  return stderrSpy.mock.calls.map((c) => String(c[0])).join("");
}

describe("sidestep lock rename", () => {
  it("moves an entry with guid + canonical intact", async () => {
    const lockPath = join(dir, "xano.lock");
    writeLockAt(lockPath, { "app:old_api": { guid: LIVE_APP_GUID, canonical: "KeepTok1" } });
    await run(["lock", "rename", "api_group", "old_api", "new_api", `--lock=${lockPath}`]);
    expect(readLockAt(lockPath).objects).toEqual({
      "app:new_api": { guid: LIVE_APP_GUID, canonical: "KeepTok1" },
    });
    expect(stdoutText()).toContain(`"app:old_api" → "app:new_api"`);
  });

  it("replaces the fresh newcomer entry a prior export appended (the doc'd rename flow)", async () => {
    // export-after-code-rename appended `function:newName` with the fresh
    // md5 derivation; `lock rename` must overwrite it, not error.
    const lockPath = join(dir, "xano.lock");
    writeLockAt(lockPath, {
      "function:oldName": { guid: deriveGuid("function", "oldName") },
      "function:newName": { guid: deriveGuid("function", "newName") },
    });
    await run(["lock", "rename", "function", "oldName", "newName", `--lock=${lockPath}`]);
    expect(readLockAt(lockPath).objects).toEqual({
      "function:newName": { guid: deriveGuid("function", "oldName") },
    });
  });

  it("reports the newcomer's minted canonical when a rename replaces it", async () => {
    const lockPath = join(dir, "xano.lock");
    writeLockAt(lockPath, {
      "app:old_api": { guid: LIVE_APP_GUID, canonical: "KeepTok1" },
      // The fresh entry the post-rename export appended, with a minted canonical.
      "app:new_api": { guid: deriveGuid("app", "new_api"), canonical: "MintTok1" },
    });
    await run(["lock", "rename", "api_group", "old_api", "new_api", `--lock=${lockPath}`]);
    expect(readLockAt(lockPath).objects).toEqual({
      "app:new_api": { guid: LIVE_APP_GUID, canonical: "KeepTok1" },
    });
    expect(stdoutText()).toContain("minted canonical MintTok1 is discarded");
  });

  it("refuses to clobber a real pinned identity under the new name", async () => {
    const lockPath = join(dir, "xano.lock");
    writeLockAt(lockPath, {
      "function:a": { guid: deriveGuid("function", "a") },
      "function:b": { guid: LIVE_FN_GUID }, // NOT the fresh derivation → real identity
    });
    await expect(
      run(["lock", "rename", "function", "a", "b", `--lock=${lockPath}`]),
    ).rejects.toThrow(/already exists and is not the fresh name-derivation/);
  });

  it("errors on an unknown old key and accepts kind aliases", async () => {
    const lockPath = join(dir, "xano.lock");
    writeLockAt(lockPath, { "dbo:users": { guid: LIVE_DBO_GUID } });
    await expect(
      run(["lock", "rename", "table", "ghosts", "members", `--lock=${lockPath}`]),
    ).rejects.toThrow(/No lock entry "dbo:ghosts"/);
    // Alias `table` targets the dbo: entry.
    await run(["lock", "rename", "table", "users", "members", `--lock=${lockPath}`]);
    expect(readLockAt(lockPath).objects).toEqual({ "dbo:members": { guid: LIVE_DBO_GUID } });
    // Unknown kind names are rejected at the boundary.
    await expect(
      run(["lock", "rename", "gadget", "a", "b", `--lock=${lockPath}`]),
    ).rejects.toThrow(/Unknown object kind "gadget"/);
  });
});

describe("sidestep lock prune", () => {
  it("refuses without --yes, then prunes orphans (keeping live entries) with --yes", async () => {
    const entry = writeWorkspace("sayHello");
    const lockPath = join(dir, "xano.lock");
    writeLockAt(lockPath, {
      "function:sayHello": { guid: deriveGuid("function", "sayHello") },
      "app:public": { guid: deriveGuid("app", "public"), canonical: "LiveTok1" },
      "function:ghost": { guid: LIVE_FN_GUID },
      "app:gone_api": { guid: LIVE_APP_GUID, canonical: "GoneTok1" },
    });
    await expect(run(["lock", "prune", entry])).rejects.toThrow(/re-run with --yes/);
    expect(readLockAt(lockPath).objects["function:ghost"]).toBeDefined(); // untouched
    expect(stdoutText()).toContain("app:gone_api");
    expect(stdoutText()).toContain("canonical's public URL is unrecoverable");

    await run(["lock", "prune", entry, "--yes"]);
    const objects = readLockAt(lockPath).objects;
    expect(Object.keys(objects).sort()).toEqual(["app:public", "function:sayHello"]);
    expect(stdoutText()).toContain("Pruned 2 lock entr(y/ies)");
  });

  it("reports nothing to prune when every entry is live", async () => {
    const entry = writeWorkspace("sayHello");
    const lockPath = join(dir, "xano.lock");
    writeLockAt(lockPath, {
      "function:sayHello": { guid: deriveGuid("function", "sayHello") },
    });
    const before = readFileSync(lockPath, "utf8");
    await run(["lock", "prune", entry, "--yes"]);
    expect(stdoutText()).toContain("Nothing to prune");
    expect(readFileSync(lockPath, "utf8")).toBe(before);
  });

  it("prunes only the named keys, and refuses live or unknown keys", async () => {
    const entry = writeWorkspace("sayHello");
    const lockPath = join(dir, "xano.lock");
    writeLockAt(lockPath, {
      "function:sayHello": { guid: deriveGuid("function", "sayHello") },
      "function:ghost": { guid: LIVE_FN_GUID },
      "function:ghost2": { guid: LIVE_DBO_GUID },
    });
    await run(["lock", "prune", entry, "function:ghost", "--yes"]);
    const objects = readLockAt(lockPath).objects;
    expect(objects["function:ghost"]).toBeUndefined();
    expect(objects["function:ghost2"]).toBeDefined(); // not named → kept
    await expect(run(["lock", "prune", entry, "function:sayHello", "--yes"])).rejects.toThrow(
      /still matches an exported object/,
    );
    await expect(run(["lock", "prune", entry, "function:nope", "--yes"])).rejects.toThrow(
      /No lock entry "function:nope"/,
    );
  });
});

describe("sidestep lock adopt", () => {
  function liveBundle(): Record<string, unknown> {
    return {
      app: "xano",
      version: "1.03",
      type: "workspace",
      payload: {
        partial: true,
        dbo: [{ name: "users", guid: LIVE_DBO_GUID }],
        function: [{ name: "sayHello", guid: LIVE_FN_GUID }],
        app: [{ name: "public", guid: LIVE_APP_GUID, canonical: "LiveTok1" }],
        workspace: {
          name: "live-ws",
          canonical: "WsLive11",
          realtime: { canonical: "RtLive11" },
        },
      },
      sig: "irrelevant",
    };
  }

  it("seeds the lock from a live bundle, keyed per section incl. the workspace fixed key", async () => {
    const bundlePath = join(dir, "live.json");
    const lockPath = join(dir, "xano.lock");
    writeFileSync(bundlePath, JSON.stringify(liveBundle()), "utf8");
    await run(["lock", "adopt", bundlePath, `--lock=${lockPath}`]);
    expect(readLockAt(lockPath).objects).toEqual({
      "dbo:users": { guid: LIVE_DBO_GUID },
      "function:sayHello": { guid: LIVE_FN_GUID },
      "app:public": { guid: LIVE_APP_GUID, canonical: "LiveTok1" },
      workspace: { canonical: "WsLive11" },
    });
    // The legacy realtime canonical in the bundle is deliberately not adopted —
    // that key is retired and the block carries no identity this SDK mints.
    expect(stdoutText()).toContain("4 added, 0 updated");
  });

  it("re-adopt overwrites existing values — but only with --yes", async () => {
    const bundlePath = join(dir, "live.json");
    const lockPath = join(dir, "xano.lock");
    writeLockAt(lockPath, { "function:sayHello": { guid: deriveGuid("function", "sayHello") } });
    writeFileSync(bundlePath, JSON.stringify(liveBundle()), "utf8");
    await expect(run(["lock", "adopt", bundlePath, `--lock=${lockPath}`])).rejects.toThrow(
      /overwrites pinned identities — re-run with --yes/,
    );
    // Nothing written on refusal.
    expect(readLockAt(lockPath).objects["function:sayHello"]).toEqual({
      guid: deriveGuid("function", "sayHello"),
    });
    await run(["lock", "adopt", bundlePath, `--lock=${lockPath}`, "--yes"]);
    expect(readLockAt(lockPath).objects["function:sayHello"]).toEqual({ guid: LIVE_FN_GUID });
  });

  it("hard-errors on two same-named objects in one section (query verb pair)", async () => {
    const bundle = liveBundle();
    (bundle.payload as Record<string, unknown>).query = [
      { name: "posts", guid: "GuidForGetPosts0000000000001" },
      { name: "posts", guid: "GuidForPostPosts000000000002" },
    ];
    const bundlePath = join(dir, "live.json");
    writeFileSync(bundlePath, JSON.stringify(bundle), "utf8");
    await expect(run(["lock", "adopt", bundlePath, `--lock=${join(dir, "xano.lock")}`])).rejects.toThrow(
      /two "query" objects named "posts"/,
    );
  });

  it("warns about vault secrets and canonical-stripped bundles on stderr", async () => {
    const bundle = liveBundle();
    const payload = bundle.payload as Record<string, unknown>;
    payload.vault = [{ name: "OPENAI_KEY", guid: "VaultGuid0000000000000000001" }];
    // Strip every canonical, as the engine's standard partial export does.
    payload.app = [{ name: "public", guid: LIVE_APP_GUID }];
    payload.workspace = { name: "live-ws" };
    const bundlePath = join(dir, "live.json");
    writeFileSync(bundlePath, JSON.stringify(bundle), "utf8");
    await run(["lock", "adopt", bundlePath, `--lock=${join(dir, "xano.lock")}`]);
    const err = stderrText();
    expect(err).toContain("vault entr(y/ies) (secrets)");
    expect(err).toContain("no canonicals found");
  });

  it("rejects a non-bundle JSON cleanly", async () => {
    const bundlePath = join(dir, "not-a-bundle.json");
    writeFileSync(bundlePath, JSON.stringify({ hello: "world" }), "utf8");
    await expect(run(["lock", "adopt", bundlePath])).rejects.toThrow(/missing `payload`/);
    writeFileSync(bundlePath, "{broken", "utf8");
    await expect(run(["lock", "adopt", bundlePath])).rejects.toThrow(/Cannot read .* as JSON/);
    expect(existsSync(join(dir, "xano.lock"))).toBe(false);
  });

  it("adopt then export emits the adopted engine-format guids (format-agnostic store flow)", async () => {
    const bundlePath = join(dir, "live.json");
    const lockPath = join(dir, "xano.lock");
    writeFileSync(bundlePath, JSON.stringify(liveBundle()), "utf8");
    await run(["lock", "adopt", bundlePath, `--lock=${lockPath}`]);
    const entry = writeWorkspace("sayHello"); // sits beside xano.lock → auto-read
    const outPath = join(dir, "bundle.json");
    await run(["export", entry, "--out", outPath]);
    const exported = JSON.parse(readFileSync(outPath, "utf8"));
    expect(exported.payload.function[0].guid).toBe(LIVE_FN_GUID);
    expect(exported.payload.app[0].guid).toBe(LIVE_APP_GUID);
    expect(exported.payload.app[0].canonical).toBe("LiveTok1");
    expect(exported.payload.workspace.canonical).toBe("WsLive11");
  });
});
