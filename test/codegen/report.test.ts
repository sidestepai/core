/**
 * U2 — decode report and import collection.
 *
 * The report has three sinks (structured entries, the generated README, the CLI
 * summary) and exactly one set of computed counts behind them. The drift these
 * tests guard is a README that says "3 raw fallbacks" while the CLI says 4.
 */
import { describe, it, expect } from "vitest";
import { DecodeReport } from "../../src/codegen/report.js";
import { CODEGEN_MODULE, CORE_MODULE, DecodeContext, ImportCollector } from "../../src/codegen/context.js";

/** Pull every `<category>=<count>` pair out of a rendered surface. */
function counts(rendered: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [, category, n] of rendered.matchAll(/\[([a-z-]+)=(\d+)\]/g)) {
    out[category!] = Number(n);
  }
  return out;
}

describe("DecodeReport", () => {
  it("renders nothing at all when empty — no '0 issues' noise", () => {
    const report = new DecodeReport();
    expect(report.entries).toEqual([]);
    expect(report.summarize().total).toBe(0);
    expect(report.renderMarkdown()).toBe("");
    expect(report.renderCli()).toBe("");
  });

  it("groups entries by category and names the object and path for each", () => {
    const report = new DecodeReport();
    report.add({
      category: "raw-fallback",
      object: "function:signup",
      path: "stack[2]",
      detail: "mvp:future_thing has no decoder",
    });
    report.add({
      category: "raw-fallback",
      object: "query:list_users",
      path: "stack[0]",
      detail: "mvp:other has no decoder",
    });
    report.add({
      category: "unsupported-section",
      object: "bundle",
      detail: "payload.vault has 3 entries",
    });

    const summary = report.summarize();
    expect(summary.total).toBe(3);
    expect(summary.byCategory.map((g) => [g.category, g.count])).toEqual([
      ["raw-fallback", 2],
      ["unsupported-section", 1],
    ]);

    const md = report.renderMarkdown();
    expect(md).toContain("function:signup");
    expect(md).toContain("stack[2]");
    expect(md).toContain("mvp:future_thing has no decoder");
  });

  it("derives the README and the CLI summary from the same computed counts", () => {
    const report = new DecodeReport();
    report.add({ category: "raw-fallback", object: "function:a", detail: "x" });
    report.add({ category: "raw-fallback", object: "function:b", detail: "y" });
    report.add({ category: "value-fallback", object: "function:a", detail: "z" });
    report.add({ category: "unresolved-ref", object: "query:q", detail: "w" });

    const fromSummary = Object.fromEntries(
      report.summarize().byCategory.map((g) => [g.category, g.count]),
    );
    expect(counts(report.renderMarkdown())).toEqual(fromSummary);
    expect(counts(report.renderCli())).toEqual(fromSummary);
  });

  it("keeps categories in a stable order regardless of insertion order", () => {
    const a = new DecodeReport();
    a.add({ category: "unsupported-section", object: "bundle", detail: "x" });
    a.add({ category: "raw-fallback", object: "f", detail: "y" });
    const b = new DecodeReport();
    b.add({ category: "raw-fallback", object: "f", detail: "y" });
    b.add({ category: "unsupported-section", object: "bundle", detail: "x" });
    expect(a.summarize().byCategory.map((g) => g.category)).toEqual(
      b.summarize().byCategory.map((g) => g.category),
    );
  });
});

describe("ImportCollector", () => {
  it("deduplicates repeated symbols and emits one sorted import per module", () => {
    const imports = new ImportCollector();
    imports.use(CORE_MODULE, "s");
    imports.use(CORE_MODULE, "c");
    imports.use(CORE_MODULE, "s");
    expect(imports.toStatements()).toEqual([
      { kind: "import", module: CORE_MODULE, symbols: ["c", "s"] },
    ]);
  });

  it("emits bare specifiers before relative ones, each alphabetically", () => {
    const imports = new ImportCollector();
    imports.use("./_shared.js", "users");
    imports.use(CODEGEN_MODULE, "raw");
    imports.use(CORE_MODULE, "s");
    imports.use("./tables/posts.js", "posts");
    expect(imports.toStatements().map((i) => i.module)).toEqual([
      CORE_MODULE,
      CODEGEN_MODULE,
      "./_shared.js",
      "./tables/posts.js",
    ]);
  });

  it("emits type-only imports as their own statement", () => {
    const imports = new ImportCollector();
    imports.use(CORE_MODULE, "s");
    imports.useType(CORE_MODULE, "Value");
    expect(imports.toStatements()).toEqual([
      { kind: "import", module: CORE_MODULE, symbols: ["s"] },
      { kind: "import", module: CORE_MODULE, symbols: ["Value"], typeOnly: true },
    ]);
  });
});

describe("DecodeContext", () => {
  it("labels report entries with the object and path scope in force", () => {
    const ctx = new DecodeContext();
    ctx.inObject("function:signup", () => {
      ctx.at("stack[1]", () => {
        ctx.at("context.where", () => {
          ctx.problem("value-fallback", "const:expr is not invertible");
        });
      });
    });
    expect(ctx.report.entries).toEqual([
      {
        category: "value-fallback",
        object: "function:signup",
        path: "stack[1].context.where",
        detail: "const:expr is not invertible",
      },
    ]);
  });

  it("restores the previous scope after a nested decode completes", () => {
    const ctx = new DecodeContext();
    ctx.inObject("function:a", () => {
      ctx.at("stack[0]", () => undefined);
      ctx.problem("raw-fallback", "after");
    });
    expect(ctx.report.entries[0]!.object).toBe("function:a");
    expect(ctx.report.entries[0]!.path).toBeUndefined();
  });

  it("restores scope even when a decoder throws", () => {
    const ctx = new DecodeContext();
    expect(() =>
      ctx.inObject("function:a", () => {
        ctx.at("stack[0]", () => {
          throw new Error("boom");
        });
      }),
    ).toThrow("boom");
    ctx.problem("raw-fallback", "recovered");
    expect(ctx.report.entries[0]!.object).toBe("(bundle)");
    expect(ctx.report.entries[0]!.path).toBeUndefined();
  });

  it("gives each generated file its own import block", () => {
    const ctx = new DecodeContext();
    ctx.beginFile();
    expect(ctx.use(CORE_MODULE, "s")).toBe("s");
    expect(ctx.imports.toStatements()).toHaveLength(1);
    ctx.beginFile();
    expect(ctx.imports.toStatements()).toEqual([]);
  });
});
