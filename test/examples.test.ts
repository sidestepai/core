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
    // 214 statements (+ gates) + 345 filters + value primitives + shared.
    expect(count("function")).toBeGreaterThan(500);
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
