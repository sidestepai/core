import { describe, it, expect } from "vitest";
import { mcpServer, encodeMcpServer } from "../../src/kinds/mcp-server.js";
import { tool } from "../../src/kinds/toolset.js";
import { table } from "../../src/kinds/table.js";
import { Xano } from "../../src/workspace/xano.js";
import { deriveGuid } from "../../src/refs/guid.js";

describe("mcp_server kind", () => {
  it("encodes type 'mcp', tool refs, and no agent_settings", () => {
    const ts = encodeMcpServer({ name: "books", instructions: "expose books", tools: [{ id: 1 }, { id: 2, enabled: false }] });
    expect(ts.type).toBe("mcp");
    expect(ts.instructions).toBe("expose books");
    expect(ts.tool).toEqual([
      { id: 1, enabled: true, auth: false },
      { id: 2, enabled: false, auth: false },
    ]);
    // agent_settings is inert for type:"mcp" — the engine tolerates its absence.
    expect((ts as unknown as Record<string, unknown>).agent_settings).toBeUndefined();
  });

  it("tool refs by handle resolve to the tool's guid", () => {
    const myTool = tool({ name: "search" });
    const ts = encodeMcpServer({ name: "books", tools: [{ tool: myTool }, { tool: "lookup" }] });
    expect(ts.tool).toEqual([
      { id: deriveGuid("tool", "search"), enabled: true, auth: false },
      { id: deriveGuid("tool", "lookup"), enabled: true, auth: false },
    ]);
  });

  it("per-tool auth resolves an auth-table ref to its guid (works like query auth)", () => {
    const users = table({ name: "users", auth: true, schema: [] });
    const ts = encodeMcpServer({ name: "s", tools: [{ tool: "search", auth: users }] });
    // The auth table resolves through the same dbo id↔guid path as query.auth.
    expect(ts.tool[0]!.auth).toBe(deriveGuid("dbo", "users"));
  });

  it("per-tool auth rejects a non-auth table", () => {
    const plain = table({ name: "posts", schema: [] });
    expect(() => encodeMcpServer({ name: "s", tools: [{ id: 1, auth: plain }] })).toThrow(
      /not an auth table/,
    );
  });

  it("carries the inert empty middleware skeleton (no toolset-level middleware)", () => {
    const ts = encodeMcpServer({ name: "s" });
    expect(ts.middleware).toEqual({ pre_customize: false, post_customize: false, pre: [], post: [] });
  });

  it("requires a name", () => {
    // @ts-expect-error - missing name
    expect(() => encodeMcpServer({})).toThrow("mcp server: `name` is required.");
  });

  it("mcpServer() factory preserves the def fields and adds URL accessors", () => {
    const handle = mcpServer({ name: "s" });
    // The def fields are carried through on the handle...
    expect(handle.name).toBe("s");
    // ...plus getPath()/getUrl() accessors (which JSON serialization drops).
    expect(typeof handle.getPath).toBe("function");
    expect(typeof handle.getUrl).toBe("function");
    expect(JSON.parse(JSON.stringify(handle))).toEqual({ name: "s" });
  });

  it("registers under the 'toolset' payload key with a md5('toolset:'+name) guid", () => {
    const bundle = new Xano().registerMcpServers([mcpServer({ name: "books", tools: [{ id: 1 }] })]).export();
    expect(bundle.payload.toolset).toHaveLength(1);
    const obj = (bundle.payload.toolset as Array<Record<string, unknown>>)[0]!;
    expect(obj.type).toBe("mcp");
    expect(obj.guid).toBe(deriveGuid("toolset", "books"));
  });
});
