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
  renderAppTsx,
  renderButtonTsx,
  renderCardTsx,
  renderCnUtil,
  renderCodegenAppTsx,
  renderComponentsJson,
  renderIndexCss,
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
import { templateLeaks } from "../helpers/source-leak.js";

// Identifiers that would leak Xano source-internal naming (project CLAUDE.md R10).
// Kept deliberately small — asserts scaffold text stays third-party-neutral.


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

  it("the @/ alias is declared in BOTH tsconfig and vite (shadcn imports need both)", () => {
    const ts = JSON.parse(renderTsconfig());
    expect(ts.compilerOptions.baseUrl).toBe(".");
    expect(ts.compilerOptions.paths["@/*"]).toEqual(["frontend/src/*"]);
    // Vite resolves it from the config file's own URL, not from `root`, so the
    // two halves agree on frontend/src.
    expect(renderViteConfig()).toContain('"@": fileURLToPath(new URL("./frontend/src"');
  });

  it("package.json carries shadcn/ui's runtime deps", () => {
    const pkg = JSON.parse(renderPackageJson({ appName: "my-app", coreVersion: "4.1.38" }));
    for (const dep of [
      "class-variance-authority",
      "clsx",
      "tailwind-merge",
      "lucide-react",
      // The unified primitives package, which is what current shadcn components
      // import from. The old per-primitive @radix-ui/react-slot is not used.
      "radix-ui",
    ]) {
      expect(pkg.dependencies[dep]).toBeTypeOf("string");
    }
    expect(pkg.dependencies["@radix-ui/react-slot"]).toBeUndefined();
    // shadcn sits on top of Tailwind — it is not a replacement for it.
    expect(pkg.devDependencies.tailwindcss).toBeTypeOf("string");
    expect(pkg.devDependencies["@tailwindcss/vite"]).toBeTypeOf("string");
  });

  it("components.json points the shadcn CLI at this project's layout", () => {
    const cfg = JSON.parse(renderComponentsJson());
    expect(cfg.tailwind.css).toBe("frontend/src/index.css");
    // Tailwind v4: the theme is in CSS, so there is no config file to name.
    expect(cfg.tailwind.config).toBe("");
    expect(cfg.tailwind.cssVariables).toBe(true);
    expect(cfg.tsx).toBe(true);
    expect(cfg.rsc).toBe(false);
    // Aliases must match the tsconfig `paths` mapping or `add` writes broken imports.
    expect(cfg.aliases.ui).toBe("@/components/ui");
    expect(cfg.aliases.utils).toBe("@/lib/utils");
  });

  it("index.css declares every color token the shipped components reference", () => {
    const css = renderIndexCss();
    expect(css).toContain('@import "tailwindcss"');
    // Tokens read by button.tsx and card.tsx. A missing one renders as no style
    // at all rather than as an error, so assert them explicitly.
    for (const token of [
      "--primary",
      "--primary-foreground",
      "--secondary",
      "--secondary-foreground",
      "--accent",
      "--accent-foreground",
      "--destructive",
      "--muted",
      "--muted-foreground",
      "--card",
      "--card-foreground",
      "--background",
      "--foreground",
      "--border",
      "--ring",
      "--radius",
    ]) {
      expect(css, `${token} missing from :root`).toContain(`${token}:`);
      expect(css, `${token} not mapped into @theme`).toContain(`var(${token})`);
    }
    // Both themes present; dark is opt-in via a `dark` class on <html>.
    expect(css).toContain(".dark {");
    expect(css).toContain("@custom-variant dark");
  });

  it("the shipped components import through the alias and use cn()", () => {
    for (const src of [renderButtonTsx(), renderCardTsx()]) {
      expect(src).toContain('from "@/lib/utils"');
      expect(src).toContain("cn(");
    }
    // asChild is what lets the landing page style an <a> as a button.
    expect(renderButtonTsx()).toContain("asChild");
    expect(renderButtonTsx()).toContain('from "radix-ui"');
    expect(renderButtonTsx()).toContain("Slot.Root");
    expect(renderCnUtil()).toContain("twMerge(clsx(inputs))");
  });

  it("both landing pages import the components they render", () => {
    const pages = [
      renderAppTsx({ appName: "my-app", coreVersion: "4.1.38" }),
      renderCodegenAppTsx({ appName: "my-app", coreVersion: "4.1.38" }, {
        source: "workspace",
        origin: "42",
      }),
    ];
    for (const page of pages) {
      expect(page).toContain('from "@/components/ui/button"');
      expect(page).toContain('from "@/components/ui/card"');
      // No leftover hardcoded palette from the pre-shadcn markup.
      expect(page).not.toMatch(/bg-gray-|text-gray-/);
    }
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
  it("each preset points the agent at shadcn/ui instead of hand-rolled UI", () => {
    for (const body of [renderClaudeMd("app"), renderAgentsMd("app"), renderCursorRules("app")]) {
      expect(body).toContain("shadcn@latest add");
      // The alias the components import through, and the one file to rebrand in.
      expect(body).toContain("@/components/ui/button");
      expect(body).toContain("frontend/src/index.css");
      // Semantic tokens over raw palette classes — the mistake to prevent.
      expect(body).toContain("bg-primary");
    }
  });

  it("cursor output is valid MDC frontmatter", () => {
    expect(renderCursorRules("app")).toMatch(/^---\n[\s\S]*alwaysApply: true\n---\n/);
  });
  it("no preset leaks Xano-internal identifiers (R10)", () => {
    const all = renderClaudeMd("app") + renderAgentsMd("app") + renderCursorRules("app");
    expect(templateLeaks(all)).toEqual([]);
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
    "components.json",
    "frontend/src/lib/utils.ts",
    "frontend/src/components/ui/button.tsx",
    "frontend/src/components/ui/card.tsx",
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
    expect(exampleMd).toMatch(/fire normally on an\s+ephemeral/i);
    expect(exampleMd).toMatch(/--dest sandbox/);
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
