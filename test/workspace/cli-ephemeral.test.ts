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
      type: "oauth",
      access_token: "acc-cached",
      refresh_token: "ref-cached",
      expires_at: Date.now() + 3_600_000,
      scope: "offline_access workspace:write",
      instance: INSTANCE,
      workspace_id: 114,
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
    process.env.XANO_NO_BROWSER = "1"; // never spawn a browser under test
  });
  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.XANO_NO_BROWSER;
  });

  // ── list ──
  it("list emits JSON of the workspace ephemerals (non-TTY)", async () => {
    const m = seq(res([LIVE]));
    await run(["ephemeral", "list", "--config", authFile]);
    expect(m.mock.calls[0]![0]).toBe(`${INSTANCE}/api:meta/workspace/114/ephemeral`);
    expect(JSON.parse(stdout.join(""))).toHaveLength(1);
  });
  it("list --all-workspaces hits the cross-workspace route", async () => {
    const m = seq(res([LIVE]));
    await run(["ephemeral", "list", "--config", authFile, "--all-workspaces"]);
    expect(m.mock.calls[0]![0]).toBe(`${INSTANCE}/api:meta/ephemeral`);
  });
  it("list uses the credential's pinned workspace and never looks it up (nor hard-codes 1)", async () => {
    const m = seq(res([LIVE]));
    await run(["ephemeral", "list", "--config", authFile]);
    expect(m.mock.calls[0]![0]).toBe(`${INSTANCE}/api:meta/workspace/114/ephemeral`);
    expect(m.mock.calls.map((c) => String(c[0]))).not.toContain(`${INSTANCE}/api:meta/auth/me`);
  });
  it("list renders 'No ephemeral tenants found' on empty (TTY)", async () => {
    seq(res([]));
    const prev = process.stdout.isTTY;
    process.stdout.isTTY = true;
    try {
      await run(["ephemeral", "list", "--config", authFile]);
    } finally {
      process.stdout.isTTY = prev;
    }
    expect(stdout.join("")).toMatch(/No ephemeral tenants found/);
  });

  // ── get ──
  it("get projects the live tenant (non-TTY JSON)", async () => {
    seq(res(LIVE));
    await run(["ephemeral", "get", "e4f2", "--config", authFile]);
    expect(JSON.parse(stdout.join("")).url).toBe("https://e4f2.xano.io");
  });
  it("get goes straight to the pinned workspace, with no resolution round-trip", async () => {
    const m = seq(res(LIVE));
    await run(["ephemeral", "get", "e4f2", "--config", authFile]);
    expect(m.mock.calls[0]![0]).toBe(`${INSTANCE}/api:meta/workspace/114/tenant/e4f2`);
    expect(m.mock.calls).toHaveLength(1);
  });

  it("drives a real command off a hand-authored meta API token credential", async () => {
    // End-to-end proof of the second credential arm: no login, no refresh, just
    // the file → the right route with the right bearer and workspace.
    const tokenFile = join(dir, "token-auth.json");
    writeFileSync(
      tokenFile,
      JSON.stringify({
        type: "token",
        instance_base_url: INSTANCE,
        workspace_id: 300,
        meta_api_token: "meta-tok",
      }),
    );
    const m = seq(res([LIVE]));
    await run(["ephemeral", "list", "--config", tokenFile]);

    expect(m.mock.calls[0]![0]).toBe(`${INSTANCE}/api:meta/workspace/300/ephemeral`);
    const headers = m.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer meta-tok");
  });

  it("rejects the removed --workspace flag rather than acting on a different workspace", async () => {
    await expect(run(["ephemeral", "list", "--config", authFile, "--workspace", "9"])).rejects.toThrow(
      /`--workspace` was removed/,
    );
  });
  it("get on a 404 fails with the expired/gone message and makes no base-URL call", async () => {
    const m = seq(res("nope", 404));
    await expect(run(["ephemeral", "get", "gone", "--config", authFile])).rejects.toThrow(
      /expired or no longer exists/,
    );
    expect(m).toHaveBeenCalledTimes(1); // only the parent GET, never the env base URL
  });
  it("get on a past-expiry tenant is treated as gone", async () => {
    seq(res(EXPIRED));
    await expect(run(["ephemeral", "get", "e4f2", "--config", authFile])).rejects.toThrow(
      /expired or no longer exists/,
    );
  });
  it("get on a gone tenant clears a matching local record", async () => {
    writeState(dir, 114, "e4f2");
    seq(res("nope", 404));
    await expect(run(["ephemeral", "get", "e4f2", "--config", authFile])).rejects.toThrow(/cleared its local record/);
    expect(JSON.parse(readFileSync(statePath(dir), "utf8")).environments["114"]).toBeUndefined();
  });

  // ── delete ──
  it("delete --yes issues DELETE and clears a matching local record", async () => {
    writeState(dir, 114, "e4f2");
    const m = seq(res({}, 200));
    await run(["ephemeral", "delete", "e4f2", "--config", authFile, "--yes"]);
    expect((m.mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
    expect(JSON.parse(readFileSync(statePath(dir), "utf8")).environments["114"]).toBeUndefined();
  });
  it("delete on an already-gone tenant is idempotent (no throw)", async () => {
    seq(res("nope", 404));
    await expect(run(["ephemeral", "delete", "gone", "--config", authFile, "--yes"])).resolves.toBeUndefined();
  });

  // ── export ──
  it("export --format multidoc hits the tenant multidoc route after the existence gate", async () => {
    const m = seq(res(LIVE), res("api foo {}\n")); // GET tenant, then multidoc
    await run(["ephemeral", "export", "e4f2", "--config", authFile, "--format", "multidoc", "--path", "-"]);
    expect(m.mock.calls[1]![0]).toBe(`${INSTANCE}/api:meta/workspace/114/tenant/e4f2/multidoc`);
    expect(stdout.join("")).toMatch(/api foo/);
  });
  it("export --format json decodes the env archive from workspace/1/export", async () => {
    const bundle = { app: "xano", type: "workspace", payload: { function: [] } };
    const m = seq(res(LIVE), new Response(Buffer.from(encodeWorkspaceArchive(JSON.stringify(bundle))), { status: 200 }));
    await run(["ephemeral", "export", "e4f2", "--config", authFile, "--format", "json", "--path", "-"]);
    expect(m.mock.calls[1]![0]).toBe("https://e4f2.xano.io/api:meta/workspace/1/export");
    expect(JSON.parse(stdout.join(""))).toEqual(bundle);
  });
  it("export on a swept tenant fails with the gone message and no base-URL call", async () => {
    const m = seq(res("nope", 404));
    await expect(
      run(["ephemeral", "export", "gone", "--config", authFile, "--format", "json", "--path", "-"]),
    ).rejects.toThrow(/expired or no longer exists/);
    expect(m).toHaveBeenCalledTimes(1);
  });
  it("export writes to a file when --path is a location", async () => {
    seq(res(LIVE), res("api foo {}\n"));
    const out = join(dir, "dump.xs");
    await run(["ephemeral", "export", "e4f2", "--config", authFile, "--format", "multidoc", "--path", out]);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toMatch(/api foo/);
  });

  // ── impersonate ──
  it("impersonate emits JSON with the token and dashboard URL (non-TTY)", async () => {
    const m = seq(res(LIVE), res({ _ti: "tok" })); // GET tenant (gate), then mint
    await run(["ephemeral", "impersonate", "e4f2", "--config", authFile]);
    expect(m.mock.calls[1]![0]).toBe(`${INSTANCE}/api:meta/workspace/114/tenant/e4f2/impersonate`);
    expect(JSON.parse(stdout.join(""))).toEqual({ _ti: "tok", url: `${INSTANCE}/impersonate?_ti=tok` });
  });
  it("impersonate --url-only prints just the URL and opens no browser (TTY)", async () => {
    seq(res(LIVE), res({ _ti: "tok" }));
    const prev = process.stdout.isTTY;
    process.stdout.isTTY = true;
    try {
      await run(["ephemeral", "impersonate", "e4f2", "--config", authFile, "--url-only"]);
    } finally {
      process.stdout.isTTY = prev;
    }
    expect(stdout.join("").trim()).toBe(`${INSTANCE}/impersonate?_ti=tok`);
  });
  it("impersonate in a TTY opens the browser and writes nothing to stdout", async () => {
    seq(res(LIVE), res({ _ti: "tok" }));
    const prev = process.stdout.isTTY;
    process.stdout.isTTY = true;
    try {
      await run(["ephemeral", "impersonate", "e4f2", "--config", authFile]);
    } finally {
      process.stdout.isTTY = prev;
    }
    expect(stdout.join("")).toBe(""); // URL/status go to stderr; stdout stays clean
  });
  it("impersonate --guest requests a read-only session", async () => {
    const m = seq(res(LIVE), res({ _ti: "tok" }));
    await run(["ephemeral", "impersonate", "e4f2", "--config", authFile, "--guest"]);
    expect(String(m.mock.calls[1]![0])).toContain("guest_read_only=true");
  });
  it("impersonate on a swept tenant fails with the gone message and never mints", async () => {
    const m = seq(res("nope", 404));
    await expect(run(["ephemeral", "impersonate", "gone", "--config", authFile])).rejects.toThrow(
      /expired or no longer exists/,
    );
    expect(m).toHaveBeenCalledTimes(1); // only the gate GET, never the impersonate route
  });
  it("impersonate on a gone tenant clears a matching local record", async () => {
    writeState(dir, 114, "e4f2");
    seq(res("nope", 404));
    await expect(run(["ephemeral", "impersonate", "e4f2", "--config", authFile])).rejects.toThrow(
      /cleared its local record/,
    );
    expect(JSON.parse(readFileSync(statePath(dir), "utf8")).environments["114"]).toBeUndefined();
  });
  it("impersonate without a name fails with an actionable message", async () => {
    await expect(run(["ephemeral", "impersonate", "--config", authFile])).rejects.toThrow(
      /needs a tenant name/,
    );
  });
});
