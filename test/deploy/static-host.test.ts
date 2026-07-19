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

  it("POSTs the archive to the meta build endpoint on the parent workspace and returns the live URL", async () => {
    const dir = tmpDirWith({ "index.html": "<h1>hi</h1>", "assets/app.js": "console.log(1)" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response('{"default_url":"https://default-dev-abc.xano.io","custom_url":null}', { status: 200 }));

    const out = await deployStaticHost({ dir, workspaceId: 9, baseUrl: AUTH.instance, accessToken: AUTH.access_token });

    // Exactly one call: the meta build (auto-creates default + auto-deploys). No lookup, no publish.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://inst.example.com/api:meta/workspace/9/static_host/default/build");
    expect((init as RequestInit).method).toBe("POST");
    expect(((init as RequestInit).headers as Record<string, string>).Authorization).toBe("Bearer acc-1");
    // No tenant-routing header — this is the caller's own workspace.
    expect(((init as RequestInit).headers as Record<string, string>)["X-Tenant"]).toBeUndefined();
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
    expect(out.url).toBe("https://default-dev-abc.xano.io"); // from default_url
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers a custom domain, and builds a URL from a bare dev.host", async () => {
    const dir = tmpDirWith({ "index.html": "hi" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response('{"custom_url":"https://app.acme.com","default_url":"https://d.xano.io"}', { status: 200 }));
    const a = await deployStaticHost({ dir, workspaceId: 1, baseUrl: AUTH.instance, accessToken: AUTH.access_token });
    expect(a.url).toBe("https://app.acme.com");

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response('{"dev":{"host":"default-dev-abc.xano.io","custom":""}}', { status: 200 }));
    const b = await deployStaticHost({ dir, workspaceId: 1, baseUrl: AUTH.instance, accessToken: AUTH.access_token });
    expect(b.url).toBe("https://default-dev-abc.xano.io");
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses a custom host name in the build path when one is given", async () => {
    const dir = tmpDirWith({ "index.html": "hi" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await deployStaticHost({ dir, workspaceId: 7, baseUrl: AUTH.instance, accessToken: AUTH.access_token, host: "my site" });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://inst.example.com/api:meta/workspace/7/static_host/my%20site/build");
    rmSync(dir, { recursive: true, force: true });
  });

  it("errors when the directory is missing", async () => {
    await expect(deployStaticHost({ dir: "/no/such/dir", workspaceId: 1, baseUrl: AUTH.instance, accessToken: AUTH.access_token })).rejects.toThrow(/directory not found/);
  });

  it("errors when the directory is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidestep-empty-"));
    await expect(deployStaticHost({ dir, workspaceId: 1, baseUrl: AUTH.instance, accessToken: AUTH.access_token })).rejects.toThrow(/no files to deploy/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces a non-2xx build response as an error", async () => {
    const dir = tmpDirWith({ "index.html": "hi" });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("boom", { status: 500, statusText: "ERR" }));
    await expect(deployStaticHost({ dir, workspaceId: 1, baseUrl: AUTH.instance, accessToken: AUTH.access_token })).rejects.toThrow(/Static-host build failed \(500/);
    rmSync(dir, { recursive: true, force: true });
  });
});
