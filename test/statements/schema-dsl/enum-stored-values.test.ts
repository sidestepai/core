import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { auditStoredJson, emptyAudit, formatAudit } from "../../../scripts/enum-audit.js";

/**
 * U5 — the guard, checked against bytes a real engine actually persisted.
 *
 * The guard runs on the source `codegen` emits for a pulled workspace, so a
 * stored value outside a field's declared set would make that workspace's own
 * emitted source refuse to re-encode. This is the standing check that no
 * vendored fixture is in that state.
 *
 * The vendored corpus is small (a handful of enum-bearing statements), so this
 * is a floor, not a proof at population scale — `codegen-replay` runs the same
 * audit over a captured sweep for that. It earns its place by never going
 * quiet: any fixture added later is audited automatically.
 */
function crawl(dir: string, visit: (path: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) crawl(path, visit);
    else if (path.endsWith(".json")) visit(path);
  }
}

describe("stored enum values in the vendored fixture corpus", () => {
  const audit = emptyAudit();
  crawl("test/fixtures", (path) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return; // not a stored-bytes fixture
    }
    auditStoredJson(parsed, path, audit);
  });

  it("holds no value the guard would reject", () => {
    // Every entry here is a workspace whose own emitted source would throw.
    expect(audit.outOfSet, `${formatAudit(audit)}\n${audit.offenders.join("\n")}`).toBe(0);
  });

  it("actually audited something, so a silent zero cannot pass for a clean bill", () => {
    expect(audit.statements).toBeGreaterThan(0);
    expect(audit.inSet + audit.blank + audit.dynamic + audit.filtered).toBeGreaterThan(0);
  });
});
