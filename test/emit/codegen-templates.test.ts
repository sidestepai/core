/**
 * U2 — the templates that make a pulled project read as pulled.
 *
 * `init`'s README, landing page, and AI guidance all address someone about to
 * author a backend. A codegen'd project's user already has one, and its `xano/`
 * is machine-written — so the load-bearing assertions here are about the
 * *rescoping* of the disposability warning (it is `xano/` that is destroyed, not
 * the project) rather than about a warning merely existing.
 */
import { describe, it, expect } from "vitest";
import {
  describeOrigin,
  renderCodegenAppTsx,
  renderCodegenMarker,
  renderCodegenReadme,
  type CodegenOrigin,
  type TemplateVars,
} from "../../src/emit/init-templates.js";
import {
  GUIDANCE_SENTINEL,
  renderAgentsMd,
  renderClaudeMd,
  renderCursorRules,
  renderPreset,
} from "../../src/emit/init-ai-presets.js";
import { templateLeaks } from "../helpers/source-leak.js";


const VARS: TemplateVars = { appName: "pulled-app", coreVersion: "4.1.6" };
const WORKSPACE: CodegenOrigin = { source: "workspace", origin: "42" };

describe("renderCodegenMarker", () => {
  it("parses, and carries source, origin, version, and timestamp", () => {
    const marker = JSON.parse(renderCodegenMarker(VARS, WORKSPACE, "2026-07-28T00:00:00.000Z"));
    expect(marker.source).toBe("workspace");
    expect(marker.origin).toBe("42");
    expect(marker.coreVersion).toBe("4.1.6");
    expect(marker.generatedAt).toBe("2026-07-28T00:00:00.000Z");
  });

  it("records the identifying origin for every source form", () => {
    const origin = (o: CodegenOrigin) =>
      JSON.parse(renderCodegenMarker(VARS, o, "2026-07-28T00:00:00.000Z")).origin;
    expect(origin({ source: "workspace", origin: "9" })).toBe("9");
    expect(origin({ source: "ephemeral", origin: "pr-42" })).toBe("pr-42");
    expect(origin({ source: "file", origin: "ws.json" })).toBe("ws.json");
  });
});

describe("describeOrigin", () => {
  it("reads naturally for each source", () => {
    expect(describeOrigin({ source: "workspace", origin: "42" })).toBe("workspace 42");
    expect(describeOrigin({ source: "sandbox", origin: "" })).toBe("the sandbox workspace");
    expect(describeOrigin({ source: "ephemeral", origin: "pr-42" })).toBe('ephemeral "pr-42"');
    expect(describeOrigin({ source: "file", origin: "ws.json" })).toBe("the bundle at ws.json");
  });
});

describe("renderCodegenReadme", () => {
  const md = renderCodegenReadme(VARS, WORKSPACE, []);

  it("scopes the regeneration warning to xano/, not the whole project", () => {
    // The rescoping is the point: the project shell is the user's, only `xano/`
    // is disposable. A warning that said "this tree" would be wrong now.
    expect(md).toMatch(/`xano\/` is disposable/i);
    expect(md).toMatch(/rest of\s*\n?\s*the project .* is yours and is left alone/s);
  });

  it("states the full-replace boundary and names ephemeral/sandbox as the only safe targets", () => {
    expect(md).toMatch(/full replace/i);
    expect(md).toMatch(/ephemeral or sandbox/i);
    expect(md).toMatch(/never to a\s*\n?\s*workspace holding data you care about/s);
  });

  it("says the pull is schema only and points at the decode report", () => {
    expect(md).toMatch(/schema only/i);
    expect(md).toContain("xano/README.md");
  });

  it("carries the deploy flow the pull exists to enable", () => {
    expect(md).toContain("npm run build");
    expect(md).toContain("npm run xano:deploy");
  });

  it("names the source it was pulled from", () => {
    expect(md).toContain("workspace 42");
  });

  it("warns about env var values only when the pull carried some", () => {
    // The values ride inline in xano/index.ts because that is what a deploy
    // sends, and `.gitignore` does not exclude `xano/` — so a secret can reach
    // source control unless the user is told.
    expect(md).not.toMatch(/env var/i);
    const withEnv = renderCodegenReadme(VARS, WORKSPACE, ["STRIPE_KEY", "SENDGRID_KEY"]);
    expect(withEnv).toContain("STRIPE_KEY");
    expect(withEnv).toContain("SENDGRID_KEY");
    expect(withEnv).toMatch(/with their values/i);
    expect(withEnv).toMatch(/do not commit/i);
  });

  it("leaks no Xano-internal identifiers (R10)", () => {
    const all = md + renderCodegenReadme(VARS, WORKSPACE, ["A"]);
    expect(templateLeaks(all)).toEqual([]);
  });
});

describe("renderCodegenAppTsx", () => {
  const tsx = renderCodegenAppTsx(VARS, WORKSPACE);

  it("does not tell the reader to author their first table — they already have a backend", () => {
    expect(tsx).not.toMatch(/first table/i);
    expect(tsx).not.toContain("EXAMPLE.md");
  });

  it("points at the decode report and the endpoint listing", () => {
    expect(tsx).toContain("xano/README.md");
    expect(tsx).toContain("sidestep paths xano/index.ts");
  });

  it("names where the project came from", () => {
    expect(tsx).toContain("workspace 42");
  });
});

describe("AI presets — the generated variant", () => {
  const generated = renderClaudeMd("pulled-app", "generated");

  it("keeps the shared learn-from-the-library sentinel", () => {
    expect(generated).toContain(GUIDANCE_SENTINEL);
    expect(renderAgentsMd("a", "generated")).toContain(GUIDANCE_SENTINEL);
    expect(renderCursorRules("a", "generated")).toContain(GUIDANCE_SENTINEL);
  });

  it("does not point at EXAMPLE.md, which codegen never writes", () => {
    expect(generated).not.toContain("EXAMPLE.md");
    expect(renderAgentsMd("a", "generated")).not.toContain("EXAMPLE.md");
    expect(renderCursorRules("a", "generated")).not.toContain("EXAMPLE.md");
  });

  it("tells the agent xano/ is regenerated wholesale, and that deploy is a full replace", () => {
    // The highest-leverage instruction surface in an AI-first SDK: an agent that
    // edits xano/ in good faith loses that work on the next pull.
    expect(generated).toMatch(/`xano\/` is machine-written and disposable/i);
    expect(generated).toMatch(/full replace/i);
    expect(generated).toContain("xano/README.md");
  });

  it("still references the teaching artifacts (R7)", () => {
    expect(generated).toContain("llms.txt");
    expect(generated).toMatch(/\.d\.ts/);
    expect(generated).toContain("manifest.json");
  });

  it("cursor's generated output is still valid MDC frontmatter", () => {
    expect(renderCursorRules("a", "generated")).toMatch(/^---\n[\s\S]*alwaysApply: true\n---\n/);
  });

  it("leaks no Xano-internal identifiers (R10)", () => {
    const all =
      generated + renderAgentsMd("a", "generated") + renderCursorRules("a", "generated");
    expect(templateLeaks(all)).toEqual([]);
  });

  it("renderPreset defaults to the authored body and honours the generated mode", () => {
    expect(renderPreset("claude", "a")).toContain("EXAMPLE.md");
    expect(renderPreset("claude", "a", "generated")).not.toContain("EXAMPLE.md");
  });
});
