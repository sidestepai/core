import { describe, it, expect, afterEach, vi } from "vitest";
import { MetaClient } from "../../src/validate/meta-client.js";

const config = { instance: "https://inst.xano.io", token: "tok", workspaceId: undefined };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, statusText: status === 200 ? "OK" : "ERR" });
}
function stub(...responses: Response[]) {
  const m = vi.spyOn(globalThis, "fetch");
  for (const r of responses) m.mockResolvedValueOnce(r);
  return m;
}

describe("MetaClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("importBundle posts the raw bundle to sandbox/bundle with reset and returns the workspace id", async () => {
    const m = stub(jsonResponse({ workspace: { id: 42 }, base_url: "https://x.xano.io" }));
    const res = await new MetaClient(config).importBundle('{"a":1}', { reset: true });
    expect(res).toEqual({ workspaceId: 42, baseUrl: "https://x.xano.io", raw: expect.any(String) });
    const [url, init] = m.mock.calls[0]!;
    expect(String(url)).toBe("https://inst.xano.io/api:meta/sandbox/bundle?reset=true");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe('{"a":1}');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("importBundle surfaces a JSON-only error when sandbox/bundle 404s", async () => {
    stub(new Response("not found", { status: 404, statusText: "Not Found" }));
    await expect(new MetaClient(config).importBundle("{}")).rejects.toThrow(/JSON-only|not available/);
  });

  it("getFunction reads the persisted JSON with include_xanoscript=false", async () => {
    const m = stub(jsonResponse({ name: "f", run: [] }));
    const obj = await new MetaClient(config).getFunction(42, 7);
    expect(obj).toEqual({ name: "f", run: [] });
    expect(String(m.mock.calls[0]![0])).toBe(
      "https://inst.xano.io/api:meta/workspace/42/function/7?include_xanoscript=false",
    );
  });

  it("getFunction throws with the body on a non-2xx", async () => {
    stub(new Response("boom", { status: 500, statusText: "ERR" }));
    await expect(new MetaClient(config).getFunction(1, 2)).rejects.toThrow(/GET .* failed \(500/);
  });

  it("listApigroups maps id/name/canonical from an items array", async () => {
    stub(jsonResponse({ items: [{ id: 3, name: "public", canonical: "abc123" }] }));
    const groups = await new MetaClient(config).listApigroups(42);
    expect(groups).toEqual([{ id: 3, name: "public", canonical: "abc123" }]);
  });

  it("listFunctions accepts a bare array response", async () => {
    stub(jsonResponse([{ id: 5, name: "echo" }, { id: 6, name: "sum" }]));
    const fns = await new MetaClient(config).listFunctions(42);
    expect(fns).toEqual([{ id: 5, name: "echo" }, { id: 6, name: "sum" }]);
  });

  it("invokeApi builds /api:{canonical}/{path} with no double slash and returns status+body", async () => {
    const m = stub(jsonResponse({ echoed: true }));
    const res = await new MetaClient(config).invokeApi("abc123", "/echo", { method: "POST", body: { x: 1 } });
    expect(res).toEqual({ status: 200, ok: true, body: { echoed: true } });
    expect(String(m.mock.calls[0]![0])).toBe("https://inst.xano.io/api:abc123/echo");
    expect((m.mock.calls[0]![1] as RequestInit).body).toBe('{"x":1}');
  });

  it("invokeApi returns the status on an error response instead of throwing", async () => {
    stub(new Response(JSON.stringify({ message: "bad" }), { status: 400, statusText: "ERR" }));
    const res = await new MetaClient(config).invokeApi("abc123", "boom");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "bad" });
  });

  it("runFunction posts name+input to function/run", async () => {
    const m = stub(jsonResponse({ result: 3 }));
    const res = await new MetaClient(config).runFunction(42, "sum", { a: 1, b: 2 });
    expect(res.body).toEqual({ result: 3 });
    expect(String(m.mock.calls[0]![0])).toBe("https://inst.xano.io/api:meta/workspace/42/function/run");
    expect((m.mock.calls[0]![1] as RequestInit).body).toBe('{"name":"sum","input":{"a":1,"b":2}}');
  });
});
