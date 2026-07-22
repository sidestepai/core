import { describe, it, expect, afterEach, vi } from "vitest";
import { MetaClient } from "../../src/validate/meta-client.js";
import { buildWorkspaceArchive } from "./_helpers.js";

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

  it("exportWorkspace decodes the archive and routes to the tenant base_url after import", async () => {
    const client = new MetaClient(config);
    const exported = { app: "xano", type: "workspace", payload: { function: [{ name: "f", run: [] }] } };
    const m = stub(
      jsonResponse({ workspace: { id: 1 }, base_url: "https://inst.xano.io/tenant/sd68-jokr" }), // import
      new Response(buildWorkspaceArchive(exported), { status: 200, statusText: "OK" }), // export archive
    );
    await client.importBundle("{}", { reset: true });
    const got = await client.exportWorkspace(1);
    expect(got.payload).toEqual({ function: [{ name: "f", run: [] }] });
    // import went to the ROOT instance; the export POST went to the TENANT origin
    expect(String(m.mock.calls[0]![0])).toBe("https://inst.xano.io/api:meta/sandbox/bundle?reset=true");
    expect(String(m.mock.calls[1]![0])).toBe("https://inst.xano.io/tenant/sd68-jokr/api:meta/workspace/1/export");
    expect((m.mock.calls[1]![1] as RequestInit).method).toBe("POST");
  });

  it("exportWorkspace throws with the body on a non-2xx", async () => {
    stub(new Response("nope", { status: 403, statusText: "Forbidden" }));
    await expect(new MetaClient(config).exportWorkspace(1)).rejects.toThrow(/Export of workspace 1 failed \(403/);
  });

  it("runFunction posts name+input to function/run and returns status+body", async () => {
    const m = stub(jsonResponse({ result: 3 }));
    const res = await new MetaClient(config).runFunction(42, "sum", { a: 1, b: 2 });
    expect(res).toEqual({ status: 200, ok: true, body: { result: 3 } });
    expect(String(m.mock.calls[0]![0])).toBe("https://inst.xano.io/api:meta/workspace/42/function/run");
    expect((m.mock.calls[0]![1] as RequestInit).body).toBe('{"name":"sum","input":{"a":1,"b":2}}');
  });

  it("runFunction returns the status on an error response instead of throwing", async () => {
    stub(new Response(JSON.stringify({ message: "bad" }), { status: 400, statusText: "ERR" }));
    const res = await new MetaClient(config).runFunction(42, "boom");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "bad" });
  });
});
