import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

  function writeCache(path: string, instance: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        access_token: "acc",
        refresh_token: "ref",
        expires_at: Date.now() + 3_600_000,
        instance,
        auth_host: "https://app.xano.com",
        client_id: "dcr-abc",
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
    expect(stderr.join("")).toMatch(/global cache bound to/i);
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
});
