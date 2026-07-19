import { describe, it, expect, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployStaticHost, tarGz } from "../../src/deploy/static-host.js";

const AUTH = { access_token: "acc-1", instance: "https://inst.example.com" };

function tmpDirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sidestep-static-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe("tarGz", () => {
  it("produces a gzip stream whose tar carries the file name and data", () => {
    const gz = tarGz([{ path: "index.html", data: Buffer.from("<h1>hi</h1>") }]);
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
    const tar = gunzipSync(gz);
    expect(tar.subarray(0, 10).toString("ascii").replace(/\0+$/, "")).toBe("index.html"); // name at offset 0
    expect(tar.toString("ascii")).toContain("<h1>hi</h1>"); // file data present
    expect(tar.subarray(257, 262).toString("ascii")).toBe("ustar"); // USTAR magic
  });
});

describe("deployStaticHost", () => {
  afterEach(() => vi.restoreAllMocks());

  it("archives the directory and POSTs multipart to the build endpoint with the numeric workspace id", async () => {
    const dir = tmpDirWith({ "index.html": "<h1>hi</h1>", "assets/app.js": "console.log(1)" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"url":"https://site.dev"}', { status: 200 }));

    const out = await deployStaticHost({ dir, workspaceId: 42, baseUrl: AUTH.instance, accessToken: AUTH.access_token, headers: { "X-Tenant": "sbx-1" } });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://inst.example.com/api:meta/workspace/42/static_host/default/build");
    expect((init as RequestInit).method).toBe("POST");
    expect(((init as RequestInit).headers as Record<string, string>).Authorization).toBe("Bearer acc-1");
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
    expect(out.url).toBe("https://site.dev");
    rmSync(dir, { recursive: true, force: true });
  });

  it("errors when the directory is missing", async () => {
    await expect(deployStaticHost({ dir: "/no/such/dir", workspaceId: 1, baseUrl: AUTH.instance, accessToken: AUTH.access_token, headers: { "X-Tenant": "sbx-1" } })).rejects.toThrow(/directory not found/);
  });

  it("errors when the directory is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidestep-empty-"));
    await expect(deployStaticHost({ dir, workspaceId: 1, baseUrl: AUTH.instance, accessToken: AUTH.access_token, headers: { "X-Tenant": "sbx-1" } })).rejects.toThrow(/no files to deploy/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces a non-2xx build response as an error", async () => {
    const dir = tmpDirWith({ "index.html": "hi" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500, statusText: "ERR" }));
    await expect(deployStaticHost({ dir, workspaceId: 1, baseUrl: AUTH.instance, accessToken: AUTH.access_token, headers: { "X-Tenant": "sbx-1" } })).rejects.toThrow(/Static-host build failed \(500/);
    rmSync(dir, { recursive: true, force: true });
  });
});
