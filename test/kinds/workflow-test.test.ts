import { describe, it, expect, vi, afterEach } from "vitest";
import {
  encodeWorkflowTest,
  workflowTest,
  workflowTestKind,
} from "../../src/kinds/workflow-test.js";
import { Xano } from "../../src/workspace/xano.js";
import { defineFunction } from "../../src/function/define.js";
import { s } from "../../src/statements/s.js";
import { c, ref } from "../../src/values/value.js";
import { resolveRef, deriveGuid } from "../../src/refs/guid.js";
import { encodeStatement } from "../../src/statements/statement.js";
import "../../src/index.js"; // register kinds

afterEach(() => vi.restoreAllMocks());

/** Silence + capture `console.warn` for the datasource-warning assertions. */
function captureWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("workflow_test kind — encoder", () => {
  it("fills every default from a name-only def", () => {
    expect(encodeWorkflowTest({ name: "smoke_suite" })).toEqual({
      name: "smoke_suite",
      description: "",
      docs: "",
      datasource: "",
      active: true,
      tag: [],
      run: [],
    });
  });

  it("throws on a missing or empty name", () => {
    expect(() => encodeWorkflowTest({ name: "" })).toThrow(/workflow test.*`name` is required/);
    expect(() => encodeWorkflowTest({} as { name: string })).toThrow(/`name` is required/);
  });

  it("carries description, docs and tags through", () => {
    const xdo = encodeWorkflowTest({
      name: "smoke_suite",
      description: "covers signup",
      docs: "run before release",
      tags: ["smoke", "release"],
    });
    expect(xdo.description).toBe("covers signup");
    expect(xdo.docs).toBe("run before release");
    expect(xdo.tag).toEqual([{ tag: "smoke" }, { tag: "release" }]);
  });

  it("encodes the stack in order, identically to the statements standalone", () => {
    const target = defineFunction({ name: "add_user", stack: [] });
    const stack = [
      s.function.call({ fn: target, as: "created" }),
      s.expect.to_be_defined({ expr: ref("created") }),
      s.expect.to_equal({ expr: ref("created.status"), value: c.text("ok") }),
    ];
    const xdo = encodeWorkflowTest({ name: "smoke_suite", stack });
    expect(xdo.run).toHaveLength(3);
    expect(xdo.run).toEqual(stack.map(encodeStatement));
    expect(xdo.run.map((r) => (r as { name: string }).name)).toEqual([
      "mvp:workspace_run_function",
      "mvp:test_expect_to_be_defined",
      "mvp:test_expect_to_equal",
    ]);
  });

  it("preserves `active: false` rather than falling back to the default", () => {
    expect(encodeWorkflowTest({ name: "t", active: false }).active).toBe(false);
    expect(encodeWorkflowTest({ name: "t", active: true }).active).toBe(true);
  });

  it("never emits `lastRun` — it is instance result state, not source", () => {
    const xdo = encodeWorkflowTest({
      name: "t",
      // A pulled object can carry one; the def type has no such field, and the
      // encoder must not launder it back into the bundle.
      lastRun: { date: 1, duration: 2, status: "pass" },
    } as never);
    expect(xdo).not.toHaveProperty("lastRun");
  });
});

describe("workflow_test kind — the datasource clone hazard", () => {
  it("warns on `live`, case-insensitively and ignoring surrounding space", () => {
    for (const datasource of ["live", "LIVE", "  live  "]) {
      const warn = captureWarn();
      encodeWorkflowTest({ name: "smoke_suite", datasource });
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toMatch(/CLONES its datasource/);
      expect(warn.mock.calls[0]![0]).toMatch(/smoke_suite/);
      vi.restoreAllMocks();
    }
  });

  it("stays quiet for the empty default and for a fixture datasource", () => {
    const warn = captureWarn();
    encodeWorkflowTest({ name: "a" });
    encodeWorkflowTest({ name: "b", datasource: "" });
    encodeWorkflowTest({ name: "c", datasource: "test_fixtures" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns without refusing — `live` still encodes completely", () => {
    captureWarn();
    const xdo = encodeWorkflowTest({ name: "smoke_suite", datasource: "live" });
    expect(xdo.datasource).toBe("live");
    expect(xdo.name).toBe("smoke_suite");
  });
});

describe("workflow_test kind — registration and identity", () => {
  it("registers under its own payload key", () => {
    expect(workflowTestKind.name).toBe("workflow_test");
    expect(workflowTestKind.payloadKey).toBe("workflow_test");
  });

  it("lands in payload.workflow_test with a name-derived guid stamped", () => {
    const def = workflowTest({ name: "smoke_suite", stack: [] });
    const bundle = new Xano().registerWorkflowTests([def]).export();
    const arr = bundle.payload.workflow_test as Array<{ name: string; guid: string }>;
    expect(arr).toHaveLength(1);
    expect(arr[0]!.name).toBe("smoke_suite");
    expect(arr[0]!.guid).toBe(deriveGuid("workflow_test", "smoke_suite"));
  });

  it("uses an explicit `guid` verbatim", () => {
    const def = workflowTest({ name: "smoke_suite", guid: "pinned-across-rename" });
    const bundle = new Xano().registerWorkflowTests([def]).export();
    const arr = bundle.payload.workflow_test as Array<{ guid: string }>;
    expect(arr[0]!.guid).toBe("pinned-across-rename");
  });

  it("s.workflow_test.call and the emitted object agree on one guid", () => {
    // The whole point of U1: a call's resolved target must BE the object's guid,
    // or the engine's import remaps a reference to nothing.
    const suite = workflowTest({ name: "smoke_suite", stack: [] });
    const caller = workflowTest({
      name: "release_suite",
      stack: [s.workflow_test.call({ workflowTest: suite })],
    });
    const bundle = new Xano().registerWorkflowTests([suite, caller]).export();
    const arr = bundle.payload.workflow_test as Array<{
      name: string;
      guid: string;
      run: Array<{ context: { id: string; datasource: string } }>;
    }>;
    const emittedSuite = arr.find((o) => o.name === "smoke_suite")!;
    const call = arr.find((o) => o.name === "release_suite")!.run[0]!;
    expect(call.context.id).toBe(emittedSuite.guid);
    expect(call.context.id).toBe(resolveRef("workflow_test", suite));
    // `datasource` is always present on the call context, defaulting to empty.
    expect(call.context.datasource).toBe("");
  });

  it("trips the duplicate-guid guard when two tests share a name", () => {
    const a = workflowTest({ name: "dupe" });
    const b = workflowTest({ name: "dupe" });
    expect(() => new Xano().registerWorkflowTests([a, b]).export()).toThrow(
      /Duplicate object guid/,
    );
  });
});
