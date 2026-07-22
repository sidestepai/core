import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveValidateConfig, verifyToken } from "../../src/validate/config.js";

const ENV_KEYS = ["XANO_VALIDATE_INSTANCE", "XANO_VALIDATE_TOKEN", "XANO_VALIDATE_WORKSPACE_ID"];

describe("resolveValidateConfig", () => {
  let saved: Record<string, string | undefined>;
  let cwd: string;
  let origCwd: string;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    origCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "sidestep-validate-cfg-"));
    process.chdir(cwd); // isolate .env autoload from the repo's own .env
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(cwd, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("resolves instance + token (+ optional workspace) from env", () => {
    process.env.XANO_VALIDATE_INSTANCE = "https://inst.xano.io";
    process.env.XANO_VALIDATE_TOKEN = "tok-123";
    process.env.XANO_VALIDATE_WORKSPACE_ID = "7";
    expect(resolveValidateConfig()).toEqual({ instance: "https://inst.xano.io", token: "tok-123", workspaceId: 7 });
  });

  it("normalizes the instance to a bare origin", () => {
    process.env.XANO_VALIDATE_INSTANCE = "http://localhost:8080/some/path";
    process.env.XANO_VALIDATE_TOKEN = "tok";
    expect(resolveValidateConfig().instance).toBe("http://localhost:8080");
  });

  it("throws a variable-naming error when the instance is missing", () => {
    process.env.XANO_VALIDATE_TOKEN = "tok";
    expect(() => resolveValidateConfig()).toThrow(/XANO_VALIDATE_INSTANCE/);
  });

  it("throws a variable-naming error when the token is missing", () => {
    process.env.XANO_VALIDATE_INSTANCE = "https://inst.xano.io";
    expect(() => resolveValidateConfig()).toThrow(/XANO_VALIDATE_TOKEN/);
  });

  it("rejects a non-http(s) instance URL", () => {
    process.env.XANO_VALIDATE_INSTANCE = "ftp://nope";
    process.env.XANO_VALIDATE_TOKEN = "tok";
    expect(() => resolveValidateConfig()).toThrow(/http/);
  });

  it("rejects a non-URL instance", () => {
    process.env.XANO_VALIDATE_INSTANCE = "not a url";
    process.env.XANO_VALIDATE_TOKEN = "tok";
    expect(() => resolveValidateConfig()).toThrow(/full URL/);
  });

  it("rejects a non-positive-integer workspace id", () => {
    process.env.XANO_VALIDATE_INSTANCE = "https://inst.xano.io";
    process.env.XANO_VALIDATE_TOKEN = "tok";
    process.env.XANO_VALIDATE_WORKSPACE_ID = "0";
    expect(() => resolveValidateConfig()).toThrow(/positive integer/);
  });

  it("lets --instance / --workspace overrides win over env", () => {
    process.env.XANO_VALIDATE_INSTANCE = "https://env.xano.io";
    process.env.XANO_VALIDATE_TOKEN = "tok";
    process.env.XANO_VALIDATE_WORKSPACE_ID = "1";
    const cfg = resolveValidateConfig({ instance: "https://override.xano.io", workspaceId: 9 });
    expect(cfg.instance).toBe("https://override.xano.io");
    expect(cfg.workspaceId).toBe(9);
  });

  it("autoloads a cwd .env when the env var is unset (env still wins when set)", () => {
    writeFileSync(join(cwd, ".env"), 'XANO_VALIDATE_INSTANCE="https://fromfile.xano.io"\nXANO_VALIDATE_TOKEN=file-tok\n');
    // instance comes from the file (unset in env); token set in env overrides the file
    process.env.XANO_VALIDATE_TOKEN = "env-tok";
    const cfg = resolveValidateConfig();
    expect(cfg.instance).toBe("https://fromfile.xano.io");
    expect(cfg.token).toBe("env-tok");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, statusText: status === 200 ? "OK" : "ERR" });
}

describe("verifyToken", () => {
  afterEach(() => vi.restoreAllMocks());

  const config = { instance: "https://inst.xano.io", token: "tok", workspaceId: undefined };

  it("calls /api:meta/auth/me with the bearer and returns the account label", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ name: "Jane" }));
    const who = await verifyToken(config);
    expect(who.name).toBe("Jane");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://inst.xano.io/api:meta/auth/me");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("throws an actionable error on a 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ message: "unauthorized" }, 401));
    await expect(verifyToken(config)).rejects.toThrow(/Token check failed \(401/);
  });

  it("treats a 2xx non-JSON body as a valid unlabeled session", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200, statusText: "OK" }));
    expect(await verifyToken(config)).toEqual({ name: undefined });
  });
});
