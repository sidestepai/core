import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, readFileSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
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

/** Recover a fetch mock's posted body — the raw bundle JSON text. */
function postedBundle(fetchMock: ReturnType<typeof stubFetchOk>, callIndex = 0): string {
  const init = fetchMock.mock.calls[callIndex]![1] as RequestInit;
  return init.body as string;
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

  it("compiles a workspace entry and POSTs the bundle to the sandbox endpoint", async () => {
    const authFile = writeTokenFile(dir);
    const fetchMock = stubFetchOk(
      '{"base_url":"https://x.dev.xano.io/tenant/abc","workspace":{"id":1,"name":"example","crypto":{"secret":"s3cr3t"}}}',
    );

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

    // stdout is a projected, secret-free summary — not the raw workspace blob.
    const out = JSON.parse(stdoutChunks.join(""));
    expect(out).toEqual({
      baseUrl: "https://x.dev.xano.io/tenant/abc",
      workspace: { id: 1, name: "example" },
    });
    expect(stdoutChunks.join("")).not.toContain("s3cr3t");
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

  it("--static resolves the parent workspace from the token and uploads with the caller's own bearer", async () => {
    const authFile = writeTokenFile(dir);
    const staticDir = join(dir, "site");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<h1>hi</h1>");

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      // 1) backend deploy to the sandbox
      .mockResolvedValueOnce(jsonResponse({ base_url: "https://x.dev/tenant/sbx-1", workspace: { id: 1 } }))
      // 2) auth/me — resolves the token's scoped workspace guid to numeric id 9
      .mockResolvedValueOnce(
        jsonResponse({ extras: { oauth: { workspace: "guid-B" }, instance: { membership: { workspace: [{ guid: "guid-B", id: 9 }] } } } }),
      )
      // 3) the meta build upload on the parent workspace (auto-deploys)
      .mockResolvedValueOnce(jsonResponse({ default_url: "https://default-dev-abc.xano.io" }));

    await run(["sandbox", "deploy", "--bundle", bundlePathWith(dir, "{}"), "--config", authFile, "--static", staticDir]);

    expect(fetchMock.mock.calls[1]![0]).toBe(`${INSTANCE}/api:meta/auth/me`);
    // The upload targets the caller's OWN (parent) workspace (9, resolved from the
    // token), NOT the sandbox — and carries the caller's own bearer, no X-Tenant.
    const [staticUrl, staticInit] = fetchMock.mock.calls[2]!;
    expect(staticUrl).toBe(`${INSTANCE}/api:meta/workspace/9/static_host/default/build`);
    const headers = (staticInit as RequestInit).headers as Record<string, string>;
    expect(headers["X-Tenant"]).toBeUndefined();
    expect(headers.Authorization).toBe("Bearer acc-cached");

    // The projected stdout summary carries both the backend base URL and the
    // deployed static host URL.
    const out = JSON.parse(stdoutChunks.join(""));
    expect(out.baseUrl).toBe("https://x.dev/tenant/sbx-1");
    expect(out.static).toEqual({ url: "https://default-dev-abc.xano.io" });
  });

  it("--static fails the static step (exit 3), not the deploy, when the workspace can't be resolved", async () => {
    const authFile = writeTokenFile(dir);
    const staticDir = join(dir, "site3");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<h1>hi</h1>");

    // Backend deploy commits; then auth/me is ambiguous (no scoped guid, >1 workspace),
    // so the static step fails resumably rather than crashing or guessing.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ base_url: "https://x.dev/tenant/sbx-1", workspace: { id: 1 } }))
      .mockResolvedValueOnce(
        jsonResponse({ extras: { oauth: {}, instance: { membership: { workspace: [{ guid: "a", id: 3 }, { guid: "b", id: 9 }] } } } }),
      );

    await run(["sandbox", "deploy", "--bundle", bundlePathWith(dir, "{}"), "--config", authFile, "--static", staticDir]);
    expect(process.exitCode).toBe(3);
    process.exitCode = 0;
  });

  it("--static fails the static step, not the deploy, when the build upload returns non-2xx", async () => {
    const authFile = writeTokenFile(dir);
    const staticDir = join(dir, "site2");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<h1>hi</h1>");

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ base_url: "https://x.dev/tenant/sbx-1", workspace: { id: 1 } }))
      .mockResolvedValueOnce(
        jsonResponse({ extras: { oauth: { workspace: "guid-B" }, instance: { membership: { workspace: [{ guid: "guid-B", id: 9 }] } } } }),
      )
      .mockResolvedValueOnce(new Response("boom", { status: 500, statusText: "ERR" }));

    // The backend deploy already committed, so this must not throw — it reports
    // a resumable static failure via the exit code instead.
    await run(["sandbox", "deploy", "--bundle", bundlePathWith(dir, "{}"), "--config", authFile, "--static", staticDir]);
    expect(process.exitCode).toBe(3);
    process.exitCode = 0;
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

  it("`sidestep workspace deploy` is removed with a pointer to sandbox deploy", async () => {
    await expect(run(["workspace", "deploy", examplePath])).rejects.toThrow(
      /workspace deploy.*was removed.*sandbox is the only deploy target/s,
    );
  });

  it.each(["--prune", "--confirm-workspace", "--adopt-workspace"])(
    "loud-fails the removed `%s` flag instead of silently ignoring it",
    async (flag) => {
      const authFile = writeTokenFile(dir);
      await expect(
        run(["sandbox", "deploy", examplePath, flag, "my-app", "--config", authFile]),
      ).rejects.toThrow(new RegExp(`\\${flag}\`? was removed`));
    },
  );

  it("errors on an unknown noun subcommand", async () => {
    await expect(run(["sandbox", "frobnicate"])).rejects.toThrow(/Unknown sandbox subcommand/);
  });
});

function bundlePathWith(dir: string, contents: string): string {
  const p = join(dir, `b-${contents.length}-${Math.floor(performance.now())}.json`);
  writeFileSync(p, contents);
  return p;
}
