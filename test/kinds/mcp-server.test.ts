import { describe, it, expect } from "vitest";
import { mcpServer, encodeMcpServer } from "../../src/kinds/mcp-server.js";
import { tool } from "../../src/kinds/toolset.js";
import { Xano } from "../../src/workspace/xano.js";
import { deriveGuid } from "../../src/refs/guid.js";

describe("mcp_server kind", () => {
  it("encodes type 'mcp', tool refs, and no agent_settings", () => {
    const ts = encodeMcpServer({ name: "books", instructions: "expose books", tools: [{ id: 1 }, { id: 2, enabled: false }] });
    expect(ts.type).toBe("mcp");
    expect(ts.instructions).toBe("expose books");
    expect(ts.tool).toEqual([
      { id: 1, enabled: true, auth: null },
      { id: 2, enabled: false, auth: null },
    ]);
    // agent_settings is inert for type:"mcp" — the engine tolerates its absence.
    expect((ts as unknown as Record<string, unknown>).agent_settings).toBeUndefined();
  });

  it("tool refs by handle resolve to the tool's guid", () => {
    const myTool = tool({ name: "search" });
    const ts = encodeMcpServer({ name: "books", tools: [{ tool: myTool }, { tool: "lookup" }] });
    expect(ts.tool).toEqual([
      { id: deriveGuid("tool", "search"), enabled: true, auth: null },
      { id: deriveGuid("tool", "lookup"), enabled: true, auth: null },
    ]);
  });

  it("per-tool auth passes through verbatim (the only MCP auth surface)", () => {
    const ts = encodeMcpServer({ name: "s", tools: [{ id: 1, auth: "bearer-token" }] });
    expect(ts.tool[0]!.auth).toBe("bearer-token");
  });

  it("carries the inert empty middleware skeleton (no toolset-level middleware)", () => {
    const ts = encodeMcpServer({ name: "s" });
    expect(ts.middleware).toEqual({ pre_customize: false, post_customize: false, pre: [], post: [] });
  });

  it("requires a name", () => {
    // @ts-expect-error - missing name
    expect(() => encodeMcpServer({})).toThrow("mcp server: `name` is required.");
  });

  it("mcpServer() factory passes the def through", () => {
    const def = mcpServer({ name: "s" });
    expect(def).toEqual({ name: "s" });
  });

  it("registers under the 'toolset' payload key with a md5('toolset:'+name) guid", () => {
    const bundle = new Xano().registerMcpServers([mcpServer({ name: "books", tools: [{ id: 1 }] })]).export();
    expect(bundle.payload.toolset).toHaveLength(1);
    const obj = (bundle.payload.toolset as Array<Record<string, unknown>>)[0]!;
    expect(obj.type).toBe("mcp");
    expect(obj.guid).toBe(deriveGuid("toolset", "books"));
  });
});
