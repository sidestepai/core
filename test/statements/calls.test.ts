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
import { aiAgentRun } from "../../src/statements/special/ai-cloud.js";
import type { AsyncMode } from "../../src/statements/special/async-runtime.js";
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

/**
 * A call's background-execution block.
 *
 * `runtime` is a TOP-LEVEL member of the stack item, not part of `context`, and
 * the engine's stack converter switches on `runtime.mode`: `async-shared`
 * builds its config from `mode` alone, `async-dedicated` additionally reads
 * `cpu`/`memory`/`max_retry`/`timeout`, and every other value — absent, `null`,
 * the editor's explicit `"disabled"` — falls to a default arm that discards the
 * block. Async is not a tuning knob: at either async mode `mvp:function` is
 * rewritten to `mvp:async_function`, so the call dispatches instead of
 * returning the function's result.
 */
describe("an async function call's runtime block", () => {
  it("omits the block entirely for a normal synchronous call", () => {
    const stored = encodeStatement(functionRun({ fn: { name: "f" } })) as { runtime: unknown };
    expect(stored.runtime).toBeNull();
  });

  it("emits `mode` alone at async-shared — the resources are not read there", () => {
    const stored = encodeStatement(
      // `cpu`/`memory` are accepted but inert at this mode, so they must not be
      // written: the engine would ignore them and the bytes would claim more
      // than the statement does.
      functionRun({ fn: { name: "f" }, runtime: { mode: "async-shared", cpu: "250m" } }),
    ) as { runtime: unknown };
    expect(stored.runtime).toEqual({ mode: "async-shared" });
  });

  it("emits every dedicated resource at async-dedicated, blank for the unset ones", () => {
    const stored = encodeStatement(
      functionRun({
        fn: { name: "f" },
        runtime: { mode: "async-dedicated", cpu: "250m", memory: "512Mi", timeout: 300 },
      }),
    ) as { runtime: unknown };
    // The editor writes all five members at this mode; `max_retry` is left blank
    // rather than omitted so the stored shape matches what the panel produces.
    expect(stored.runtime).toEqual({
      mode: "async-dedicated",
      cpu: "250m",
      memory: "512Mi",
      timeout: "300",
      max_retry: "",
    });
  });

  it("compares equal to the editor's spelling, which writes blank resources at async-shared", () => {
    // The settings panel is one form over all five fields, so switching to
    // `async-shared` leaves the dedicated inputs behind, blank. The engine never
    // reads them at that mode — without this the SDK's lean form and the
    // editor's would never verify against each other.
    const editor = { runtime: { cpu: "", mode: "async-shared", memory: "", timeout: "", max_retry: "" } };
    expect(normalize(editor)).toEqual(normalize({ runtime: { mode: "async-shared" } }));
    // …but a dedicated block keeps every one of them, because they are live there.
    const dedicated = { runtime: { mode: "async-dedicated", cpu: "250m", memory: "1Gi", timeout: "60", max_retry: "2" } };
    expect(normalize(dedicated)).toEqual(dedicated);
  });
});

describe("the async runtime is one model, shared by both call surfaces", () => {
  it("gives ai.agent.run the same block function.run writes", () => {
    // These drifted before they shared a type. `ai.agent.run` took
    // `runtimeMode: "shared" | "dedicated"` — neither of which is an engine
    // mode, so `{mode: "dedicated"}` landed on the converter's default arm and
    // ran SYNCHRONOUSLY. Asking for a dedicated async agent silently got a
    // blocking call and no error. One model is what makes that unrepresentable.
    const fn = encodeStatement(
      functionRun({ fn: { name: "f" }, runtime: { mode: "async-shared" } }),
    ) as { runtime: unknown };
    const agent = encodeStatement(
      aiAgentRun({ agent: { name: "asst" }, runtime: { mode: "async-shared" } }),
    ) as { runtime: unknown };
    expect(agent.runtime).toEqual(fn.runtime);
    expect(agent.runtime).toEqual({ mode: "async-shared" });
  });

  it("only accepts modes the engine actually switches on", () => {
    // A compile-time guarantee, asserted here so the intent survives a refactor:
    // `AsyncMode` is the engine's own vocabulary, so the old `"dedicated"`
    // spelling cannot be written at all.
    const modes: AsyncMode[] = ["async-shared", "async-dedicated"];
    expect(modes).toHaveLength(2);
    // @ts-expect-error `"dedicated"` is not an engine mode — it ran synchronously.
    const bad: AsyncMode = "dedicated";
    expect(bad).toBe("dedicated");
  });
});
