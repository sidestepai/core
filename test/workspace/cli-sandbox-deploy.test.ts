import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, readFileSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../src/emit/cli.js";

const examplePath = fileURLToPath(new URL("../fixtures/workspace/index.ts", import.meta.url));

const INSTANCE = "https://default.example.com";
const DISCOVERY = {
  issuer: "https://app.xano.com",
  authorization_endpoint: "https://app.xano.com/oauth2/authorize",
  token_endpoint: "https://app.xano.com/api:master/oauth/token",
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"],
};

interface TokenOverrides {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  instance?: string;
}

function writeTokenFile(dir: string, o: TokenOverrides = {}): string {
  const path = join(dir, ".xano", "auth.json");
  const record: Record<string, unknown> = {
    access_token: o.access_token ?? "acc-cached",
    expires_at: o.expires_at ?? Date.now() + 3_600_000,
    scope: "offline_access workspace:write",
    instance: o.instance ?? INSTANCE,
    auth_host: "https://app.xano.com",
    client_id: "dcr-abc",
  };
  if ("refresh_token" in o) {
    if (o.refresh_token !== undefined) record.refresh_token = o.refresh_token;
  } else {
    record.refresh_token = "ref-cached";
  }
  mkdirSync(join(dir, ".xano"), { recursive: true });
  writeFileSync(path, JSON.stringify(record));
  return path;
}

function jwtWithAud(aud: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ typ: "at+jwt" })}.${b64({ aud })}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "ERR",
    headers: { "content-type": "application/json" },
  });
}

function tokenBody(o: Record<string, unknown>): Record<string, unknown> {
  return { token_type: "bearer", ...o };
}

function stubFetchOk(body = '{"ok":true}') {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200, statusText: "OK" }));
}

/** Gunzip a fetch mock's posted body back to the original bundle JSON text. */
function postedBundle(fetchMock: ReturnType<typeof stubFetchOk>, callIndex = 0): string {
  const init = fetchMock.mock.calls[callIndex]![1] as RequestInit;
  return gunzipSync(init.body as Uint8Array).toString("utf8");
}

describe("sidestep sandbox deploy (OAuth, replaces push)", () => {
  let dir: string;
  let bundlePath: string;
  let stdoutChunks: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidestep-sbx-"));
    bundlePath = join(dir, "bundle.json");
    stdoutChunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.XANO_REFRESH_TOKEN;
    delete process.env.XANO_CLIENT_ID;
    delete process.env.XANO_ORIGIN;
  });

  it("compiles a workspace entry and POSTs a gzipped bundle to the sandbox endpoint", async () => {
    const authFile = writeTokenFile(dir);
    const fetchMock = stubFetchOk('{"imported":true}');

    await run(["sandbox", "deploy", examplePath, "--config", authFile]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${INSTANCE}/api:meta/sandbox/bundle`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer acc-cached");
    expect((init?.headers as Record<string, string>)["Content-Encoding"]).toBeUndefined();
    const posted = JSON.parse(postedBundle(fetchMock));
    expect(posted.app).toBe("xano");
    expect(posted.payload.workspace).toMatchObject({ name: "example" });
    expect(stdoutChunks.join("")).toContain("imported");
  });

  it("uploads an existing bundle with --bundle, without compiling", async () => {
    const authFile = writeTokenFile(dir);
    writeFileSync(bundlePath, JSON.stringify({ app: "xano", payload: {} }));
    const fetchMock = stubFetchOk();

    await run(["sandbox", "deploy", "--bundle", bundlePath, "--config", authFile]);

    expect(JSON.parse(postedBundle(fetchMock))).toEqual({ app: "xano", payload: {} });
  });

  it("refreshes an expired access token, persists rotation, and deploys with the new token", async () => {
    const authFile = writeTokenFile(dir, { expires_at: Date.now() - 1000 });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(DISCOVERY))
      .mockResolvedValueOnce(jsonResponse(tokenBody({ access_token: "acc-fresh", refresh_token: "ref-rotated", expires_in: 600 })))
      .mockResolvedValueOnce(new Response('{"imported":true}', { status: 200 }));

    await run(["sandbox", "deploy", "--bundle", bundlePathWith(dir, "{}"), "--config", authFile]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [importUrl, importInit] = fetchMock.mock.calls[2]!;
    expect(importUrl).toBe(`${INSTANCE}/api:meta/sandbox/bundle`);
    expect((importInit?.headers as Record<string, string>).Authorization).toBe("Bearer acc-fresh");

    const saved = JSON.parse(readFileSync(authFile, "utf8"));
    expect(saved.access_token).toBe("acc-fresh");
    expect(saved.refresh_token).toBe("ref-rotated");
  });

  it("CI: exchanges XANO_REFRESH_TOKEN and posts to the aud instance", async () => {
    process.env.XANO_REFRESH_TOKEN = "ci-refresh";
    process.env.XANO_CLIENT_ID = "dcr-abc";
    const ciToken = jwtWithAud("https://ci.example.com");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(DISCOVERY))
      .mockResolvedValueOnce(jsonResponse(tokenBody({ access_token: ciToken, expires_in: 600 })))
      .mockResolvedValueOnce(new Response('{"imported":true}', { status: 200 }));

    await run(["sandbox", "deploy", "--bundle", bundlePathWith(dir, "{}")]);

    const [importUrl, importInit] = fetchMock.mock.calls[2]!;
    expect(importUrl).toBe("https://ci.example.com/api:meta/sandbox/bundle");
    expect((importInit?.headers as Record<string, string>).Authorization).toBe(`Bearer ${ciToken}`);
  });

  it("errors when there is no token cache and no refresh env", async () => {
    await expect(
      run(["sandbox", "deploy", "--bundle", bundlePathWith(dir, "{}"), "--config", join(dir, "nope.json")]),
    ).rejects.toThrow(/Not signed in/);
  });

  it("reuses an unexpired cached token (deploy only — no discovery/refresh)", async () => {
    const authFile = writeTokenFile(dir);
    const fetchMock = stubFetchOk();
    await run(["sandbox", "deploy", "--bundle", bundlePathWith(dir, "{}"), "--config", authFile]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe(`${INSTANCE}/api:meta/sandbox/bundle`);
  });

  it("--reset appends ?reset=true to the sandbox endpoint", async () => {
    const authFile = writeTokenFile(dir);
    const fetchMock = stubFetchOk('{"base_url":"https://x.dev.xano.io/tenant/abc","workspace":{"id":1}}');
    await run(["sandbox", "deploy", "--bundle", bundlePathWith(dir, "{}"), "--config", authFile, "--reset"]);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${INSTANCE}/api:meta/sandbox/bundle?reset=true`);
  });

  it("rejects passing both an entry file and --bundle", async () => {
    const authFile = writeTokenFile(dir);
    stubFetchOk();
    await expect(
      run(["sandbox", "deploy", examplePath, "--bundle", bundlePath, "--config", authFile]),
    ).rejects.toThrow(/not both/);
  });

  it("rejects --static and --prune on sandbox deploy", async () => {
    const authFile = writeTokenFile(dir);
    stubFetchOk();
    await expect(
      run(["sandbox", "deploy", "--bundle", bundlePathWith(dir, "{}"), "--config", authFile, "--static", dir]),
    ).rejects.toThrow(/--static applies only to `workspace deploy`/);
    await expect(
      run(["sandbox", "deploy", "--bundle", bundlePathWith(dir, "{}"), "--config", authFile, "--prune"]),
    ).rejects.toThrow(/--prune applies only to `workspace deploy`/);
  });

  it("surfaces a non-2xx sandbox response as an error", async () => {
    const authFile = writeTokenFile(dir);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("boom", { status: 422, statusText: "Unprocessable Entity" }),
    );
    await expect(
      run(["sandbox", "deploy", "--bundle", bundlePathWith(dir, "{}"), "--config", authFile]),
    ).rejects.toThrow(/failed \(422/);
  });

  it("`sidestep push` is removed with a pointer to sandbox deploy", async () => {
    await expect(run(["push", "--bundle", bundlePathWith(dir, "{}")])).rejects.toThrow(
      /was removed.*sandbox deploy/s,
    );
  });

  it("errors on an unknown noun subcommand", async () => {
    await expect(run(["sandbox", "frobnicate"])).rejects.toThrow(/Unknown sandbox subcommand/);
  });
});

function bundlePathWith(dir: string, contents: string): string {
  const p = join(dir, `b-${contents.length}-${Math.floor(performance.now())}.json`);
  writeFileSync(p, contents);
  return p;
}
