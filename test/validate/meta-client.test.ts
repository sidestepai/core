import { describe, it, expect, afterEach, vi } from "vitest";
import { MetaClient } from "../../src/validate/meta-client.js";
import { buildWorkspaceArchive } from "./_helpers.js";

const config = { instance: "https://inst.xano.io", token: "tok", workspaceId: undefined };

/** The ephemeral env `validate` creates per run, as the API serializes it. */
const ENV_NAME = "sd68-jokr-1a2b";
const ENV_URL = "https://inst.xano.io/tenant/sd68-jokr-1a2b";
const ENV_ROW = {
  id: 12,
  name: ENV_NAME,
  display: "sidestep-validate",
  xano_domain: "inst.xano.io/tenant/sd68-jokr-1a2b",
  state: "ok",
  ephemeral_expires_at: "2030-01-01 00:00:00+0000",
};

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

  it("importBundle creates an ephemeral env and imports the tar archive into it", async () => {
    const m = stub(
      jsonResponse(ENV_ROW), // create ephemeral
      jsonResponse(ENV_ROW), // waitUntilReady
      jsonResponse({ workspace: { id: 1 } }), // import
    );
    const res = await new MetaClient(config).importBundle('{"a":1}');
    expect(res).toEqual({ workspaceId: 1, baseUrl: ENV_URL, raw: expect.any(String) });

    expect(String(m.mock.calls[0]![0])).toBe("https://inst.xano.io/api:meta/workspace/1/ephemeral");
    // The import targets the ENV, at its fixed internal workspace id — never the
    // parent instance, and never the retired JSON bundle route.
    const [importUrl, importInit] = m.mock.calls[2]!;
    expect(String(importUrl)).toBe(`${ENV_URL}/api:meta/workspace/1/import`);
    expect((importInit as RequestInit).method).toBe("POST");
    // The body is multipart carrying the gzip(tar()) archive, not raw JSON.
    expect((importInit as RequestInit).body).toBeInstanceOf(FormData);
    expect((importInit as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("importBundle creates the env under the configured parent workspace", async () => {
    const m = stub(jsonResponse(ENV_ROW), jsonResponse(ENV_ROW), jsonResponse({ workspace: { id: 1 } }));
    await new MetaClient({ ...config, workspaceId: 7 }).importBundle("{}");
    expect(String(m.mock.calls[0]![0])).toBe("https://inst.xano.io/api:meta/workspace/7/ephemeral");
  });

  it("dispose deletes the env it created, and is a no-op when none was", async () => {
    const client = new MetaClient(config);
    expect(await client.dispose()).toEqual({ deleted: false });

    const m = stub(
      jsonResponse(ENV_ROW),
      jsonResponse(ENV_ROW),
      jsonResponse({ workspace: { id: 1 } }),
      jsonResponse({}), // delete
    );
    await client.importBundle("{}");
    expect(await client.dispose()).toEqual({ deleted: true });
    expect(String(m.mock.calls[3]![0])).toBe(`https://inst.xano.io/api:meta/workspace/1/tenant/${ENV_NAME}`);
    expect((m.mock.calls[3]![1] as RequestInit).method).toBe("DELETE");
  });

  it("dispose cleans up an env whose import failed, and reports rather than throws", async () => {
    const client = new MetaClient(config);
    stub(
      jsonResponse(ENV_ROW),
      jsonResponse(ENV_ROW),
      new Response("boom", { status: 500, statusText: "Server Error" }), // import fails
    );
    await expect(client.importBundle("{}")).rejects.toThrow(/import failed \(500/);

    // The env still exists and must be torn down; a failing delete is reported.
    stub(new Response("nope", { status: 403, statusText: "Forbidden" }));
    const teardown = await client.dispose();
    expect(teardown.deleted).toBe(false);
    expect(teardown.error).toMatch(/403/);
  });

  it("exportWorkspace decodes the archive and routes to the tenant base_url after import", async () => {
    const client = new MetaClient(config);
    const exported = { app: "xano", type: "workspace", payload: { function: [{ name: "f", run: [] }] } };
    const m = stub(
      jsonResponse(ENV_ROW), // create ephemeral
      jsonResponse(ENV_ROW), // waitUntilReady
      jsonResponse({ workspace: { id: 1 } }), // import
      new Response(buildWorkspaceArchive(exported), { status: 200, statusText: "OK" }), // export archive
    );
    await client.importBundle("{}");
    const got = await client.exportWorkspace(1);
    expect(got.payload).toEqual({ function: [{ name: "f", run: [] }] });
    // reads follow the import to the ENV origin, not the parent instance
    expect(String(m.mock.calls[3]![0])).toBe(`${ENV_URL}/api:meta/workspace/1/export`);
    expect((m.mock.calls[3]![1] as RequestInit).method).toBe("POST");
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
