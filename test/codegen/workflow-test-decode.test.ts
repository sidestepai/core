/**
 * Workflow-test decode — a stored object back into `workflowTest({...})`.
 *
 * Round-trip equality is the floor (a verbatim passthrough would clear it), so
 * every case also asserts the *emitted source*: default elision and the factory
 * form are readability claims only the generated text can prove.
 *
 * The one shape worth naming here is `lastRun` — the outcome of the last
 * execution. It is instance state, not workspace source, so a stored object
 * carrying one is NORMAL. It must be dropped silently rather than surface as an
 * omission or a refusal, and it must never be laundered back into a re-export.
 */
import { describe, it, expect } from "vitest";
// Side-effect import: kinds self-register on load, and `workspace()` encodes
// its config eagerly — a narrower import fails with "Unknown object kind".
import "../../src/index.js";
import { normalize } from "../../src/validate/normalize.js";
import { decodeBundle } from "../../src/codegen/index.js";
import { workspace } from "../../src/workspace/xano.js";
import { workflowTest } from "../../src/kinds/workflow-test.js";
import { defineFunction } from "../../src/function/define.js";
import { s } from "../../src/statements/s.js";
import type { Bundle } from "../../src/workspace/export.js";

const target = defineFunction({ name: "ex_target", stack: [] });

/** Build a one-object bundle and return the generated source for that object. */
function generate(defs: unknown[], name: string): { source: string; bundle: Bundle } {
  const bundle = workspace("wt")
    .registerFunctions([target])
    .registerWorkflowTests(defs as never[])
    .export();
  const project = decodeBundle(bundle);
  const file = project.files.find((f) => f.path === `workflow-test/${name}.ts`);
  expect(file, `no generated file for workflow test "${name}"`).toBeDefined();
  return { source: file!.contents, bundle };
}

/** Re-encode the generated defs by decoding, then compare to the source bundle. */
function decodedSection(bundle: Bundle): Record<string, unknown>[] {
  return (bundle.payload.workflow_test ?? []) as Record<string, unknown>[];
}

describe("workflow_test decode — elision and factory form", () => {
  it("emits a workflowTest(...) call, not a `satisfies` fallback", () => {
    const { source } = generate(
      [workflowTest({ name: "minimal", stack: [s.function.call({ fn: target })] })],
      "minimal",
    );
    expect(source).toContain("workflowTest({");
    expect(source).not.toContain("satisfies");
    expect(source).toContain('import { s, workflowTest } from "@sidestep/core";');
  });

  it("elides every key sitting at its encoder default", () => {
    const { source } = generate(
      [workflowTest({ name: "minimal", stack: [s.function.call({ fn: target })] })],
      "minimal",
    );
    for (const key of ["description:", "docs:", "datasource:", "active:", "tags:"]) {
      expect(source, `all-default workflow test still emits \`${key}\``).not.toContain(key);
    }
    expect(source).toContain('name: "minimal"');
  });

  it("emits every key that departs from its default", () => {
    const { source } = generate(
      [
        workflowTest({
          name: "full",
          description: "covers signup",
          docs: "run before release",
          datasource: "fixtures",
          active: false,
          tags: ["smoke", "release"],
          stack: [s.function.call({ fn: target })],
        }),
      ],
      "full",
    );
    expect(source).toContain('description: "covers signup"');
    expect(source).toContain('docs: "run before release"');
    expect(source).toContain('datasource: "fixtures"');
    expect(source).toContain("active: false");
    expect(source).toContain('"smoke"');
    expect(source).toContain('"release"');
  });

  it("elides `active: true` (the engine default) but emits `active: false`", () => {
    const on = generate(
      [workflowTest({ name: "on", active: true, stack: [s.function.call({ fn: target })] })],
      "on",
    ).source;
    const off = generate(
      [workflowTest({ name: "off", active: false, stack: [s.function.call({ fn: target })] })],
      "off",
    ).source;
    expect(on).not.toContain("active:");
    expect(off).toContain("active: false");
  });

  it("resolves a workflow_test.call target to a named import, not a bare guid", () => {
    const leaf = workflowTest({ name: "leaf", stack: [s.function.call({ fn: target })] });
    const caller = workflowTest({
      name: "caller",
      stack: [s.workflow_test.call({ workflowTest: leaf })],
    });
    const { source } = generate([leaf, caller], "caller");
    expect(source).toContain("workflowTest: leaf");
    expect(source).not.toMatch(/workflowTest: "[0-9a-f]{32}"/);
  });
});

describe("workflow_test decode — lastRun is instance state", () => {
  /**
   * A stored object as the engine persists it, with a completed run recorded.
   * The `run` item comes from the encoder rather than being hand-written — a
   * fabricated statement shape would make this assert against the wrong bytes.
   */
  const storedWithLastRun = {
    ...(workspace("w")
      .registerWorkflowTests([
        workflowTest({
          name: "smoke_suite",
          guid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          stack: [s.comment("hi")],
        }),
      ])
      .export().payload.workflow_test as Record<string, unknown>[])[0],
    lastRun: {
      date: 1754300000,
      duration: 42,
      status: "pass",
      type: "manual",
      statements: [{ description: "step", status: "pass", error: "" }],
    },
  };

  const decoded = decodeBundle({
    payload: { workspace: { name: "w" }, workflow_test: [storedWithLastRun] },
  } as never);

  it("drops lastRun from the generated source", () => {
    const file = decoded.files.find((f) => f.path === "workflow-test/smoke_suite.ts")!;
    expect(file.contents).not.toContain("lastRun");
    expect(file.contents).toContain("workflowTest({");
  });

  it("does not report lastRun as an omission or a refusal", () => {
    const text = JSON.stringify(decoded.report);
    expect(text).not.toContain("lastRun");
    // The whole section is modeled now — no `workflow_test` omission entry.
    expect(text).not.toMatch(/workflow tests are not modeled/);
  });

  it("never launders lastRun back into a re-export", () => {
    // The encoder has no such field; assert it explicitly so a future `plain()`
    // row for it would fail here rather than silently ship instance state.
    const reexported = workspace("w")
      .registerWorkflowTests([workflowTest({ name: "smoke_suite", stack: [s.comment("hi")] })])
      .export();
    expect(decodedSection(reexported)[0]).not.toHaveProperty("lastRun");
  });

  it("still round-trips the authored fields around it", () => {
    const reexported = workspace("w")
      .registerWorkflowTests([
        workflowTest({
          name: "smoke_suite",
          guid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          stack: [s.comment("hi")],
        }),
      ])
      .export();
    const authored = { ...storedWithLastRun } as Record<string, unknown>;
    delete authored.lastRun;
    expect(normalize(decodedSection(reexported)[0])).toEqual(normalize(authored));
  });
});

describe("workflow_test decode — the section is no longer omitted", () => {
  it("reports no omission for a bundle carrying workflow tests", () => {
    const bundle = workspace("w")
      .registerFunctions([target])
      .registerWorkflowTests([
        workflowTest({ name: "smoke", stack: [s.function.call({ fn: target })] }),
      ])
      .export();
    const report = JSON.stringify(decodeBundle(bundle).report);
    expect(report).not.toMatch(/workflow tests are not modeled/);
  });
});
