/**
 * Spawns the BUILT `dist/bin.js` as a real subprocess.
 *
 * This is the only test that exercises the published entrypoint and Node's
 * native module loader — the two things the unit tests (which import `run()`
 * directly under vitest's already-active TS loader) structurally cannot see.
 * Both are regression guards for bugs that shipped in a published release:
 *   • the bin was inert — code-splitting moved the `import.meta.url` self-exec
 *     guard into a chunk, so `run()` never fired and `sidestep <anything>` exited
 *     0 doing nothing;
 *   • a `.ts` entry under a CommonJS consumer failed with a cryptic native
 *     SyntaxError instead of actionable guidance.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const binPath = join(repoRoot, "dist", "bin.js");

/** A temp consumer project whose bare `@sidestep/core` resolves to the build. */
function scaffold(pkgType: "module" | "commonjs", entryFile: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sidestep-bin-"));
  mkdirSync(join(dir, "node_modules", "@sidestep"), { recursive: true });
  symlinkSync(repoRoot, join(dir, "node_modules", "@sidestep", "core"), "dir");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", type: pkgType }));
  writeFileSync(
    join(dir, entryFile),
    `import { workspace, table, f } from "@sidestep/core";\n` +
      `const t = table({ name: "thing", schema: { label: f.text() } });\n` +
      `export default workspace("spawned").registerTables([t]);\n`,
  );
  return dir;
}

/** Run the bin; return status + streams without throwing on nonzero exit. */
function runBin(args: string[], cwd?: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [binPath, ...args], { encoding: "utf8", cwd });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}

describe("sidestep bin (spawned subprocess against built dist)", () => {
  beforeAll(() => {
    // Both bugs live in the BUILT artifact, so always test a fresh build.
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "ignore" });
    expect(existsSync(binPath)).toBe(true);
  }, 120_000);

  it("actually runs — an unknown command exits nonzero with usage (guards the inert-bin regression)", () => {
    const { status, stdout, stderr } = runBin(["frobnicate"]);
    // The inert bin exited 0 and printed nothing; a live one rejects the command.
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/Unknown command/);
    // The failure is designed: the ✗ headline plus the command reference — and
    // all of it on stderr, never the data channel.
    expect(stderr).toContain("✗");
    expect(stderr).toMatch(/Usage: sidestep/);
    expect(stdout).toBe("");
  });

  it("requested help exits 0 to stdout, at every depth (issue #173)", () => {
    for (const args of [["--help"], ["deploy", "--help"], ["workspace", "codegen", "--help"]]) {
      const { status, stdout, stderr } = runBin(args);
      expect(status, args.join(" ")).toBe(0);
      expect(stdout, args.join(" ")).toMatch(/Usage: sidestep/);
      // The pre-#173 failure was a module-resolution error on a file named `--help`.
      expect(stderr, args.join(" ")).not.toMatch(/Cannot find module/);
    }
  });

  it("an unknown subcommand exits nonzero and lists the real verbs", () => {
    const { status, stderr } = runBin(["workspace", "list"]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("✗");
    for (const verb of ["details", "export", "codegen"]) expect(stderr, verb).toContain(verb);
  });

  it("exports a .ts entry from an ESM consumer to a bundle file", () => {
    const dir = scaffold("module", "index.ts");
    try {
      const out = join(dir, "bundle.json");
      const { status, stderr } = runBin(["export", join(dir, "index.ts"), "--out", out], dir);
      expect(stderr).not.toMatch(/SyntaxError|Cannot use import/);
      expect(status).toBe(0);
      const bundle = JSON.parse(readFileSync(out, "utf8"));
      expect(bundle.app).toBe("xano");
      expect(bundle.payload.workspace).toMatchObject({ name: "spawned" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exports a .ts entry that imports a sibling via a `.js` specifier (needs the tsx remap)", () => {
    // The bare-import .ts test above loads under native type-stripping alone. A
    // relative `.js`→`.ts` specifier does NOT — native stripping won't remap it,
    // so this drives the tsx loader path (`importTsxApi`), which the bare-import
    // case never reaches. (The loader resolves tsx from the project first, then
    // the CLI's own tree — here the co-located repo tsx satisfies it.)
    const dir = scaffold("module", "index.ts");
    try {
      writeFileSync(
        join(dir, "thing.ts"),
        `import { table, f } from "@sidestep/core";\n` +
          `export const thing = table({ name: "thing", schema: { label: f.text() } });\n`,
      );
      writeFileSync(
        join(dir, "index.ts"),
        `import { workspace } from "@sidestep/core";\n` +
          `import { thing } from "./thing.js";\n` + // .js specifier → .ts file: the remap tsx provides
          `export default workspace("spawned").registerTables([thing]);\n`,
      );
      const out = join(dir, "bundle.json");
      const { status, stderr } = runBin(["export", join(dir, "index.ts"), "--out", out], dir);
      expect(stderr).not.toMatch(/requires `tsx`|Cannot find module/);
      expect(status).toBe(0);
      const bundle = JSON.parse(readFileSync(out, "utf8"));
      expect(bundle.payload.workspace).toMatchObject({ name: "spawned" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives an actionable error for a .ts entry in a CommonJS consumer", () => {
    const dir = scaffold("commonjs", "index.ts");
    try {
      const { status, stderr } = runBin(["export", join(dir, "index.ts"), "--out", join(dir, "b.json")], dir);
      expect(status).not.toBe(0);
      // Not the cryptic native error — the guidance that actually unblocks them.
      expect(stderr).toMatch(/ES modules/);
      expect(stderr).toMatch(/"type": "module"|\.mts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
