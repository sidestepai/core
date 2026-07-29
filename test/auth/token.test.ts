import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTransientRefreshError, getAccessToken } from "../../src/auth/token.js";
import { parseArgs } from "../../src/emit/cli.js";

describe("isTransientRefreshError", () => {
  // A refresh failure the CLI should retry (and NOT tell the user to run
  // `sidestep login` for): the request never reached the authorization server,
  // so it carries no OAuth error code. See issue #23.
  it("treats transport-level failures as transient", () => {
    expect(isTransientRefreshError(new Error("fetch failed"))).toBe(true);
    expect(isTransientRefreshError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientRefreshError(Object.assign(new Error("timeout"), { name: "AbortError" }))).toBe(true);
    expect(isTransientRefreshError("some string")).toBe(true);
  });

  // An OAuth error response is deterministic and auth-related — never retried,
  // and `sidestep login` (or its handled invalid_grant path) is the right fix.
  it("treats OAuth error responses as non-transient", () => {
    expect(isTransientRefreshError({ error: "invalid_grant" })).toBe(false);
    expect(isTransientRefreshError(Object.assign(new Error("x"), { error: "invalid_client" }))).toBe(false);
  });
});

/**
 * The read-path shadow guard: a stale project-local cache silently wins over the
 * global default, so getAccessToken must warn when the two are bound to
 * DIFFERENT instances (the wrong-instance-deploy footgun). A fresh (unexpired)
 * token means no network is touched.
 */
describe("getAccessToken — stale-local-shadows-global warning", () => {
  let dir: string;
  let stderr: string[];
  let cwd: string;

  function writeCache(path: string, instance: string, workspaceId = 42): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        type: "oauth",
        access_token: "acc",
        refresh_token: "ref",
        expires_at: Date.now() + 3_600_000,
        instance,
        workspace_id: workspaceId,
        auth_host: "https://app.xano.com",
        client_id: "dcr-abc",
      }),
    );
  }

  function writeTokenCache(path: string, instance: string, workspaceId = 42): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        type: "token",
        instance_base_url: instance,
        workspace_id: workspaceId,
        meta_api_token: "meta-tok",
      }),
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidestep-shadow-"));
    stderr = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      stderr.push(typeof c === "string" ? c : c.toString());
      return true;
    });
    cwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    delete process.env.XANO_GLOBAL_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  });

  it("warns when a divergent global cache is shadowed by the local one", async () => {
    process.env.XANO_GLOBAL_CONFIG = join(dir, "global-auth.json");
    writeCache(join(dir, ".xano", "auth.json"), "https://local.xano.io");
    writeCache(join(dir, "global-auth.json"), "https://global.xano.io");

    const auth = await getAccessToken(parseArgs(["deploy"]));
    expect(auth.instance).toBe("https://local.xano.io"); // local still wins
    expect(stderr.join("")).toMatch(/global credential for/i);
    expect(stderr.join("")).toContain("global.xano.io");
  });

  it("stays quiet when both caches point at the same instance", async () => {
    process.env.XANO_GLOBAL_CONFIG = join(dir, "global-auth.json");
    writeCache(join(dir, ".xano", "auth.json"), "https://same.xano.io");
    writeCache(join(dir, "global-auth.json"), "https://same.xano.io");

    await getAccessToken(parseArgs(["deploy"]));
    expect(stderr.join("")).not.toMatch(/global cache bound to/i);
  });

  it("stays quiet under an explicit --local (a deliberate choice, not a silent shadow)", async () => {
    process.env.XANO_GLOBAL_CONFIG = join(dir, "global-auth.json");
    writeCache(join(dir, ".xano", "auth.json"), "https://local.xano.io");
    writeCache(join(dir, "global-auth.json"), "https://global.xano.io");

    await getAccessToken(parseArgs(["deploy", "--local"]));
    expect(stderr.join("")).not.toMatch(/global cache bound to/i);
  });

  it("warns on a divergent WORKSPACE even when the instance matches", async () => {
    // Same host, different workspace is just as destructive for a full-replace
    // deploy as a different host — and far easier to miss.
    process.env.XANO_GLOBAL_CONFIG = join(dir, "global-auth.json");
    writeCache(join(dir, ".xano", "auth.json"), "https://same.xano.io", 7);
    writeCache(join(dir, "global-auth.json"), "https://same.xano.io", 9);

    const auth = await getAccessToken(parseArgs(["deploy"]));
    expect(auth.workspaceId).toBe(7);
    expect(stderr.join("")).toMatch(/workspace 9/);
  });

  it("warns across credential arms (local token shadowing a global oauth)", async () => {
    process.env.XANO_GLOBAL_CONFIG = join(dir, "global-auth.json");
    writeTokenCache(join(dir, ".xano", "auth.json"), "https://local.xano.io", 7);
    writeCache(join(dir, "global-auth.json"), "https://global.xano.io", 9);

    const auth = await getAccessToken(parseArgs(["deploy"]));
    expect(auth.instance).toBe("https://local.xano.io");
    expect(stderr.join("")).toContain("global.xano.io");
  });

  it("does not let an unreadable global credential break a run that isn't using it", async () => {
    process.env.XANO_GLOBAL_CONFIG = join(dir, "global-auth.json");
    writeCache(join(dir, ".xano", "auth.json"), "https://local.xano.io");
    writeFileSync(join(dir, "global-auth.json"), JSON.stringify({ legacy: "no type field" }));

    const auth = await getAccessToken(parseArgs(["deploy"]));
    expect(auth.instance).toBe("https://local.xano.io");
  });
});

/**
 * The `"token"` arm: a hand-authored meta-API credential. Its whole contract is
 * that it does NOTHING beyond reading the file — no refresh, no lock, no
 * network, no write-back. Those absences are the thing worth testing.
 */
describe("getAccessToken — meta API token credential", () => {
  let dir: string;
  let authFile: string;
  let fetchSpy: MockInstance<typeof globalThis.fetch>;

  function write(body: Record<string, unknown>): void {
    writeFileSync(authFile, JSON.stringify(body));
  }

  const VALID = {
    type: "token",
    instance_base_url: "https://x8ki.xano.io",
    workspace_id: 7,
    meta_api_token: "meta-tok",
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidestep-metatok-"));
    authFile = join(dir, "auth.json");
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves the bearer, instance, and workspace straight off the file", async () => {
    write(VALID);
    const auth = await getAccessToken(parseArgs(["deploy", "--config", authFile]));
    expect(auth).toEqual({
      access_token: "meta-tok",
      instance: "https://x8ki.xano.io",
      workspaceId: 7,
      credentialType: "token",
    });
  });

  it("touches no network and never writes the file back", async () => {
    write(VALID);
    const before = readFileSync(authFile, "utf8");
    await getAccessToken(parseArgs(["deploy", "--config", authFile]));
    await getAccessToken(parseArgs(["deploy", "--config", authFile]));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readFileSync(authFile, "utf8")).toBe(before);
  });

  it("has no expiry: it never goes stale and never tries to refresh", async () => {
    // There is no `expires_at` to compare against — the contrast with the oauth
    // arm, which would attempt a refresh grant here.
    write(VALID);
    for (let i = 0; i < 3; i++) {
      expect((await getAccessToken(parseArgs(["deploy", "--config", authFile]))).access_token).toBe("meta-tok");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a plain-http instance_base_url", async () => {
    write({ ...VALID, instance_base_url: "http://x8ki.xano.io" });
    await expect(getAccessToken(parseArgs(["deploy", "--config", authFile]))).rejects.toThrow(/https/);
  });

  it("accepts http://localhost for a local engine", async () => {
    write({ ...VALID, instance_base_url: "http://localhost:8080" });
    const auth = await getAccessToken(parseArgs(["deploy", "--config", authFile]));
    expect(auth.instance).toBe("http://localhost:8080");
  });

  it("surfaces a hand-authoring typo by field name, not as a 404 later", async () => {
    write({ ...VALID, workspace_id: "7" });
    await expect(getAccessToken(parseArgs(["deploy", "--config", authFile]))).rejects.toThrow(
      /workspace_id.*positive integer/s,
    );
  });

  it("reports a missing credential file against the resolved path", async () => {
    await expect(
      getAccessToken(parseArgs(["deploy", "--config", join(dir, "absent.json")])),
    ).rejects.toThrow(/Not signed in/);
  });
});
