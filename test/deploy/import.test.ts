import { describe, it, expect, afterEach, vi } from "vitest";
import { importWorkspaceArchive } from "../../src/deploy/import.js";
import { encodeWorkspaceArchive } from "../../src/validate/archive.js";

const AUTH = {
  access_token: "acc-1",
  instance: "https://parent.example.com",
  workspaceId: 5,
  credentialType: "oauth" as const,
};
const archive = encodeWorkspaceArchive(JSON.stringify({ app: "xano", type: "workspace", payload: {} }));

function stub(body: string, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status, statusText: status === 200 ? "OK" : "ERR" }));
}

afterEach(() => vi.restoreAllMocks());

describe("importWorkspaceArchive", () => {
  it("POSTs multipart to the ENV base URL workspace/1/import with the bearer token", async () => {
    const m = stub('{"id":1}');
    const out = await importWorkspaceArchive(AUTH, { baseUrl: "https://e4f2.xano.io", archive });

    const [url, init] = m.mock.calls[0]!;
    // targets the env base URL, not the parent instance
    expect(url).toBe("https://e4f2.xano.io/api:meta/workspace/1/import");
    expect((init as RequestInit).method).toBe("POST");

    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer acc-1");
    // no hand-set Content-Type — fetch owns the multipart boundary
    expect(headers["Content-Type"]).toBeUndefined();

    const body = (init as RequestInit).body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const file = body.get("file") as File;
    expect(file).toBeInstanceOf(Blob);
    // filename must not look encrypted (*.enc.gz)
    expect(file.name).toBe("workspace.gz");
    expect(file.name.endsWith(".enc.gz")).toBe(false);

    expect(out.workspaceId).toBe(1);
  });

  it("preserves a self-hosted /tenant/{name} base-URL path prefix", async () => {
    const m = stub("{}");
    await importWorkspaceArchive(AUTH, { baseUrl: "https://self.host/tenant/e4f2", archive });
    expect(m.mock.calls[0]![0]).toBe("https://self.host/tenant/e4f2/api:meta/workspace/1/import");
  });

  it("surfaces a non-2xx as the conventional error with the body", async () => {
    stub("kaboom", 422);
    await expect(importWorkspaceArchive(AUTH, { baseUrl: "https://e4f2.xano.io", archive })).rejects.toThrow(
      /import failed \(422 ERR\):\nkaboom/,
    );
  });

  it("tolerates a non-JSON success body (workspaceId undefined)", async () => {
    stub("OK");
    const out = await importWorkspaceArchive(AUTH, { baseUrl: "https://e4f2.xano.io", archive });
    expect(out.workspaceId).toBeUndefined();
    expect(out.raw).toBe("OK");
  });
});
