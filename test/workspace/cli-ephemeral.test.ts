import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/emit/cli.js";
import { encodeWorkspaceArchive } from "../../src/validate/archive.js";

const INSTANCE = "https://default.example.com";

function writeTokenFile(dir: string): string {
  const path = join(dir, ".xano", "auth.json");
  mkdirSync(join(dir, ".xano"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      access_token: "acc-cached",
      refresh_token: "ref-cached",
      expires_at: Date.now() + 3_600_000,
      scope: "offline_access workspace:write",
      instance: INSTANCE,
      auth_host: "https://app.xano.com",
      client_id: "dcr-abc",
    }),
  );
  return path;
}
function res(body: unknown, status = 200): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, statusText: status === 200 ? "OK" : "ERR" });
}
function seq(...responses: Response[]) {
  const m = vi.spyOn(globalThis, "fetch");
  for (const r of responses) m.mockResolvedValueOnce(r);
  return m;
}
const LIVE = { id: 7, name: "e4f2", display: "PR 1", xano_domain: "e4f2.xano.io", state: "ok", ephemeral_expires_at: "2999-01-01 00:00:00+0000" };
const EXPIRED = { ...LIVE, ephemeral_expires_at: "2000-01-01 00:00:00+0000" };
function statePath(dir: string) {
  return join(dir, ".xano", "ephemeral.json");
}
function writeState(dir: string, wsId: number, name: string) {
  mkdirSync(join(dir, ".xano"), { recursive: true });
  writeFileSync(statePath(dir), JSON.stringify({ version: 1, environments: { [String(wsId)]: { name, display: name, url: `https://${name}.xano.io`, expires_at: LIVE.ephemeral_expires_at } } }));
}

describe("sidestep ephemeral", () => {
  let dir: string;
  let authFile: string;
  let stdout: string[];
  let cwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidestep-ephcmd-"));
    authFile = writeTokenFile(dir);
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (stdout.push(String(c)), true));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    cwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── list ──
  it("list emits JSON of the workspace ephemerals (non-TTY)", async () => {
    const m = seq(res([LIVE]));
    await run(["ephemeral", "list", "--config", authFile, "--workspace", "114"]);
    expect(m.mock.calls[0]![0]).toBe(`${INSTANCE}/api:meta/workspace/114/ephemeral`);
    expect(JSON.parse(stdout.join(""))).toHaveLength(1);
  });
  it("list --global hits the global route", async () => {
    const m = seq(res([LIVE]));
    await run(["ephemeral", "list", "--config", authFile, "--global"]);
    expect(m.mock.calls[0]![0]).toBe(`${INSTANCE}/api:meta/ephemeral`);
  });
  it("list renders 'No ephemeral tenants found' on empty (TTY)", async () => {
    seq(res([]));
    const prev = process.stdout.isTTY;
    process.stdout.isTTY = true;
    try {
      await run(["ephemeral", "list", "--config", authFile, "--workspace", "114"]);
    } finally {
      process.stdout.isTTY = prev;
    }
    expect(stdout.join("")).toMatch(/No ephemeral tenants found/);
  });

  // ── get ──
  it("get projects the live tenant (non-TTY JSON)", async () => {
    seq(res(LIVE));
    await run(["ephemeral", "get", "e4f2", "--config", authFile, "--workspace", "114"]);
    expect(JSON.parse(stdout.join("")).url).toBe("https://e4f2.xano.io");
  });
  it("get on a 404 fails with the expired/gone message and makes no base-URL call", async () => {
    const m = seq(res("nope", 404));
    await expect(run(["ephemeral", "get", "gone", "--config", authFile, "--workspace", "114"])).rejects.toThrow(
      /expired or no longer exists/,
    );
    expect(m).toHaveBeenCalledTimes(1); // only the parent GET, never the env base URL
  });
  it("get on a past-expiry tenant is treated as gone", async () => {
    seq(res(EXPIRED));
    await expect(run(["ephemeral", "get", "e4f2", "--config", authFile, "--workspace", "114"])).rejects.toThrow(
      /expired or no longer exists/,
    );
  });
  it("get on a gone tenant clears a matching local record", async () => {
    writeState(dir, 114, "e4f2");
    seq(res("nope", 404));
    await expect(run(["ephemeral", "get", "e4f2", "--config", authFile, "--workspace", "114"])).rejects.toThrow(/cleared its local record/);
    expect(JSON.parse(readFileSync(statePath(dir), "utf8")).environments["114"]).toBeUndefined();
  });

  // ── delete ──
  it("delete --yes issues DELETE and clears a matching local record", async () => {
    writeState(dir, 114, "e4f2");
    const m = seq(res({}, 200));
    await run(["ephemeral", "delete", "e4f2", "--config", authFile, "--workspace", "114", "--yes"]);
    expect((m.mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
    expect(JSON.parse(readFileSync(statePath(dir), "utf8")).environments["114"]).toBeUndefined();
  });
  it("delete on an already-gone tenant is idempotent (no throw)", async () => {
    seq(res("nope", 404));
    await expect(run(["ephemeral", "delete", "gone", "--config", authFile, "--workspace", "114", "--yes"])).resolves.toBeUndefined();
  });

  // ── export ──
  it("export --format multidoc hits the tenant multidoc route after the existence gate", async () => {
    const m = seq(res(LIVE), res("api foo {}\n")); // GET tenant, then multidoc
    await run(["ephemeral", "export", "e4f2", "--config", authFile, "--workspace", "114", "--format", "multidoc", "--path", "-"]);
    expect(m.mock.calls[1]![0]).toBe(`${INSTANCE}/api:meta/workspace/114/tenant/e4f2/multidoc`);
    expect(stdout.join("")).toMatch(/api foo/);
  });
  it("export --format json decodes the env archive from workspace/1/export", async () => {
    const bundle = { app: "xano", type: "workspace", payload: { function: [] } };
    const m = seq(res(LIVE), new Response(Buffer.from(encodeWorkspaceArchive(JSON.stringify(bundle))), { status: 200 }));
    await run(["ephemeral", "export", "e4f2", "--config", authFile, "--workspace", "114", "--format", "json", "--path", "-"]);
    expect(m.mock.calls[1]![0]).toBe("https://e4f2.xano.io/api:meta/workspace/1/export");
    expect(JSON.parse(stdout.join(""))).toEqual(bundle);
  });
  it("export on a swept tenant fails with the gone message and no base-URL call", async () => {
    const m = seq(res("nope", 404));
    await expect(
      run(["ephemeral", "export", "gone", "--config", authFile, "--workspace", "114", "--format", "json", "--path", "-"]),
    ).rejects.toThrow(/expired or no longer exists/);
    expect(m).toHaveBeenCalledTimes(1);
  });
  it("export writes to a file when --path is a location", async () => {
    seq(res(LIVE), res("api foo {}\n"));
    const out = join(dir, "dump.xs");
    await run(["ephemeral", "export", "e4f2", "--config", authFile, "--workspace", "114", "--format", "multidoc", "--path", out]);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toMatch(/api foo/);
  });
});
