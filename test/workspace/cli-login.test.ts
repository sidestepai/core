import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, run } from "../../src/emit/cli.js";

describe("parseArgs — login/OAuth flags", () => {
  it("parses --origin, --config, --scope in both flag forms", () => {
    const spaced = parseArgs([
      "login",
      "--origin",
      "https://app.xano.com",
      "--config",
      "./.xano/auth.json",
      "--scope",
      "openid offline_access",
    ]);
    expect(spaced.authHost).toBe("https://app.xano.com");
    expect(spaced.authFile).toBe("./.xano/auth.json");
    expect(spaced.scope).toBe("openid offline_access");

    const inline = parseArgs([
      "login",
      "--origin=https://app.xano.com",
      "--config=./.xano/auth.json",
      "--scope=openid offline_access",
    ]);
    expect(inline.authHost).toBe("https://app.xano.com");
    expect(inline.authFile).toBe("./.xano/auth.json");
    expect(inline.scope).toBe("openid offline_access");
  });

  it("parses --port as a number (both forms)", () => {
    expect(parseArgs(["login", "--port", "8123"]).port).toBe(8123);
    expect(parseArgs(["login", "--port=8123"]).port).toBe(8123);
  });

  it("rejects a non-numeric or out-of-range --port", () => {
    expect(() => parseArgs(["login", "--port", "abc"])).toThrow(/--port must be an integer/);
    expect(() => parseArgs(["login", "--port", "70000"])).toThrow(/--port must be an integer/);
    expect(() => parseArgs(["login", "--port"])).toThrow(/--port must be an integer/);
  });

  it("fails loudly on the removed --profile flag instead of swallowing it", () => {
    expect(() => parseArgs(["push", "./index.ts", "--profile", "staging"])).toThrow(/was removed/);
  });

  it("parses --config (the token cache path) rather than treating it as removed", () => {
    expect(parseArgs(["push", "./index.ts", "--config=./creds.json"]).authFile).toBe("./creds.json");
    expect(parseArgs(["push", "./index.ts", "--config", "./creds.json"]).authFile).toBe("./creds.json");
  });

  it("parses `push --reset` as a boolean flag", () => {
    expect(parseArgs(["push", "./src/index.ts", "--reset"]).reset).toBe(true);
    expect(parseArgs(["push", "./src/index.ts"]).reset).toBe(false);
  });

  it("does not leak a flag value into positionals", () => {
    const args = parseArgs(["push", "./src/index.ts", "--config", "./creds.json"]);
    expect(args.positionals).toEqual(["./src/index.ts"]);
    expect(args.file).toBe("./src/index.ts");
    expect(args.authFile).toBe("./creds.json");
  });

  it("leaves login flags undefined/default when absent", () => {
    const args = parseArgs(["push", "./src/index.ts"]);
    expect(args.authHost).toBeUndefined();
    expect(args.authFile).toBeUndefined();
    expect(args.port).toBeUndefined();
    expect(args.scope).toBeUndefined();
    expect(args.reset).toBe(false);
  });
});

/** Poll until `predicate()` is true or the deadline passes. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Drive the loopback callback with a plain node:http GET (bypasses fetch mock). */
function hitCallback(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("error", reject);
  });
}

/** Minimal unsigned JWT carrying an `aud` claim, so decodeAudience can read it. */
function jwtWithAud(aud: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ typ: "at+jwt" })}.${b64({ aud })}.sig`;
}

describe("sidestep login (end-to-end)", () => {
  let dir: string;
  let authPath: string;
  let stderr: string[];

  // A valid RFC 8414 / OIDC metadata document — openid-client's discovery
  // requires `issuer` and a JSON content-type, and both our manual discover()
  // and openid-client fetch a `/.well-known/*` path.
  const DISCOVERY = {
    issuer: "https://app.xano.com",
    authorization_endpoint: "https://app.xano.com/oauth2/authorize",
    token_endpoint: "https://app.xano.com/api:master/oauth/token",
    registration_endpoint: "https://app.xano.com/api:master/oauth/register",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };

  /** JSON response with the content-type oauth4webapi requires. */
  function oauthJson(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidestep-login-"));
    mkdirSync(join(dir, ".git")); // contain ensureGitignored to this dir
    authPath = join(dir, ".xano", "auth.json");
    stderr = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    process.env.XANO_NO_BROWSER = "1";
    process.env.XANO_CLIENT_FILE = join(dir, "clients.json"); // keep DCR cache out of ~/.xano
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.XANO_NO_BROWSER;
    delete process.env.XANO_CLIENT_FILE;
    delete process.env.XANO_ORIGIN;
  });

  /**
   * Route OAuth fetches by URL (discovery / DCR registration / token endpoint).
   * openid-client issues its own discovery request in addition to our manual
   * one, so a fixed call-order stub no longer holds — matching on the URL does.
   * The loopback callback is driven over real `node:http` (see `hitCallback`),
   * so it never passes through this mock.
   */
  function stubOauthFetch(tokenBody: Record<string, unknown>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof URL ? input.href : input instanceof Request ? input.url : String(input);
      if (url.includes("/.well-known/")) return oauthJson(DISCOVERY);
      if (url.includes("/oauth/register")) return oauthJson({ client_id: "dcr-xyz" });
      if (url.includes("/oauth/token")) return oauthJson({ token_type: "bearer", ...tokenBody });
      // login PINS the numeric workspace, so it reads the guid→id mapping once.
      if (url.includes("/api:meta/auth/me")) {
        return oauthJson({
          extras: {
            oauth: { workspace: "ws-guid" },
            instance: { membership: { workspace: [{ guid: "ws-guid", id: 42 }] } },
          },
        });
      }
      throw new Error(`unexpected fetch in login test: ${url}`);
    });
  }

  /** Pull the authorize URL that login wrote to stderr. */
  function authorizeUrlFromStderr(): URL {
    const text = stderr.join("");
    const match = text.match(/https:\/\/app\.xano\.com\/oauth2\/authorize\?\S+/);
    if (!match) throw new Error(`no authorize URL in stderr:\n${text}`);
    return new URL(match[0]);
  }

  it("runs the full flow (discover → register → exchange), derives the instance from aud, writes tokens + client_id + gitignore", async () => {
    stubOauthFetch({ access_token: jwtWithAud("https://x8ki.xano.io"), refresh_token: "ref", expires_in: 600 });

    const p = run(["login", "--config", authPath, "--port", "0"]);

    await waitFor(() => stderr.join("").includes("/oauth2/authorize?"));
    const authUrl = authorizeUrlFromStderr();
    const redirectUri = authUrl.searchParams.get("redirect_uri")!;
    const state = authUrl.searchParams.get("state")!;
    expect(authUrl.searchParams.get("client_id")).toBe("dcr-xyz");
    // The user always picks the instance at consent — never a `resource` param.
    expect(authUrl.searchParams.has("resource")).toBe(false);

    await hitCallback(`${redirectUri}?code=the-code&state=${state}`);
    await p;

    const saved = JSON.parse(readFileSync(authPath, "utf8"));
    expect(saved.access_token).toBe(jwtWithAud("https://x8ki.xano.io"));
    expect(saved.refresh_token).toBe("ref");
    expect(saved.instance).toBe("https://x8ki.xano.io"); // read from the token's aud
    expect(saved.client_id).toBe("dcr-xyz");
    expect(saved.expires_at).toBeGreaterThan(Date.now());
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".xano/");
    // The DCR client was cached globally for reuse.
    expect(existsSync(join(dir, "clients.json"))).toBe(true);
  });

  it("with no flag writes to the shared GLOBAL cache and says so", async () => {
    const globalCache = join(dir, "global-auth.json");
    process.env.XANO_GLOBAL_CONFIG = globalCache;
    stubOauthFetch({ access_token: jwtWithAud("https://x8ki.xano.io"), refresh_token: "ref", expires_in: 600 });
    const cwd = process.cwd();
    try {
      process.chdir(dir); // so a stray ./.xano can't shadow the default
      const p = run(["login", "--port", "0"]); // no --config, no --local
      await waitFor(() => stderr.join("").includes("/oauth2/authorize?"));
      const authUrl = authorizeUrlFromStderr();
      await hitCallback(`${authUrl.searchParams.get("redirect_uri")}?code=c&state=${authUrl.searchParams.get("state")}`);
      await p;
    } finally {
      process.chdir(cwd);
      delete process.env.XANO_GLOBAL_CONFIG;
    }
    // Token landed in the global cache, NOT the project-local one.
    expect(existsSync(globalCache)).toBe(true);
    expect(existsSync(join(dir, ".xano", "auth.json"))).toBe(false);
    expect(JSON.parse(readFileSync(globalCache, "utf8")).instance).toBe("https://x8ki.xano.io");
    expect(stderr.join("")).toMatch(/shared ~\/\.sidestep cache/);
  });

  it("with --local writes to the project-local cache and says so", async () => {
    process.env.XANO_GLOBAL_CONFIG = join(dir, "global-auth.json");
    stubOauthFetch({ access_token: jwtWithAud("https://x8ki.xano.io"), refresh_token: "ref", expires_in: 600 });
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const p = run(["login", "--local", "--port", "0"]);
      await waitFor(() => stderr.join("").includes("/oauth2/authorize?"));
      const authUrl = authorizeUrlFromStderr();
      await hitCallback(`${authUrl.searchParams.get("redirect_uri")}?code=c&state=${authUrl.searchParams.get("state")}`);
      await p;
    } finally {
      process.chdir(cwd);
      delete process.env.XANO_GLOBAL_CONFIG;
    }
    // Token landed in ./.xano/, NOT the global cache.
    expect(existsSync(join(dir, ".xano", "auth.json"))).toBe(true);
    expect(existsSync(join(dir, "global-auth.json"))).toBe(false);
    expect(stderr.join("")).toMatch(/project-local \.xano cache/);
  });

  it("with --config <path> claims neither cache scope (no false 'shared' line)", async () => {
    stubOauthFetch({ access_token: jwtWithAud("https://x8ki.xano.io"), refresh_token: "ref", expires_in: 600 });
    const p = run(["login", "--config", authPath, "--port", "0"]);
    await waitFor(() => stderr.join("").includes("/oauth2/authorize?"));
    const authUrl = authorizeUrlFromStderr();
    await hitCallback(`${authUrl.searchParams.get("redirect_uri")}?code=c&state=${authUrl.searchParams.get("state")}`);
    await p;
    const out = stderr.join("");
    expect(out).toMatch(new RegExp(`Credentials saved to ${authPath.replace(/[.\\/]/g, "\\$&")}`));
    // The explicit path is neither the shared nor the project-local cache, so no scope claim.
    expect(out).not.toMatch(/shared ~\/\.sidestep cache/);
    expect(out).not.toMatch(/project-local \.xano cache/);
  });

  it("errors when the issued token carries no readable aud", async () => {
    stubOauthFetch({ access_token: "opaque-not-a-jwt", refresh_token: "ref", expires_in: 600 });
    const p = run(["login", "--config", authPath, "--port", "0"]);
    const rejected = expect(p).rejects.toThrow(/Could not determine the instance/);
    await waitFor(() => stderr.join("").includes("/oauth2/authorize?"));
    const authUrl = authorizeUrlFromStderr();
    await hitCallback(`${authUrl.searchParams.get("redirect_uri")}?code=c&state=${authUrl.searchParams.get("state")}`);
    await rejected;
  });
});
