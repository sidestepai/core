/**
 * Lock-aware `sidestep export` CLI (U4).
 *
 * Node's module cache means a workspace entry is evaluated ONCE per process —
 * and reference guids bake at evaluation. So every scenario that needs a
 * differently-seeded evaluation writes a FRESH temp-dir copy of the fixture
 * source (unique path → unique module → fresh eval), and the store is
 * reset-then-seeded per run by the CLI itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../src/emit/cli.js";
import { deriveGuid } from "../../src/refs/guid.js";
import { parseLock, serializeLock, LOCK_VERSION, type LockFile } from "../../src/lock/lock.js";
import { resetLockOverrides } from "../../src/lock/store.js";

const SDK = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

function spyOnWrite(stream: NodeJS.WriteStream) {
  return vi.spyOn(stream, "write").mockImplementation(() => true);
}

let dir: string;
let stderrSpy: ReturnType<typeof spyOnWrite>;
let stdoutSpy: ReturnType<typeof spyOnWrite>;
let fileSeq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sidestep-cli-lock-"));
  stderrSpy = spyOnWrite(process.stderr);
  stdoutSpy = spyOnWrite(process.stdout);
});

afterEach(() => {
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
  resetLockOverrides();
  rmSync(dir, { recursive: true, force: true });
});

/** Write a fresh workspace entry (unique filename → fresh module eval). */
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

function readLockAt(path = join(dir, "xano.lock")): LockFile {
  return parseLock(readFileSync(path, "utf8"), path);
}

function stderrText(): string {
  return stderrSpy.mock.calls.map((c) => String(c[0])).join("");
}

function stdoutText(): string {
  return stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
}

describe("sidestep export --lock", () => {
  it("creates xano.lock with every exported identity; bundle guids equal lock guids", async () => {
    const entry = writeWorkspace("sayHello");
    const outPath = join(dir, "bundle.json");
    await run(["export", entry, "--lock", "--out", outPath]);
    const lock = readLockAt();
    const bundle = JSON.parse(readFileSync(outPath, "utf8"));
    const fn = bundle.payload.function[0];
    const app = bundle.payload.app[0];
    expect(lock.objects["function:sayHello"]).toEqual({ guid: fn.guid });
    expect(lock.objects["app:public"]).toEqual({ guid: app.guid, canonical: app.canonical });
    expect(app.canonical).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(Object.keys(lock.objects).sort()).toEqual(["app:public", "function:sayHello"]);
  });

  it("steady-state re-export changes neither the lock bytes nor the bundle", async () => {
    const entry = writeWorkspace("sayHello");
    const out1 = join(dir, "b1.json");
    const out2 = join(dir, "b2.json");
    await run(["export", entry, "--lock", "--out", out1]);
    const lockPath = join(dir, "xano.lock");
    const lockBytes = readFileSync(lockPath, "utf8");
    const mtime = statSync(lockPath).mtimeMs;
    // Second run auto-reads the lock (no --lock flag needed).
    await run(["export", entry, "--out", out2]);
    expect(readFileSync(lockPath, "utf8")).toBe(lockBytes);
    expect(statSync(lockPath).mtimeMs).toBe(mtime); // idempotent write skipped
    expect(readFileSync(out2, "utf8")).toBe(readFileSync(out1, "utf8"));
  });

  it("a rename warns on stderr with the exact fix-up command; lock keeps the orphan and gains the newcomer", async () => {
    await run(["export", writeWorkspace("oldName"), "--lock", "--out", join(dir, "b1.json")]);
    const out2 = join(dir, "b2.json");
    await run(["export", writeWorkspace("newName"), "--out", out2]);
    const err = stderrText();
    expect(err).toContain(`xano.lock entry "function:oldName" matches no exported object`);
    expect(err).toContain("sidestep lock rename function oldName <new-name>");
    expect(err).toContain("new function names this export: newName");
    // Unlocked-name behavior: the bundle carries the NEW md5 guid…
    const bundle = JSON.parse(readFileSync(out2, "utf8"));
    expect(bundle.payload.function[0].guid).toBe(deriveGuid("function", "newName"));
    // …and the lock keeps the orphan alongside the new entry.
    const lock = readLockAt();
    expect(lock.objects["function:oldName"]).toEqual({ guid: deriveGuid("function", "oldName") });
    expect(lock.objects["function:newName"]).toEqual({ guid: deriveGuid("function", "newName") });
  });

  it("after a lock-rename fix-up the export emits the ORIGINAL guid under the new name", async () => {
    await run(["export", writeWorkspace("oldName"), "--lock", "--out", join(dir, "b1.json")]);
    // Simulate `sidestep lock rename function oldName newName` by hand-editing
    // (hand-editing is a supported fix-up path).
    const lockPath = join(dir, "xano.lock");
    const lock = readLockAt(lockPath);
    const entry = lock.objects["function:oldName"]!;
    delete lock.objects["function:oldName"];
    lock.objects["function:newName"] = entry;
    writeFileSync(lockPath, serializeLock(lock), "utf8");
    const out2 = join(dir, "b2.json");
    await run(["export", writeWorkspace("newName"), "--out", out2]);
    const bundle = JSON.parse(readFileSync(out2, "utf8"));
    expect(bundle.payload.function[0].guid).toBe(deriveGuid("function", "oldName"));
    expect(readLockAt().objects["function:newName"]).toEqual({
      guid: deriveGuid("function", "oldName"),
    });
  });

  it("a corrupt lock file fails before the workspace module is imported", async () => {
    const entry = join(dir, "ws-corrupt.ts");
    const marker = join(dir, "imported.marker");
    writeFileSync(
      entry,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "imported");
export default {};
`,
      "utf8",
    );
    writeFileSync(join(dir, "xano.lock"), `{"version":1,"objects":{"function:a":{"guid":"x"},"function:a":{"guid":"y"}}}`, "utf8");
    await expect(run(["export", entry])).rejects.toThrow(/duplicate key "function:a"/);
    expect(existsSync(marker)).toBe(false);
  });

  it("warnings never land on stdout when the bundle streams to stdout", async () => {
    await run(["export", writeWorkspace("oldName"), "--lock", "--out", join(dir, "b1.json")]);
    stdoutSpy.mockClear(); // drop the setup run's "Wrote …" notice
    await run(["export", writeWorkspace("newName")]); // rename → orphan warning, bundle → stdout
    const outText = stdoutText();
    expect(JSON.parse(outText).app).toBe("xano"); // stdout is pure bundle JSON
    expect(outText).not.toContain("sidestep:");
    expect(stderrText()).toContain("matches no exported object");
  });

  it("writes the lock before the bundle (bundle write failure leaves the lock updated)", async () => {
    const entry = writeWorkspace("sayHello");
    const badOut = join(dir, "missing-dir", "bundle.json"); // writeFileSync will throw
    await expect(run(["export", entry, "--lock", "--out", badOut])).rejects.toThrow();
    expect(readLockAt().objects["function:sayHello"]).toEqual({
      guid: deriveGuid("function", "sayHello"),
    });
  });

  it("warns on stderr when a reverted rename drops the stale lock entry", async () => {
    await run(["export", writeWorkspace("oldName"), "--lock", "--out", join(dir, "b1.json")]);
    // Simulate the `lock rename` fix-up, then revert the code rename: the old
    // name re-derives the pinned guid and the moved entry is dropped.
    const lockPath = join(dir, "xano.lock");
    const lock = readLockAt(lockPath);
    lock.objects["function:newName"] = lock.objects["function:oldName"]!;
    delete lock.objects["function:oldName"];
    writeFileSync(lockPath, serializeLock(lock), "utf8");
    await run(["export", writeWorkspace("oldName"), "--out", join(dir, "b2.json")]);
    expect(stderrText()).toContain('Dropped stale lock entry "function:newName"');
    expect(readLockAt(lockPath).objects["function:newName"]).toBeUndefined();
  });

  it("fails before writing lock or bundle when two api groups share an explicit canonical", async () => {
    const entry = join(dir, `ws-dup-canon.ts`);
    writeFileSync(
      entry,
      `import { Xano, apiGroup } from ${JSON.stringify(SDK)};
export default new Xano()
  .registerWorkspace({ name: "locktest" })
  .registerApiGroups([
    apiGroup({ name: "a", canonical: "SameTok1" }),
    apiGroup({ name: "b", canonical: "SameTok1" }),
  ]);
`,
      "utf8",
    );
    const outPath = join(dir, "bundle.json");
    await expect(run(["export", entry, "--lock", "--out", outPath])).rejects.toThrow(
      /share the same canonical \(SameTok1\)/,
    );
    expect(existsSync(join(dir, "xano.lock"))).toBe(false);
    expect(existsSync(outPath)).toBe(false);
  });

  it("missing lock without --lock prints an FYI on stderr and exports unlocked", async () => {
    const entry = writeWorkspace("sayHello");
    await run(["export", entry, "--out", join(dir, "b.json")]);
    // Guidance, not a problem: an info `i` line, NOT the warning `!` glyph, so a
    // clean lockless export doesn't scan as a warning in CI logs (#8).
    expect(stderrText()).toContain("Exporting without xano.lock");
    expect(stderrText()).toMatch(/i Exporting without xano\.lock/);
    expect(stderrText()).not.toMatch(/! Exporting without xano\.lock/);
    expect(existsSync(join(dir, "xano.lock"))).toBe(false);
    const bundle = JSON.parse(readFileSync(join(dir, "b.json"), "utf8"));
    expect(bundle.payload.app[0].canonical).toBe(""); // no minting when unlocked
  });

  it("--lock=<path> overrides the lock location", async () => {
    const entry = writeWorkspace("sayHello");
    const custom = join(dir, "custom.lock");
    await run(["export", entry, `--lock=${custom}`, "--out", join(dir, "b.json")]);
    expect(existsSync(custom)).toBe(true);
    expect(existsSync(join(dir, "xano.lock"))).toBe(false);
  });
});

describe("sidestep export --frozen-lock", () => {
  it("fails when no lock exists", async () => {
    const entry = writeWorkspace("sayHello");
    await expect(run(["export", entry, "--frozen-lock"])).rejects.toThrow(
      /--frozen-lock: no xano\.lock found/,
    );
  });

  it("passes on a steady-state export", async () => {
    const entry = writeWorkspace("sayHello");
    await run(["export", entry, "--lock", "--out", join(dir, "b1.json")]);
    await run(["export", entry, "--frozen-lock", "--out", join(dir, "b2.json")]);
    expect(readFileSync(join(dir, "b2.json"), "utf8")).toBe(
      readFileSync(join(dir, "b1.json"), "utf8"),
    );
  });

  it("fails without touching the lock or writing the bundle when the export would change it", async () => {
    await run(["export", writeWorkspace("oldName"), "--lock", "--out", join(dir, "b1.json")]);
    const lockPath = join(dir, "xano.lock");
    const before = readFileSync(lockPath, "utf8");
    const out2 = join(dir, "b2.json");
    await expect(
      run(["export", writeWorkspace("newName"), "--frozen-lock", "--out", out2]),
    ).rejects.toThrow(/--frozen-lock: this export would change/);
    expect(readFileSync(lockPath, "utf8")).toBe(before);
    expect(existsSync(out2)).toBe(false);
  });
});

describe("sidestep compile with an adjacent lock", () => {
  it("emits locked reference guids in the single-function artifact", async () => {
    const pinned = "adopted-target-guid-0000000";
    const lock: LockFile = {
      version: LOCK_VERSION,
      objects: { "function:target": { guid: pinned } },
    };
    writeFileSync(join(dir, "xano.lock"), serializeLock(lock), "utf8");
    const entry = join(dir, "caller.ts");
    writeFileSync(
      entry,
      `import { defineFunction, s } from ${JSON.stringify(SDK)};
export default defineFunction({ name: "caller", stack: [s.function.run({ fn: "target" })] });
`,
      "utf8",
    );
    const outPath = join(dir, "caller.json");
    mkdirSync(join(dir, "sub"), { recursive: true }); // unrelated; keeps dir nonempty on cleanup races
    await run(["compile", entry, "--out", outPath]);
    const artifact = JSON.parse(readFileSync(outPath, "utf8"));
    const call = artifact.run.find((s: { name: string }) => s.name === "mvp:function");
    expect(call.context.function.id).toBe(pinned);
  });
});
