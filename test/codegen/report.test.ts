/**
 * U2 — decode report and import collection.
 *
 * The report has three sinks (structured entries, the generated README, the CLI
 * summary) and exactly one set of computed counts behind them. The drift these
 * tests guard is a README that says "3 raw fallbacks" while the CLI says 4.
 */
import { describe, it, expect } from "vitest";
import { DecodeReport, severityOf } from "../../src/codegen/report.js";
import { UNSUPPORTED_SECTIONS, omissionSeverity } from "../../src/codegen/omissions.js";
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

  it("coalesces blank bindings to one entry per object, naming the subjects it saw", () => {
    // One workspace in the survey corpus carries 48 of these. The count is a
    // property of how big the object is, not of how much went wrong, so the
    // per-site entry is the wrong unit — but the warning still has to land.
    const report = new DecodeReport();
    report.add({ category: "blank-binding", object: "query:orders", path: "stack[0]", detail: "a", subject: "db.query" });
    report.add({ category: "blank-binding", object: "query:orders", path: "stack[1]", detail: "b", subject: "db.get" });
    report.add({ category: "blank-binding", object: "query:orders", path: "stack[2]", detail: "c", subject: "db.get" });

    const group = report.summarize().byCategory.find((g) => g.category === "blank-binding")!;
    expect(group.count).toBe(1);
    // Distinct subjects, de-duplicated, in first-seen order — and the real count.
    expect(group.entries[0]!.detail).toContain("db.query, db.get");
    expect(group.entries[0]!.detail).toContain("3 references");
    // The path named a single site, and this entry no longer stands for one.
    expect(group.entries[0]!.path).toBeUndefined();
  });

  it("leaves a lone blank binding exactly as recorded", () => {
    // Coalescing one entry into a summary of one entry would lose its `path`
    // and reword its detail for no gain.
    const report = new DecodeReport();
    const only = { category: "blank-binding", object: "query:a", path: "stack[0]", detail: "d", subject: "db.query" } as const;
    report.add({ ...only });
    const group = report.summarize().byCategory.find((g) => g.category === "blank-binding")!;
    expect(group.entries).toEqual([only]);
  });

  it("separates objects, and leaves every raw entry intact for tooling", () => {
    const report = new DecodeReport();
    report.add({ category: "blank-binding", object: "query:a", detail: "x", subject: "db.get" });
    report.add({ category: "blank-binding", object: "query:a", detail: "y", subject: "db.add" });
    report.add({ category: "blank-binding", object: "query:b", detail: "z", subject: "db.del" });

    const group = report.summarize().byCategory.find((g) => g.category === "blank-binding")!;
    expect(group.entries.map((e) => e.object)).toEqual(["query:a", "query:b"]);
    // `entries` is the raw log — the sweep CSV reads it and wants every site.
    expect(report.entries).toHaveLength(3);
    // …and the summary total counts what a reader sees, not what was recorded.
    expect(report.summarize().total).toBe(2);
  });

  it("keeps the coalesced count consistent across all three sinks", () => {
    // The drift this whole module exists to prevent, applied to the new path:
    // a README saying 2 while the CLI says 3 because only one of them coalesced.
    const report = new DecodeReport();
    report.add({ category: "blank-binding", object: "query:a", detail: "x", subject: "db.get" });
    report.add({ category: "blank-binding", object: "query:a", detail: "y", subject: "db.add" });
    report.add({ category: "raw-fallback", object: "query:a", detail: "z" });

    const fromSummary = Object.fromEntries(
      report.summarize().byCategory.map((g) => [g.category, g.count]),
    );
    expect(fromSummary).toEqual({ "blank-binding": 1, "raw-fallback": 1 });
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

describe("severity", () => {
  it("splits categories into error / warning / notice", () => {
    // The report is the single place this judgment lives. Before, every consumer
    // invented its own split — the CLI hardcoded "everything but
    // expected-omission is a problem" and the sweep tool kept a second list that
    // could disagree with it.
    expect(severityOf("verify-mismatch")).toBe("error");
    expect(severityOf("unresolved-ref")).toBe("error");
    expect(severityOf("raw-fallback")).toBe("warning");
    expect(severityOf("value-fallback")).toBe("warning");
    expect(severityOf("unsupported-section")).toBe("warning");
    expect(severityOf("modernized")).toBe("warning");
    expect(severityOf("expected-omission")).toBe("notice");
    expect(severityOf("empty-source")).toBe("notice");
  });

  it("keeps the three causes split out of `unresolved-ref` at the severity each earns", () => {
    // These used to share `unresolved-ref`'s error severity, which claimed the
    // generated tree did not reproduce its source. All three round-trip exactly.
    // A blank binding and a name-spelled reference still want a human glance —
    // something is wrong upstream — so they are warnings, not notices. An
    // internal row id is a notice: faithful, and nothing anyone can act on.
    expect(severityOf("blank-binding")).toBe("warning");
    expect(severityOf("name-bound-ref")).toBe("warning");
    expect(severityOf("unportable-id")).toBe("notice");
    // "We chose not to carry this" is not "we don't know what this is".
    expect(severityOf("instance-owned")).toBe("notice");
    expect(severityOf("unsupported-section")).toBe("warning");
    // The narrowed original keeps its meaning, and its volume.
    expect(severityOf("unresolved-ref")).toBe("error");
  });

  it("warns only for the sections that are genuinely a gap in the pull", () => {
    // Pinned by section name, not just by reason, because the drift this guards
    // is a policy entry tagged `unmodeled` out of habit when its own detail line
    // says the instance owns it — which is exactly what `market_item`,
    // `run_install`, and `action_package_install` were doing.
    const bySection = Object.fromEntries(
      Object.entries(UNSUPPORTED_SECTIONS).map(([k, p]) => [k, omissionSeverity(p.reason)]),
    );
    expect(bySection).toEqual({
      vault: "notice",
      branch: "notice",
      market_item: "notice",
      run_install: "notice",
      action_package_install: "notice",
      knowledge: "warning",
      workflow_test: "warning",
      service: "warning",
    });
  });

  it("counts by severity, and carries it on every group", () => {
    const report = new DecodeReport();
    report.add({ category: "verify-mismatch", object: "function:a", detail: "x" });
    report.add({ category: "raw-fallback", object: "function:a", detail: "y" });
    report.add({ category: "modernized", object: "function:a", detail: "z" });
    report.add({ category: "expected-omission", object: "function:a", detail: "w" });

    const summary = report.summarize();
    expect(summary.bySeverity).toEqual({ error: 1, warning: 2, notice: 1 });
    for (const group of summary.byCategory) {
      expect(group.severity).toBe(severityOf(group.category));
    }
  });

  it("prefixes both renderings so a reader can triage without a legend", () => {
    const report = new DecodeReport();
    report.add({ category: "verify-mismatch", object: "function:a", detail: "x" });
    report.add({ category: "modernized", object: "function:b", detail: "y" });
    report.add({ category: "expected-omission", object: "function:c", detail: "z" });

    for (const rendered of [report.renderCli(), report.renderMarkdown()]) {
      expect(rendered).toContain("ERROR");
      expect(rendered).toContain("WARN");
      expect(rendered).toContain("note");
    }
  });
});
