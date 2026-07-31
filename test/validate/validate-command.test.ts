import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, run } from "../../src/emit/cli.js";
import { buildWorkspaceArchive } from "./_helpers.js";

function archiveResponse(payload: Record<string, unknown>): Response {
  return new Response(buildWorkspaceArchive({ app: "xano", type: "workspace", payload }), { status: 200, statusText: "OK" });
}

/** The ephemeral env `validate` creates per run, as the API serializes it. */
const ENV_NAME = "sd68-jokr-1a2b";
const ENV_URL = "https://inst.xano.io/tenant/sd68-jokr-1a2b";
const ENV_ROW = {
  id: 12,
  name: ENV_NAME,
  display: "sidestep-validate",
  xano_domain: "inst.xano.io/tenant/sd68-jokr-1a2b",
  state: "ok",
  ephemeral_expires_at: "2030-01-01 00:00:00+0000",
};

describe("parseArgs — validate flags", () => {
  it("parses the file, --runtime, --capture, --instance", () => {
    const a = parseArgs(["validate", "app.ts", "--runtime", "--capture", "--instance", "https://x.xano.io"]);
    expect(a.command).toBe("validate");
    expect(a.file).toBe("app.ts");
    expect(a.runtime).toBe(true);
    expect(a.capture).toBe(true);
    expect(a.instance).toBe("https://x.xano.io");
  });

  it("accepts the --instance= joined form", () => {
    const a = parseArgs(["validate", "app.ts", "--instance=http://localhost:8080"]);
    expect(a.instance).toBe("http://localhost:8080");
  });

  it("rejects the removed --workspace flag in both forms, explaining why", () => {
    for (const argv of [["validate", "app.ts", "--workspace", "5"], ["validate", "app.ts", "--workspace=9"]]) {
      expect(() => parseArgs(argv)).toThrow(/`--workspace` was removed/);
      expect(() => parseArgs(argv)).toThrow(/credential/);
    }
  });

  it("still parses --all-workspaces, which selects nothing and must survive", () => {
    expect(parseArgs(["ephemeral", "list", "--all-workspaces"]).allWorkspaces).toBe(true);
  });

  it("defaults the validate flags to false/undefined for other commands", () => {
    const a = parseArgs(["export", "app.ts"]);
    expect(a.runtime).toBe(false);
    expect(a.capture).toBe(false);
    expect(a.verbose).toBe(false);
    expect(a.instance).toBeUndefined();
  });
});

function jsonOnce(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, statusText: status === 200 ? "OK" : "ERR" });
}

describe("run validate (end-to-end wiring via --bundle)", () => {
  const ENV = ["XANO_VALIDATE_INSTANCE", "XANO_VALIDATE_TOKEN"];
  let saved: Record<string, string | undefined>;
  let dir: string;
  let origCwd: string;
  let bundlePath: string;

  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env.XANO_VALIDATE_INSTANCE = "https://inst.xano.io";
    process.env.XANO_VALIDATE_TOKEN = "tok";
    origCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "sidestep-validate-cmd-"));
    process.chdir(dir);
    bundlePath = join(dir, "bundle.json");
    writeFileSync(bundlePath, JSON.stringify({ app: "xano", payload: { function: [{ name: "f", run: [] }] } }));
    process.exitCode = 0;
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = 0;
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("passes when the function round-trips (server keys stripped)", async () => {
    const m = vi.spyOn(globalThis, "fetch");
    m.mockResolvedValueOnce(jsonOnce({ name: "Me" })); // auth/me
    m.mockResolvedValueOnce(jsonOnce(ENV_ROW)); // create ephemeral
    m.mockResolvedValueOnce(jsonOnce(ENV_ROW)); // waitUntilReady
    m.mockResolvedValueOnce(jsonOnce({ workspace: { id: 1 } })); // import
    m.mockResolvedValueOnce(archiveResponse({ function: [{ name: "f", run: [], created_at: 1 }] })); // export
    m.mockResolvedValueOnce(jsonOnce({})); // dispose → delete ephemeral

    await run(["validate", "--bundle", bundlePath]);
    expect(process.exitCode).not.toBe(2);
    // auth/me first, then a fresh env, then the archive import INTO that env —
    // never the retired JSON bundle route, and never the parent instance.
    expect(String(m.mock.calls[0]![0])).toContain("/api:meta/auth/me");
    expect(String(m.mock.calls[1]![0])).toBe("https://inst.xano.io/api:meta/workspace/1/ephemeral");
    expect(String(m.mock.calls[3]![0])).toBe(`${ENV_URL}/api:meta/workspace/1/import`);
    // Regression guard: the env is always torn down.
    const del = m.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "DELETE",
    );
    expect(String(del?.[0])).toBe(`https://inst.xano.io/api:meta/workspace/1/tenant/${ENV_NAME}`);
  });

  it("exits non-zero on a round-trip divergence", async () => {
    const m = vi.spyOn(globalThis, "fetch");
    m.mockResolvedValueOnce(jsonOnce({ name: "Me" }));
    m.mockResolvedValueOnce(jsonOnce(ENV_ROW)); // create ephemeral
    m.mockResolvedValueOnce(jsonOnce(ENV_ROW)); // waitUntilReady
    m.mockResolvedValueOnce(jsonOnce({ workspace: { id: 1 } }));
    m.mockResolvedValueOnce(archiveResponse({ function: [{ name: "f", run: [{ name: "x2" }] }] })); // diverges

    await run(["validate", "--bundle", bundlePath]);
    expect(process.exitCode).toBe(2);
  });

  it("exits non-zero when the engine rejects the import", async () => {
    const m = vi.spyOn(globalThis, "fetch");
    m.mockResolvedValueOnce(jsonOnce({ name: "Me" }));
    m.mockResolvedValueOnce(new Response("bad field", { status: 422, statusText: "ERR" })); // import rejected

    await run(["validate", "--bundle", bundlePath]);
    expect(process.exitCode).toBe(2);
  });
});
