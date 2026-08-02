import { describe, it, expect } from "vitest";
import { mcpServer, encodeMcpServer } from "../../src/kinds/mcp-server.js";
import { tool } from "../../src/kinds/toolset.js";
import { encodeAgent } from "../../src/kinds/agent.js";
import { PROVIDER_TYPED_KEYS } from "../../src/codegen/kinds/index.js";
import { table } from "../../src/kinds/table.js";
import { Xano } from "../../src/workspace/xano.js";
import { deriveGuid } from "../../src/refs/guid.js";

describe("mcp_server kind", () => {
  it("carries an authored llm block, because both kinds are one stored object", () => {
    // `agent` and `mcpServer` are two authoring surfaces over ONE `mvp_toolset`
    // row, distinguished only by `type` — so an MCP server can hold the same
    // `agent_settings` an agent does, and one real workspace has one that does
    // (a provider, a model and a key). Without a surface for it, the block was
    // dropped on every pull.
    const ts = encodeMcpServer({
      name: "books",
      llm: { type: "xano-free", systemPrompt: "be brief", extraConfig: { model: "gemini-2.5-flash-lite" } },
    });
    expect(ts.type).toBe("mcp");
    const settings = (ts as unknown as { agent_settings?: Record<string, unknown> }).agent_settings;
    expect(settings).toMatchObject({ type: "xano-free", system_prompt: "be brief" });
    expect(settings!.configs).toMatchObject({ "xano-free": { model: "gemini-2.5-flash-lite" } });
  });

  it("encodes the same agent_settings an agent would, for the same llm", () => {
    // One builder, so the two surfaces cannot drift into two wire shapes.
    const llm = { type: "xano-free", extraConfig: { model: "gemini-2.5-flash-lite" } } as const;
    const fromMcp = (encodeMcpServer({ name: "x", llm }) as unknown as Record<string, unknown>).agent_settings;
    const fromAgent = (encodeAgent({ name: "x", llm }) as unknown as Record<string, unknown>).agent_settings;
    expect(fromMcp).toEqual(fromAgent);
  });

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

  it("per-tool auth accepts any table, as the engine does", () => {
    // The table's own `auth` flag gates nothing at runtime — the engine compares
    // the token's `dbo` to the tool's configured `dbo` by name. Same resolver as
    // a query's `auth`, so the two surfaces cannot drift.
    const plain = table({ name: "posts", schema: [] });
    expect(encodeMcpServer({ name: "s", tools: [{ id: 1, auth: plain }] }).tool[0]!.auth).toBe(
      deriveGuid("dbo", "posts"),
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

/**
 * The decoder keeps a per-provider list of the stored config keys each typed
 * surface declares. It mirrors `buildProviderConfig`, so it can drift — and a
 * drift means either a silently dropped setting (key added to the encoder, not
 * the list) or a generated tree that fails tsc (key on the list the surface does
 * not declare). Pin it against what the encoder actually writes.
 */
describe("provider config — the decoder's typed-key list matches the encoder", () => {
  const minimal = {
    anthropic: { type: "anthropic" },
    openai: { type: "openai" },
    "google-genai": { type: "google-genai" },
    "xano-free": { type: "xano-free" },
  } as const;

  for (const [provider, llm] of Object.entries(minimal)) {
    it(`covers every key ${provider} writes`, () => {
      const settings = (encodeAgent({ name: "a", llm }) as unknown as {
        agent_settings: { configs: Record<string, Record<string, unknown>> };
      }).agent_settings;
      const written = Object.keys(settings.configs[provider]!);
      expect(written.length).toBeGreaterThan(0);
      for (const key of written) {
        expect(PROVIDER_TYPED_KEYS[provider], `${provider}.${key}`).toContain(key);
      }
    });
  }
});
