/**
 * U1 — the scaffold engine shared by `init` and `codegen`.
 *
 * The interesting surface is the overwrite decision and what each mode is
 * allowed to destroy, because that is where the two commands' asymmetry lives:
 * a codegen `xano/` is machine-written (refreshable without `--force`, cleared
 * before a full rescaffold), an `init` one is not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEGEN_MARKER,
  decideOverwrite,
  isNonEmptyDir,
  readMarker,
  resolveAiFlags,
  scaffoldProject,
  type ScaffoldFile,
} from "../../src/emit/scaffold.js";

// `spawnSync` cannot be spied on an ESM namespace, so the module is mocked
// outright — scaffold.ts is its only consumer here, and every install assertion
// is about whether it ran and what it returned.
const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync }));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sidestep-scaffold-"));
  spawnSync.mockReset().mockReturnValue({ status: 0 });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** A minimal two-file project: one shell file, one under `xano/`. */
const FILES: ScaffoldFile[] = [
  { path: "package.json", content: `{"name":"app"}\n` },
  { path: "xano/index.ts", content: "export default null;\n" },
];

function scaffold(target: string, over: Partial<Parameters<typeof scaffoldProject>[0]> = {}) {
  return scaffoldProject({
    targetDir: target,
    files: FILES,
    presets: [],
    appName: "app",
    force: false,
    noInstall: true,
    regenerable: false,
    ...over,
  });
}

describe("decideOverwrite", () => {
  it("writes the whole project into a missing or empty directory", () => {
    const missing = join(dir, "nope");
    expect(decideOverwrite(missing, { force: false, regenerable: true })).toBe("full");
    mkdirSync(join(dir, "empty"));
    expect(decideOverwrite(join(dir, "empty"), { force: false, regenerable: true })).toBe("full");
  });

  it("refreshes xano/ when a marker says the tree was machine-written", () => {
    const target = join(dir, "pulled");
    mkdirSync(join(target, "xano"), { recursive: true });
    writeFileSync(join(target, CODEGEN_MARKER), "{}");
    expect(decideOverwrite(target, { force: false, regenerable: true })).toBe("refresh-xano");
  });

  it("ignores the marker for a non-regenerable caller (init never refreshes)", () => {
    const target = join(dir, "pulled");
    mkdirSync(join(target, "xano"), { recursive: true });
    writeFileSync(join(target, CODEGEN_MARKER), "{}");
    expect(decideOverwrite(target, { force: false, regenerable: false })).toBe("refuse");
  });

  it("refuses a non-empty directory it did not write, unless --force", () => {
    const target = join(dir, "foreign");
    mkdirSync(target);
    writeFileSync(join(target, "mine.txt"), "keep me");
    expect(decideOverwrite(target, { force: false, regenerable: true })).toBe("refuse");
    expect(decideOverwrite(target, { force: true, regenerable: true })).toBe("full");
  });

  it("isNonEmptyDir counts dotfiles", () => {
    const target = join(dir, "dotted");
    mkdirSync(target);
    expect(isNonEmptyDir(target)).toBe(false);
    writeFileSync(join(target, ".env"), "");
    expect(isNonEmptyDir(target)).toBe(true);
  });
});

describe("scaffoldProject — writing", () => {
  it("creates intermediate directories and every file", async () => {
    const target = join(dir, "deep", "nested", "app");
    const result = await scaffold(target);
    expect(result.mode).toBe("full");
    expect(existsSync(join(target, "package.json"))).toBe(true);
    expect(existsSync(join(target, "xano", "index.ts"))).toBe(true);
  });

  it("refuses a non-empty target and writes nothing", async () => {
    const target = join(dir, "occupied");
    mkdirSync(target);
    writeFileSync(join(target, "mine.txt"), "keep me");
    await expect(scaffold(target)).rejects.toThrow(/not empty.*--force/s);
    expect(readFileSync(join(target, "mine.txt"), "utf8")).toBe("keep me");
    expect(existsSync(join(target, "package.json"))).toBe(false);
  });

  it("writes into a non-empty target with --force", async () => {
    const target = join(dir, "occupied");
    mkdirSync(target);
    writeFileSync(join(target, "mine.txt"), "keep me");
    await scaffold(target, { force: true });
    expect(existsSync(join(target, "package.json"))).toBe(true);
  });

  it("writes the selected AI presets on a full scaffold", async () => {
    const target = join(dir, "withai");
    await scaffold(target, { presets: ["claude", "cursor"] });
    expect(existsSync(join(target, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(target, ".cursor", "rules", "sidestep.mdc"))).toBe(true);
    expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
  });
});

describe("scaffoldProject — regenerable trees", () => {
  /** A project as a prior codegen run would have left it. */
  function pulled(target: string) {
    return scaffold(target, {
      regenerable: true,
      files: [...FILES, { path: CODEGEN_MARKER, content: `{"source":"workspace"}\n` }],
    });
  }

  it("refreshes xano/ on a re-run without --force, leaving the shell alone", async () => {
    const target = join(dir, "pulled");
    await pulled(target);
    writeFileSync(join(target, "package.json"), `{"name":"hand-edited"}\n`);
    writeFileSync(join(target, "extra.txt"), "mine");

    const result = await pulled(target);
    expect(result.mode).toBe("refresh-xano");
    // The shell is untouched — this is what makes re-pulling a real workflow.
    expect(readFileSync(join(target, "package.json"), "utf8")).toBe(`{"name":"hand-edited"}\n`);
    expect(readFileSync(join(target, "extra.txt"), "utf8")).toBe("mine");
    expect(existsSync(join(target, "xano", "index.ts"))).toBe(true);
  });

  it("drops files under xano/ the new tree no longer produces", async () => {
    const target = join(dir, "pulled");
    await pulled(target);
    // A stale object from the previous pull, and a hand edit. Both go: the tree
    // is disposable, and a survivor would break `tsc --noEmit` by importing
    // symbols the new barrel no longer exports.
    writeFileSync(join(target, "xano", "gone.ts"), "export const gone = 1;\n");
    writeFileSync(join(target, "xano", "mine.ts"), "// mine\n");

    await pulled(target);
    expect(existsSync(join(target, "xano", "gone.ts"))).toBe(false);
    expect(existsSync(join(target, "xano", "mine.ts"))).toBe(false);
  });

  it("preserves xano/xano.lock across a refresh", async () => {
    // The lock is not a hand edit — `deploy`/`export --lock` place it beside the
    // entry file, i.e. inside the directory a refresh removes. Losing it
    // re-derives guids for objects that already exist.
    const target = join(dir, "pulled");
    await pulled(target);
    const lock = `{"objects":{"app:notes":{"canonical":"notes"}}}\n`;
    writeFileSync(join(target, "xano", "xano.lock"), lock);

    await pulled(target);
    expect(readFileSync(join(target, "xano", "xano.lock"), "utf8")).toBe(lock);
  });

  it("clears an existing xano/ on a --force full scaffold", async () => {
    // The `init`-then-codegen case: hand-authored files would otherwise survive
    // inside the root tsconfig's `include` and fail `npm run build`.
    const target = join(dir, "authored");
    mkdirSync(join(target, "xano"), { recursive: true });
    writeFileSync(join(target, "package.json"), "{}");
    writeFileSync(join(target, "xano", "tables.ts"), "export const t = 1;\n");

    await scaffold(target, { regenerable: true, force: true });
    expect(existsSync(join(target, "xano", "tables.ts"))).toBe(false);
    expect(existsSync(join(target, "xano", "index.ts"))).toBe(true);
  });

  it("leaves an init project's xano/ alone on --force (not regenerable)", async () => {
    const target = join(dir, "authored");
    mkdirSync(join(target, "xano"), { recursive: true });
    writeFileSync(join(target, "package.json"), "{}");
    writeFileSync(join(target, "xano", "tables.ts"), "export const t = 1;\n");

    await scaffold(target, { regenerable: false, force: true });
    expect(existsSync(join(target, "xano", "tables.ts"))).toBe(true);
  });

  it("readMarker round-trips, and tolerates a corrupt one", async () => {
    const target = join(dir, "pulled");
    await pulled(target);
    expect(readMarker(target)).toEqual({ source: "workspace" });

    writeFileSync(join(target, CODEGEN_MARKER), "not json");
    expect(readMarker(target)).toBeNull();
    // A corrupt marker still proves the tree was machine-written.
    expect(decideOverwrite(target, { force: false, regenerable: true })).toBe("refresh-xano");
  });
});

describe("scaffoldProject — install", () => {
  it("--no-install spawns nothing", async () => {
    await scaffold(join(dir, "app"), { noInstall: true });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("reports a failed install without throwing — the scaffold is still valid", async () => {
    spawnSync.mockReturnValue({ status: 1 });
    const result = await scaffold(join(dir, "app"), { noInstall: false });
    expect(result.install).toBe("failed");
    expect(existsSync(join(dir, "app", "package.json"))).toBe(true);
  });

  it("reports a successful install", async () => {
    expect((await scaffold(join(dir, "app"), { noInstall: false })).install).toBe("installed");
    expect(spawnSync).toHaveBeenCalledWith(
      expect.stringMatching(/^npm/),
      ["install"],
      expect.objectContaining({ cwd: join(dir, "app") }),
    );
  });

  it("skips install on a refresh when node_modules is already there", async () => {
    const target = join(dir, "pulled");
    const files = [...FILES, { path: CODEGEN_MARKER, content: "{}\n" }];
    await scaffold(target, { regenerable: true, files });
    mkdirSync(join(target, "node_modules"), { recursive: true });

    spawnSync.mockReset();
    const result = await scaffold(target, { regenerable: true, files, noInstall: false });
    expect(result.mode).toBe("refresh-xano");
    expect(result.install).toBe("skipped");
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

describe("resolveAiFlags", () => {
  it("dedupes, clears on 'none', and rejects an unknown preset", () => {
    expect(resolveAiFlags(["claude", "claude", "cursor"])).toEqual(["claude", "cursor"]);
    expect(resolveAiFlags(["claude", "none"])).toEqual([]);
    expect(() => resolveAiFlags(["bogus"])).toThrow(/Unknown --ai preset/);
  });
});
