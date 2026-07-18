import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, readFileSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../src/emit/cli.js";

const examplePath = fileURLToPath(new URL("../fixtures/workspace/index.ts", import.meta.url));

const INSTANCE = "https://default.example.com";
// Valid OIDC/RFC 8414 metadata — openid-client's discovery requires `issuer`.
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

/** Write a token cache file and return its path. Defaults to an unexpired token.
 *  Pass `refresh_token: undefined` explicitly (the key present) to omit it. */
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
  // Present-but-undefined omits the field; absent uses the default.
  if ("refresh_token" in o) {
    if (o.refresh_token !== undefined) record.refresh_token = o.refresh_token;
  } else {
    record.refresh_token = "ref-cached";
  }
  mkdirSync(join(dir, ".xano"), { recursive: true });
  writeFileSync(path, JSON.stringify(record));
  return path;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "ERR",
    // oauth4webapi (openid-client) requires a JSON content-type on discovery /
    // token responses; without it, discovery and the refresh grant reject.
    headers: { "content-type": "application/json" },
  });
}

/** A token-endpoint response body, with the `token_type` oauth4webapi requires. */
function tokenBody(o: Record<string, unknown>): Record<string, unknown> {
  return { token_type: "bearer", ...o };
}

/** Single-response stub (import-only path). */
function stubFetchOk(body = '{"ok":true}') {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200, statusText: "OK" }));
}

describe("sidestep push CLI (OAuth)", () => {
  let dir: string;
  let bundlePath: string;
  let stdoutChunks: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidestep-push-"));
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
    delete process.env.XANO_INSTANCE;
    delete process.env.XANO_AUTH_HOST;
  });

  it("compiles a workspace entry and POSTs it to the cached instance with the OAuth token", async () => {
    const authFile = writeTokenFile(dir);
    const fetchMock = stubFetchOk('{"imported":true}');

    await run(["push", examplePath, "--auth-file", authFile]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${INSTANCE}/api:meta/sandbox/bundle`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer acc-cached");
    const posted = JSON.parse(init!.body as string);
    expect(posted.app).toBe("xano");
    expect(posted.payload.workspace).toMatchObject({ name: "example" });
    expect(stdoutChunks.join("")).toContain("imported");
  });

  it("uploads an existing bundle with --bundle, without compiling", async () => {
    const authFile = writeTokenFile(dir);
    writeFileSync(bundlePath, JSON.stringify({ app: "xano", payload: {} }));
    const fetchMock = stubFetchOk();

    await run(["push", "--bundle", bundlePath, "--auth-file", authFile]);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({ app: "xano", payload: {} });
  });

  it("refreshes an expired access token, persists rotation, and pushes with the new token", async () => {
    const authFile = writeTokenFile(dir, { expires_at: Date.now() - 1000 });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(DISCOVERY)) // discover
      .mockResolvedValueOnce(jsonResponse(tokenBody({ access_token: "acc-fresh", refresh_token: "ref-rotated", expires_in: 600 }))) // refresh
      .mockResolvedValueOnce(new Response('{"imported":true}', { status: 200 })); // import

    await run(["push", "--bundle", bundlePathWith(dir, "{}"), "--auth-file", authFile]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [importUrl, importInit] = fetchMock.mock.calls[2]!;
    expect(importUrl).toBe(`${INSTANCE}/api:meta/sandbox/bundle`);
    expect((importInit?.headers as Record<string, string>).Authorization).toBe("Bearer acc-fresh");

    const saved = JSON.parse(readFileSync(authFile, "utf8"));
    expect(saved.access_token).toBe("acc-fresh");
    expect(saved.refresh_token).toBe("ref-rotated");
    expect(saved.expires_at).toBeGreaterThan(Date.now());
  });

  it("two concurrent pushes on a stale token refresh only ONCE (cross-process lock)", async () => {
    const authFile = writeTokenFile(dir, { expires_at: Date.now() - 1000 });
    let refreshCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/.well-known/")) return jsonResponse(DISCOVERY);
      if (u.includes("/oauth/token")) {
        refreshCount++;
        return jsonResponse(tokenBody({ access_token: "acc-fresh", refresh_token: "rot", expires_in: 600 }));
      }
      if (u.includes("/sandbox/bundle")) return new Response('{"imported":true}', { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    });

    await Promise.all([
      run(["push", "--bundle", bundlePathWith(dir, "{}"), "--auth-file", authFile]),
      run(["push", "--bundle", bundlePathWith(dir, "{  }"), "--auth-file", authFile]),
    ]);

    // The second push waited on the lock, re-read the freshly-rotated token, and
    // skipped its own refresh — so the single-use refresh token is spent once.
    expect(refreshCount).toBe(1);
    expect(JSON.parse(readFileSync(authFile, "utf8")).refresh_token).toBe("rot");
  });

  it("CI: exchanges XANO_REFRESH_TOKEN for an access token without touching a file", async () => {
    process.env.XANO_REFRESH_TOKEN = "ci-refresh";
    process.env.XANO_CLIENT_ID = "dcr-abc";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(DISCOVERY)) // discover
      .mockResolvedValueOnce(jsonResponse(tokenBody({ access_token: "acc-ci", expires_in: 600 }))) // refresh
      .mockResolvedValueOnce(new Response('{"imported":true}', { status: 200 })); // import

    await run(["push", "--bundle", bundlePathWith(dir, "{}"), "--instance", "https://ci.example.com"]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const refreshBody = new URLSearchParams(fetchMock.mock.calls[1]![1]!.body as string);
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    expect(refreshBody.get("refresh_token")).toBe("ci-refresh");
    expect(refreshBody.get("client_id")).toBe("dcr-abc");
    const [importUrl, importInit] = fetchMock.mock.calls[2]!;
    expect(importUrl).toBe("https://ci.example.com/api:meta/sandbox/bundle");
    expect((importInit?.headers as Record<string, string>).Authorization).toBe("Bearer acc-ci");
  });

  it("CI: errors when XANO_REFRESH_TOKEN is set but no instance is given", async () => {
    process.env.XANO_REFRESH_TOKEN = "ci-refresh";
    process.env.XANO_CLIENT_ID = "dcr-abc";
    await expect(run(["push", "--bundle", bundlePathWith(dir, "{}")])).rejects.toThrow(/no target instance/i);
  });

  it("CI: errors when XANO_REFRESH_TOKEN is set but XANO_CLIENT_ID is missing", async () => {
    process.env.XANO_REFRESH_TOKEN = "ci-refresh";
    await expect(
      run(["push", "--bundle", bundlePathWith(dir, "{}"), "--instance", "https://ci.example.com"]),
    ).rejects.toThrow(/XANO_CLIENT_ID is not/);
  });

  it("errors when there is no token cache and no refresh env", async () => {
    await expect(
      run(["push", "--bundle", bundlePathWith(dir, "{}"), "--auth-file", join(dir, "nope.json")]),
    ).rejects.toThrow(/Not signed in/);
  });

  it("errors when the access token is expired and no refresh token is cached", async () => {
    const authFile = writeTokenFile(dir, { expires_at: Date.now() - 1000, refresh_token: undefined });
    await expect(
      run(["push", "--bundle", bundlePathWith(dir, "{}"), "--auth-file", authFile]),
    ).rejects.toThrow(/no refresh token is cached/i);
  });

  it("errors with an actionable message on a corrupt token cache", async () => {
    const authFile = join(dir, ".xano", "auth.json");
    mkdirSync(join(dir, ".xano"), { recursive: true });
    writeFileSync(authFile, "{ not valid json");
    await expect(
      run(["push", "--bundle", bundlePathWith(dir, "{}"), "--auth-file", authFile]),
    ).rejects.toThrow(/corrupt/i);
  });

  it("rejects a non-https instance (plain http to a non-localhost host)", async () => {
    process.env.XANO_REFRESH_TOKEN = "ci-refresh";
    await expect(
      run(["push", "--bundle", bundlePathWith(dir, "{}"), "--instance", "http://insecure.example.com"]),
    ).rejects.toThrow(/must use https/i);
  });

  it("--instance to a DIFFERENT origin re-mints a token for the new audience (never reuses the cached one)", async () => {
    // The cached token's audience is the saved instance; pushing to a different
    // --instance must NOT reuse it (audience mismatch). It re-mints via refresh.
    const authFile = writeTokenFile(dir); // saved instance = INSTANCE, unexpired
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(DISCOVERY)) // discover
      .mockResolvedValueOnce(jsonResponse(tokenBody({ access_token: "acc-override", refresh_token: "r2", expires_in: 600 }))) // refresh
      .mockResolvedValueOnce(new Response('{"imported":true}', { status: 200 })); // import

    await run(["push", "--bundle", bundlePathWith(dir, "{}"), "--auth-file", authFile, "--instance", "https://override.example.com"]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The refresh requested a token for the OVERRIDE instance (resource).
    const refreshBody = new URLSearchParams(fetchMock.mock.calls[1]![1]!.body as string);
    expect(refreshBody.get("resource")).toBe("https://override.example.com");
    const [importUrl, importInit] = fetchMock.mock.calls[2]!;
    expect(importUrl).toBe("https://override.example.com/api:meta/sandbox/bundle");
    expect((importInit?.headers as Record<string, string>).Authorization).toBe("Bearer acc-override");
  });

  it("--instance equal to the cached instance reuses the cached token (no refresh)", async () => {
    const authFile = writeTokenFile(dir); // saved instance = INSTANCE
    const fetchMock = stubFetchOk();
    await run(["push", "--bundle", bundlePathWith(dir, "{}"), "--auth-file", authFile, "--instance", INSTANCE]);
    expect(fetchMock).toHaveBeenCalledOnce(); // import only, no discovery/refresh
    expect(fetchMock.mock.calls[0]![0]).toBe(`${INSTANCE}/api:meta/sandbox/bundle`);
  });

  it("rejects passing both an entry file and --bundle", async () => {
    const authFile = writeTokenFile(dir);
    stubFetchOk();
    await expect(
      run(["push", examplePath, "--bundle", bundlePath, "--auth-file", authFile]),
    ).rejects.toThrow(/not both/);
  });

  it("surfaces a non-2xx sandbox response as an error", async () => {
    const authFile = writeTokenFile(dir);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("boom", { status: 422, statusText: "Unprocessable Entity" }),
    );
    await expect(
      run(["push", "--bundle", bundlePathWith(dir, "{}"), "--auth-file", authFile]),
    ).rejects.toThrow(/Sandbox import failed \(422/);
  });
});

/** Write a throwaway bundle file in `dir` and return its path. */
function bundlePathWith(dir: string, contents: string): string {
  const p = join(dir, `b-${contents.length}-${Math.floor(performance.now())}.json`);
  writeFileSync(p, contents);
  return p;
}
