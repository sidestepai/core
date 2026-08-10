/**
 * The build-time diagnostics collector (KTD5), plus the regression tests that
 * keep guards OFF the shapes a source check cleared (KTD2b).
 *
 * The negative tests here are the point. Four shapes the audit asked us to
 * block at `export()` turned out to be engine defects against bytes the
 * engine's own tooling emits — a guard on any of them would refuse a supported
 * shape and have to be un-shipped the moment the engine is fixed. Each carries
 * a test so a future reading of the issue does not re-add it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Xano } from "../../src/workspace/xano.js";
import {
  DiagnosticBag,
  emitDiagnostic,
  formatDiagnostic,
  setDiagnosticSink,
} from "../../src/workspace/diagnostics.js";
import type { Diagnostic } from "../../src/workspace/diagnostics.js";
import { table } from "../../src/kinds/table.js";
import { query } from "../../src/kinds/query.js";
import { apiGroup } from "../../src/kinds/api-group.js";
import { f } from "../../src/fields/catalog.js";
import { c } from "../../src/values/value.js";
import "../../src/kinds/workspace-config.js"; // side-effect: register the "workspace" kind

/** Capture every warning emitted during `fn()`, restoring the sink after. */
function captureWarnings(fn: () => void): Diagnostic[] {
  const seen: Diagnostic[] = [];
  const previous = setDiagnosticSink((d) => seen.push(d));
  try {
    fn();
  } finally {
    setDiagnosticSink(previous);
  }
  return seen;
}

afterEach(() => setDiagnosticSink());

describe("DiagnosticBag", () => {
  it("prefixes every message with `sidestep:` exactly once", () => {
    expect(formatDiagnostic({ severity: "warning", code: "x", message: "hello" })).toBe(
      "sidestep: hello",
    );
  });

  it("emits warnings through the sink and throws on the first error only at flush", () => {
    const bag = new DiagnosticBag();
    bag.warn("a", "careful");
    bag.error("b", "broken");
    // Recording does not throw — the whole set is reported at once.
    expect(bag.all()).toHaveLength(2);

    const seen: Diagnostic[] = [];
    const previous = setDiagnosticSink((d) => seen.push(d));
    try {
      expect(() => bag.flush()).toThrow(/sidestep: broken/);
    } finally {
      setDiagnosticSink(previous);
    }
    // The warning is still delivered even though the export failed.
    expect(seen.map((d) => d.code)).toEqual(["a"]);
  });

  it("reports EVERY error, not just the first", () => {
    const bag = new DiagnosticBag();
    bag.error("a", "first problem");
    bag.error("b", "second problem");
    expect(() => bag.flush()).toThrow(/first problem[\s\S]*second problem/);
    expect(() => bag.flush()).toThrow(/2 errors/);
  });

  it("flushes cleanly when nothing was recorded", () => {
    expect(() => new DiagnosticBag().flush()).not.toThrow();
  });

  it("routes an immediate error through the same format", () => {
    expect(() => emitDiagnostic({ severity: "error", code: "x", message: "nope" })).toThrow(
      "sidestep: nope",
    );
  });

  it("silences the whole set when the sink is a no-op", () => {
    const seen = captureWarnings(() => {
      emitDiagnostic({ severity: "warning", code: "x", message: "quiet" });
    });
    expect(seen).toHaveLength(1);
    // ...and with a no-op sink nothing escapes at all.
    const previous = setDiagnosticSink(() => {});
    try {
      expect(() =>
        emitDiagnostic({ severity: "warning", code: "x", message: "quiet" }),
      ).not.toThrow();
    } finally {
      setDiagnosticSink(previous);
    }
  });
});

describe("shapes deliberately NOT guarded — engine bugs, labelled `external`", () => {
  // Each of these was verified against the engine source: SideStep's emitted
  // bytes match what Xano's own tooling writes, so the failure is upstream and
  // a guard here would block a supported shape. Do not re-add them.

  it('accepts idType: "uuid" with no diagnostic (#205)', () => {
    const seen = captureWarnings(() => {
      new Xano()
        .registerWorkspace({ name: "app" })
        .registerTables([table({ name: "thing", idType: "uuid", schema: { label: f.text() } })])
        .export();
    });
    expect(seen).toHaveLength(0);
  });

  it("accepts useXdo: true with no diagnostic (#214)", () => {
    const seen = captureWarnings(() => {
      new Xano()
        .registerWorkspace({ name: "app", use_xdo: true })
        .registerTables([table({ name: "thing", schema: { label: f.text() } })])
        .export();
    });
    expect(seen).toHaveLength(0);
  });

  it("accepts a seeded table with a non-scalar column (#195)", () => {
    // The engine's own cast layer handles list/obj/json columns (ArrayCast
    // renders a Postgres literal STRING before binding), so the reported PHP
    // fatal is not reachable from any shape SideStep controls. Blocking the
    // seed here would refuse a pattern `examples/sandbox` itself demonstrates.
    const seen = captureWarnings(() => {
      new Xano()
        .registerWorkspace({ name: "app" })
        .registerTables([
          table({
            name: "thing",
            schema: { label: f.text(), tags: f.text({ array: true }), meta: f.json() },
            seed: [{ label: "a", tags: ["x"], meta: {} }] as never,
          }),
        ])
        .export();
    });
    expect(seen).toHaveLength(0);
  });

  it("accepts a `.` in a query name with no diagnostic (#227)", () => {
    const group = apiGroup({ name: "pub", canonical: "abc12345" });
    const seen = captureWarnings(() => {
      new Xano()
        .registerWorkspace({ name: "app" })
        .registerApiGroups([group])
        .registerQueries([
          query({
            name: "export.zip",
            verb: "GET",
            apiGroup: group,
            stack: [],
            response: c.bool(true),
          }),
        ])
        .export();
    });
    expect(seen).toHaveLength(0);
  });
});

describe("migrated warnings keep their behavior", () => {
  it("still warns (and does not block) on an auth table that isn't flagged", () => {
    const users = table({ name: "users", schema: { email: f.email() } });
    const group = apiGroup({ name: "pub", canonical: "abc12345" });
    const seen = captureWarnings(() => {
      new Xano()
        .registerWorkspace({ name: "app" })
        .registerTables([users])
        .registerApiGroups([group])
        .registerQueries([
          query({
            name: "me",
            verb: "GET",
            apiGroup: group,
            auth: users,
            stack: [],
            response: c.bool(true),
          }),
        ])
        .export();
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.code).toBe("query.auth-table-unflagged");
    expect(formatDiagnostic(seen[0]!)).toMatch(/^sidestep: query "me".*table\("users"|users/s);
  });
});
