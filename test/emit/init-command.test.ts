import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../../src/emit/cli.js";
import {
  runInitCommand,
  sanitizeAppName,
  resolveAiFlags,
} from "../../src/emit/init-command.js";
import {
  coreDep,
  renderPackageJson,
  renderReadme,
  renderTsconfig,
  renderViteConfig,
  renderXanoIndex,
} from "../../src/emit/init-templates.js";
import {
  GUIDANCE_SENTINEL,
  renderClaudeMd,
  renderAgentsMd,
  renderCursorRules,
} from "../../src/emit/init-ai-presets.js";

// Identifiers that would leak Xano source-internal naming (project CLAUDE.md R10).
// Kept deliberately small — asserts scaffold text stays third-party-neutral.
const BANNED = ["cloud-master", "cloud-client", "cloud-frontend", "x2 ", "orchestrator"];

describe("parseArgs — init flags (U1)", () => {
  it("defaults init flags", () => {
    const a = parseArgs(["init"]);
    expect(a.command).toBe("init");
    expect(a.file).toBeUndefined();
    expect(a.ai).toEqual([]);
    expect(a.force).toBe(false);
    expect(a.noInstall).toBe(false);
  });

  it("takes the target dir as positionals[0]", () => {
    expect(parseArgs(["init", "my-app"]).positionals[0]).toBe("my-app");
  });

  it("accumulates --ai across repeats and comma lists", () => {
    expect(parseArgs(["init", "--ai", "claude", "--ai", "codex"]).ai).toEqual(["claude", "codex"]);
    expect(parseArgs(["init", "--ai=claude,codex"]).ai).toEqual(["claude", "codex"]);
  });

  it("sets --force and --no-install", () => {
    const a = parseArgs(["init", "app", "--force", "--no-install"]);
    expect(a.force).toBe(true);
    expect(a.noInstall).toBe(true);
  });

  it("--name overrides the app name", () => {
    expect(parseArgs(["init", "dir", "--name", "acme"]).name).toBe("acme");
  });
});

describe("sanitizeAppName (U3)", () => {
  it("lowercases and hyphenates", () => {
    expect(sanitizeAppName("My App")).toBe("my-app");
    expect(sanitizeAppName("Cool_Thing!!")).toBe("cool-thing");
    expect(sanitizeAppName("  spaced  ")).toBe("spaced");
  });
  it("falls back to 'app' when nothing usable survives", () => {
    expect(sanitizeAppName("!!!")).toBe("app");
    expect(sanitizeAppName("")).toBe("app");
  });
});

describe("resolveAiFlags (U3)", () => {
  it("dedupes valid presets", () => {
    expect(resolveAiFlags(["claude", "claude", "cursor"])).toEqual(["claude", "cursor"]);
  });
  it("'none' clears the selection", () => {
    expect(resolveAiFlags(["claude", "none"])).toEqual([]);
  });
  it("throws on an unknown preset", () => {
    expect(() => resolveAiFlags(["bogus"])).toThrow(/Unknown --ai preset/);
  });
});

describe("templates (U2)", () => {
  it("coreDep pins the CLI version, else falls back to the 3.x line", () => {
    expect(coreDep("3.9.7")).toBe("^3.9.7");
    expect(coreDep("unknown")).toBe("^3.0.0");
  });

  it("package.json parses, pins core, and targets frontend/dist", () => {
    const pkg = JSON.parse(renderPackageJson({ appName: "my-app", coreVersion: "3.9.7" }));
    expect(pkg.name).toBe("my-app");
    expect(pkg.dependencies["@sidestep/core"]).toBe("^3.9.7");
    // @sidestep/auth is bundled by default — it's the add-on nearly every project
    // reaches for, and the scaffold references its registerAuth(...) example.
    expect(pkg.dependencies["@sidestep/auth"]).toMatch(/^\^\d+\.\d+\.\d+/);
    expect(pkg.scripts["xano:deploy"]).toContain("./frontend/dist");
    expect(pkg.scripts["xano:export"]).toContain("./xano/index.ts");
  });

  it("tsconfig parses and includes both halves", () => {
    const ts = JSON.parse(renderTsconfig());
    expect(ts.include).toEqual(["xano", "frontend/src"]);
  });

  it("vite config pins root to frontend", () => {
    expect(renderViteConfig()).toContain('root: "frontend"');
  });

  it("README carries the tsx-from-project-root spot-check note (#145)", () => {
    const md = renderReadme({ appName: "grant-triage", coreVersion: "4.1.1" });
    // The load-bearing kernel: run tsx <file.ts> from inside the project root.
    expect(md).toMatch(/tsx <file\.ts>/);
    expect(md).toMatch(/project root/);
    // Cross-references the paths command as the ready-made alternative.
    expect(md).toContain("sidestep paths");
  });

  it("xano/index.ts default-exports a workspace and surfaces add-ons + future packages", () => {
    const src = renderXanoIndex({ appName: "my-app", coreVersion: "3.9.7" });
    expect(src).toMatch(/export default workspace\("my-app"\)/);
    expect(src).toContain("@sidestep/auth");
    expect(src).toMatch(/[Ff]uture[\s\S]*@sidestep/);
  });
});

describe("AI presets (U4)", () => {
  it("each preset carries the shared sentinel (no drift)", () => {
    expect(renderClaudeMd("app")).toContain(GUIDANCE_SENTINEL);
    expect(renderAgentsMd("app")).toContain(GUIDANCE_SENTINEL);
    expect(renderCursorRules("app")).toContain(GUIDANCE_SENTINEL);
  });
  it("each preset references the teaching artifacts (R7)", () => {
    for (const body of [renderClaudeMd("app"), renderAgentsMd("app"), renderCursorRules("app")]) {
      expect(body).toContain("llms.txt");
      expect(body).toMatch(/\.d\.ts/);
      expect(body).toContain("manifest.json");
    }
  });
  it("cursor output is valid MDC frontmatter", () => {
    expect(renderCursorRules("app")).toMatch(/^---\n[\s\S]*alwaysApply: true\n---\n/);
  });
  it("no preset leaks Xano-internal identifiers (R10)", () => {
    const all = renderClaudeMd("app") + renderAgentsMd("app") + renderCursorRules("app");
    for (const banned of BANNED) expect(all).not.toContain(banned);
  });
});

describe("runInitCommand — orchestration (U3)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidestep-init-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const CORE_FILES = [
    "package.json",
    "tsconfig.json",
    "vite.config.ts",
    ".gitignore",
    ".env.example",
    "README.md",
    "xano/index.ts",
    "xano/EXAMPLE.md",
    "frontend/index.html",
    "frontend/src/main.tsx",
    "frontend/src/App.tsx",
    "frontend/src/index.css",
    "frontend/src/lib/api.ts",
  ];

  it("scaffolds the full tree into an empty dir, no AI file by default", async () => {
    const target = join(dir, "app");
    await runInitCommand(parseArgs(["init", target, "--no-install"]));
    for (const f of CORE_FILES) expect(existsSync(join(target, f))).toBe(true);
    expect(existsSync(join(target, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
    // package.json is valid JSON.
    expect(() => JSON.parse(readFileSync(join(target, "package.json"), "utf8"))).not.toThrow();
    // EXAMPLE.md warns that event-driven objects don't fire in the sandbox (#133).
    const exampleMd = readFileSync(join(target, "xano/EXAMPLE.md"), "utf8");
    expect(exampleMd).toMatch(/deploy but do not fire in the sandbox/i);
    expect(exampleMd).toContain("s.ai.agent.run");
  });

  it("api.ts demonstrates the split-route-metadata pattern (#140)", async () => {
    const target = join(dir, "split");
    await runInitCommand(parseArgs(["init", target, "--no-install"]));
    const apiTs = readFileSync(join(target, "frontend/src/lib/api.ts"), "utf8");
    // Types imported type-only (erased), and the heavy-def escape hatch is shown.
    expect(apiTs).toContain("import type { InferInput, InferResponse }");
    expect(apiTs).toContain("ROUTES");
    expect(apiTs).toContain("sidestep paths");
    // Warns against importing the whole workspace for a path.
    expect(apiTs).toMatch(/never[\s\S]*index\.js/i);
  });

  it("refuses a non-empty target without --force, proceeds with it", async () => {
    const target = join(dir, "occupied");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "existing.txt"), "hi");
    await expect(runInitCommand(parseArgs(["init", target, "--no-install"]))).rejects.toThrow(
      /not empty.*--force/s,
    );
    await runInitCommand(parseArgs(["init", target, "--no-install", "--force"]));
    expect(existsSync(join(target, "package.json"))).toBe(true);
  });

  it("--ai claude writes CLAUDE.md and nothing else", async () => {
    const target = join(dir, "withai");
    await runInitCommand(parseArgs(["init", target, "--no-install", "--ai", "claude"]));
    expect(existsSync(join(target, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(target, ".cursor/rules/sidestep.mdc"))).toBe(false);
  });

  it("--ai none writes no AI file", async () => {
    const target = join(dir, "noai");
    await runInitCommand(parseArgs(["init", target, "--no-install", "--ai", "none"]));
    expect(existsSync(join(target, "CLAUDE.md"))).toBe(false);
  });

  it("--ai bogus throws before writing", async () => {
    const target = join(dir, "bad");
    await expect(
      runInitCommand(parseArgs(["init", target, "--no-install", "--ai", "bogus"])),
    ).rejects.toThrow(/Unknown --ai preset/);
    expect(existsSync(join(target, "package.json"))).toBe(false);
  });

  it("sanitizes the derived app name into package.json", async () => {
    const target = join(dir, "My App");
    await runInitCommand(parseArgs(["init", target, "--no-install"]));
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-app");
  });

  it("--no-install leaves no node_modules", async () => {
    const target = join(dir, "app2");
    await runInitCommand(parseArgs(["init", target, "--no-install"]));
    expect(existsSync(join(target, "node_modules"))).toBe(false);
  });
});
