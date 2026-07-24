/**
 * Call-family block specials (U10) — invoking another workspace object.
 *
 * Only `function.run` (mvp:function) has an engine golden (function_run.json),
 * and it stores the target as a local numeric id (`context.function.id: 1`)
 * that the export path would convert to the target's guid. sidestep references by
 * guid directly, so we align the fixture's id to the derived guid and deep-equal
 * everything else (byte-shape proof). The workspace_run_* family has no fixtures
 * — covered structurally, plus an end-to-end round-trip showing a call resolves
 * to the same guid the target object emits in the bundle.
 */
import { describe, it, expect } from "vitest";
import "../../src/index.js"; // register kinds + statements
import {
  functionRun,
  functionCall,
  apiCall,
  taskCall,
  toolCall,
  triggerCall,
  middlewareCall,
  addonCall,
} from "../../src/statements/special/calls.js";
import { encodeStatement } from "../../src/statements/statement.js";
import { deriveGuid } from "../../src/refs/guid.js";
import { Xano } from "../../src/workspace/xano.js";
import { defineFunction } from "../../src/function/define.js";
import { c, inp } from "../../src/values/value.js";
import { normalize, loadFixture } from "../conformance/harness.js";

describe("call-family specials", () => {
  it("function.run deep-equals function_run.json (target id aligned to guid)", () => {
    const built = encodeStatement(
      functionRun({ fn: { name: "sample_func" }, as: "func1", input: { score: c.int(10) } }),
    );
    const fixture = loadFixture("statements/function_run.json") as {
      context: { function: { id: unknown } };
    };
    // The fixture's local id stands in for the target reference; align it to the
    // guid sidestep resolves so every other field is compared byte-for-byte.
    fixture.context.function.id = deriveGuid("function", "sample_func");
    expect(normalize(built)).toEqual(normalize(fixture));
  });

  it("workspace_run_* calls store the target guid under context.id (+ input)", () => {
    const cases = [
      { built: functionCall({ fn: { name: "f" } }), type: "function", name: "f" },
      { built: apiCall({ api: { name: "ep" } }), type: "query", name: "ep" },
      { built: taskCall({ task: { name: "t" } }), type: "task", name: "t" },
      { built: toolCall({ tool: { name: "tl" } }), type: "tool", name: "tl" },
      { built: triggerCall({ trigger: { name: "tr" } }), type: "trigger", name: "tr" },
      { built: middlewareCall({ middleware: { name: "mw" } }), type: "middleware", name: "mw" },
      { built: addonCall({ addon: { name: "ad" } }), type: "addon", name: "ad" },
    ];
    for (const { built, type, name } of cases) {
      const enc = encodeStatement(built);
      expect((enc.context as { id: string }).id).toBe(deriveGuid(type, name));
      expect(enc.input).toEqual([]);
    }
  });

  it("call input is encoded as stored input[] entries", () => {
    const enc = encodeStatement(toolCall({ tool: { name: "tl" }, input: { q: c.text("hi") } }));
    expect(enc.input).toEqual([
      { name: "q", value: "hi", tag: "const", filters: [], ignore: false, expand: false, children: [] },
    ]);
  });

  it("coerces raw literals in an input map to their constant tags (#133)", () => {
    // `{ max_age_days: 3 }` just works — no c.int(3) needed.
    const enc = encodeStatement(
      functionRun({
        fn: { name: "f" },
        input: { max_age_days: 3, rate: 1.5, label: "hot", active: true },
      }),
    );
    const byName = Object.fromEntries(
      (enc.input as { name: string; value: unknown; tag: string }[]).map((e) => [e.name, e]),
    );
    expect(byName.max_age_days).toMatchObject({ value: "3", tag: "const:int" });
    expect(byName.rate).toMatchObject({ value: "1.5", tag: "const:decimal" });
    expect(byName.label).toMatchObject({ value: "hot", tag: "const" });
    expect(byName.active).toMatchObject({ value: "true", tag: "const:bool" });
  });

  it("passes a tagged Value in an input map through unchanged", () => {
    const enc = encodeStatement(apiCall({ api: { name: "ep" }, input: { n: c.int(7), s: inp("s") } }));
    const byName = Object.fromEntries(
      (enc.input as { name: string; value: unknown; tag: string }[]).map((e) => [e.name, e]),
    );
    expect(byName.n).toMatchObject({ value: "7", tag: "const:int" });
    expect(byName.s).toMatchObject({ value: "s", tag: "input" });
  });

  it("round-trip: a function.call resolves to the guid the target function emits", () => {
    const getUser = defineFunction({ name: "get_user", stack: [] });
    const caller = defineFunction({
      name: "caller",
      stack: [functionCall({ fn: getUser, as: "u" })],
    });
    const bundle = new Xano().registerFunctions([getUser, caller]).export();
    const fns = bundle.payload.function as Array<{ name: string; guid: string; run: unknown[] }>;
    const target = fns.find((f) => f.name === "get_user")!;
    const callerFn = fns.find((f) => f.name === "caller")!;
    const callStmt = callerFn.run[0] as { name: string; context: { id: string } };
    expect(callStmt.name).toBe("mvp:workspace_run_function");
    expect(callStmt.context.id).toBe(target.guid);
  });
});
