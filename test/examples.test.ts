/**
 * Guarantees the `examples/sandbox` stays a valid, deployable
 * Xano workspace: it must `export()` cleanly with every object kind represented.
 * If an example drifts out of sync with the SDK, this fails loudly.
 *
 * The example tree is type-checked on its own (`npm run examples:check`, which
 * resolves `@sidestep/core` to source). Here we only exercise it at runtime, so
 * the workspace is loaded via a computed-specifier dynamic import — tsc does not
 * pull the ~560 example files into the main typecheck program (they'd resolve
 * against the built `dist`, whose internal types aren't all re-exported).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GENERATED_SPECS } from "../src/statements/generated/specs.generated.js";
import { STATEMENT_SURFACES, sPathOf } from "../src/statements/surfaces.js";

const INDEX = "../examples/sandbox/index.js";

describe("examples/sandbox", () => {
  let payload: Record<string, unknown[]>;
  let sig: unknown;

  beforeAll(async () => {
    const mod = (await import(/* @vite-ignore */ INDEX)) as { default: { export(): unknown } };
    const bundle = mod.default.export() as { payload: Record<string, unknown[]>; sig: unknown };
    payload = bundle.payload;
    sig = bundle.sig;
  });

  const count = (k: string) => (Array.isArray(payload[k]) ? payload[k].length : 0);

  it("exports as one signed workspace bundle", () => {
    expect(sig).toBeTruthy();
    expect(payload.workspace).toBeTruthy();
  });

  it("registers a broad set of function/statement/filter/value examples", () => {
    // 214 statements (+ gates) + 225 runtime-resolvable filters (issue #106) +
    // value primitives + shared.
    expect(count("function")).toBeGreaterThan(400);
  });

  it("registers a field-type table example per type", () => {
    expect(count("dbo")).toBeGreaterThanOrEqual(24);
  });

  it("represents every object kind at least once", () => {
    for (const kind of ["dbo", "function", "query", "app", "trigger", "tool", "toolset", "task", "middleware", "addon"]) {
      expect(count(kind), `expected at least one "${kind}" example`).toBeGreaterThan(0);
    }
  });

  it("the toolset section holds both a mcp_server and an agent", () => {
    const types = (payload.toolset as Array<{ type: string }>).map((t) => t.type).sort();
    expect(types).toContain("mcp");
    expect(types).toContain("agent");
  });

  it("the worked s.ai.agent.run endpoint binds the agent by its toolset guid", async () => {
    const { deriveGuid } = await import("../src/refs/guid.js");
    const agentObj = (payload.toolset as Array<{ type: string; name: string; guid: string }>).find(
      (t) => t.type === "agent",
    )!;
    // The agent's own guid is md5("toolset:"+name)...
    expect(agentObj.guid).toBe(deriveGuid("toolset", agentObj.name));
    // ...and the ex_ask_assistant endpoint's call_agent references that same guid.
    const endpoint = (payload.query as Array<{ name: string; run: unknown[] }>).find(
      (q) => q.name === "ex_ask_assistant",
    )!;
    const callAgent = endpoint.run.find(
      (st) => (st as { name?: string }).name === "mvp:call_agent",
    ) as { context: { toolset: { id: string } } };
    expect(callAgent.context.toolset.id).toBe(agentObj.guid);
  });
});

describe("enum-constrained fields in the sandbox examples", () => {
  it("every example that can show a legal enum value does", () => {
    // The examples are what an agent copies, so an example that omits a
    // constrained field teaches nothing about its legal spellings — and one
    // that passes a placeholder teaches the wrong thing outright.
    const missing: string[] = [];
    for (const [surface, stored] of STATEMENT_SURFACES) {
      const spec = GENERATED_SPECS.find((s) => s.name === stored);
      const constrained = spec?.rules.filter((r) => r.enum) ?? [];
      if (constrained.length === 0) continue;
      // Derived from the `s.` PATH, not the surface key — the two can diverge,
      // and `scripts/gen-examples.ts` writes the file at the sPath. Getting this
      // wrong fails OPEN (the `existsSync` guard below skips a missing file), so
      // the check would silently stop enforcing anything for that statement.
      const path = join("examples/sandbox/statements", `${sPathOf(surface).replace(/\./g, "/")}.ts`);
      if (!existsSync(path)) continue;
      const src = readFileSync(path, "utf8");
      for (const rule of constrained) {
        const match = src.match(new RegExp(`\\b${rule.field}:\\s*("[^"]*")`));
        if (!match) {
          missing.push(`${path}: ${rule.field} not shown`);
        } else if (!rule.enum!.includes(JSON.parse(match[1]!) as string)) {
          missing.push(`${path}: ${rule.field} = ${match[1]} is not a legal value`);
        }
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });
});

/**
 * The lambda examples (issue #221). Each was live-deployed and returns the value
 * its comment claims; these assert the part that can be checked offline — that
 * the body reaching the wire is the authored one, at the right surface, in the
 * right slot. The placeholder these replaced (`fl["reduce"](c.text("x"))`) was
 * itself an instance of both bugs: a mis-slotted argument and a body that taught
 * a binding contract nobody had written down.
 */
describe("the lambda examples", () => {
  it("Covers #221: reduce sums with $result, from a filled initial-value slot", async () => {
    const { filterReduce } = await import("../examples/sandbox/filters/array/reduce.js");
    const stored = JSON.parse(JSON.stringify(filterReduce)) as {
      stack: Array<{ context?: { filters?: Array<{ name: string; arg: Array<{ value: string }> }> } }>;
    };
    const reduce = stored.stack[0]?.context?.filters?.[0];
    expect(reduce?.name).toBe("reduce");
    expect(reduce?.arg[0]?.value).toBe("0");
    expect(reduce?.arg[1]?.value).toBe("return $result + $this;");
  });

  it("writes every lambda body as a function, never as a bare c.text string", async () => {
    const files = [
      "filters/array/reduce.ts",
      "filters/array/map.ts",
      "filters/array/filter.ts",
      "filters/array/some.ts",
      "filters/array/every.ts",
      "filters/array/find.ts",
      "filters/array/findIndex.ts",
      "filters/transform/lambda.ts",
      "statements/lambda.ts",
      "statements/lambda-file.ts",
    ];
    for (const file of files) {
      const source = readFileSync(join(import.meta.dirname, "..", "examples/sandbox", file), "utf8");
      // Either an inline body (the surface implied by the call site) or an
      // explicit `lam.*` — never a string, which is what taught `$acc`.
      expect(source, file).toMatch(/lam\.(fn|file|raw)\(|\(\{ \$[a-z]/i);
      expect(source, file).not.toMatch(/code: c\.text\(|\bfl\.\w+\(c\.text\(/);
    }
  });

  it("keeps a worked lam.file example, body and all", async () => {
    const { lambdaFromFile } = await import("../examples/sandbox/statements/lambda-file.js");
    const body = JSON.stringify(lambdaFromFile);
    // The module's own text, read at build time — no transpile in between.
    expect(body).toContain("const line = $this.qty * $this.price;");
    expect(body).toContain("$this.qty >= 10");
  });
});
