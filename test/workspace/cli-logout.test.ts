import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/emit/cli.js";

/**
 * Valid OIDC metadata that also advertises a revocation endpoint, so
 * openid-client's `tokenRevocation` has somewhere to POST.
 */
const DISCOVERY = {
  issuer: "https://app.xano.com",
  authorization_endpoint: "https://app.xano.com/oauth2/authorize",
  token_endpoint: "https://app.xano.com/api:master/oauth/token",
  revocation_endpoint: "https://app.xano.com/api:master/oauth/revoke",
  token_endpoint_auth_methods_supported: ["none"],
};

function oauthJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function writeTokenFile(dir: string, withRefresh: boolean): string {
  const path = join(dir, ".xano", "auth.json");
  const record: Record<string, unknown> = {
    access_token: "acc",
    expires_at: Date.now() + 3_600_000,
    scope: "offline_access workspace:write",
    instance: "https://x8ki.xano.io",
    auth_host: "https://app.xano.com",
    client_id: "dcr-abc",
  };
  if (withRefresh) record.refresh_token = "ref-to-revoke";
  mkdirSync(join(dir, ".xano"), { recursive: true });
  writeFileSync(path, JSON.stringify(record));
  return path;
}

describe("sidestep logout", () => {
  let dir: string;
  let stderr: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidestep-logout-"));
    stderr = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("revokes the refresh token at the AS and deletes the token cache", async () => {
    const authFile = writeTokenFile(dir, true);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof URL ? input.href : input instanceof Request ? input.url : String(input);
      if (url.includes("/.well-known/")) return oauthJson(DISCOVERY);
      if (url.includes("/oauth/revoke")) return new Response("", { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });

    await run(["logout", "--config", authFile]);

    // The refresh token was POSTed to the revocation endpoint…
    const revokeCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/oauth/revoke"));
    expect(revokeCall).toBeTruthy();
    const body = new URLSearchParams(revokeCall![1]!.body as string);
    expect(body.get("token")).toBe("ref-to-revoke");
    expect(body.get("token_type_hint")).toBe("refresh_token");
    // …and the local cache was removed.
    expect(existsSync(authFile)).toBe(false);
    expect(stderr.join("")).toContain("Signed out");
  });

  it("still clears local credentials when revocation fails at the AS", async () => {
    const authFile = writeTokenFile(dir, true);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof URL ? input.href : input instanceof Request ? input.url : String(input);
      if (url.includes("/.well-known/")) return oauthJson(DISCOVERY);
      if (url.includes("/oauth/revoke")) return new Response("nope", { status: 500, statusText: "ERR" });
      throw new Error(`unexpected fetch: ${url}`);
    });

    await run(["logout", "--config", authFile]);

    expect(existsSync(authFile)).toBe(false); // best-effort revoke, local clear always happens
    expect(stderr.join("")).toMatch(/could not revoke/i);
  });

  it("is a no-op with a clear message when not signed in", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run(["logout", "--config", join(dir, "nope.json")]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderr.join("")).toMatch(/not signed in/i);
  });

  it("--local never touches the shared cache (no silent global revoke)", async () => {
    // A global cache exists, but with --local and no project-local cache
    // `logout` must be a no-op — not a revoke of the shared cred.
    const globalPath = join(dir, "global", "auth.json");
    mkdirSync(join(dir, "global"), { recursive: true });
    writeFileSync(globalPath, JSON.stringify({ refresh_token: "shared-ref", auth_host: "https://app.xano.com", client_id: "dcr-abc" }));
    process.env.XANO_GLOBAL_CONFIG = globalPath;
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const cwd = process.cwd();
    try {
      process.chdir(dir); // no ./.xano/auth.json here
      await run(["logout", "--local"]);
    } finally {
      process.chdir(cwd);
      delete process.env.XANO_GLOBAL_CONFIG;
    }

    expect(fetchMock).not.toHaveBeenCalled(); // nothing revoked
    expect(existsSync(globalPath)).toBe(true); // shared cache untouched
    expect(stderr.join("")).toMatch(/not signed in/i);
  });

  it("by default revokes and clears the shared global cache", async () => {
    const globalPath = join(dir, "global", "auth.json");
    mkdirSync(join(dir, "global"), { recursive: true });
    writeFileSync(
      globalPath,
      JSON.stringify({
        access_token: "acc",
        refresh_token: "shared-ref",
        instance: "https://x8ki.xano.io",
        auth_host: "https://app.xano.com",
        client_id: "dcr-abc",
      }),
    );
    process.env.XANO_GLOBAL_CONFIG = globalPath;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof URL ? input.href : input instanceof Request ? input.url : String(input);
      if (url.includes("/.well-known/")) return oauthJson(DISCOVERY);
      if (url.includes("/oauth/revoke")) return new Response("", { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    try {
      await run(["logout"]);
    } finally {
      delete process.env.XANO_GLOBAL_CONFIG;
    }

    const revokeCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/oauth/revoke"));
    expect(new URLSearchParams(revokeCall![1]!.body as string).get("token")).toBe("shared-ref");
    expect(existsSync(globalPath)).toBe(false); // shared cache cleared
    expect(stderr.join("")).toContain("Signed out");
  });
});
