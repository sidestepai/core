import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/emit/cli.js";

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

function bundleFile(dir: string, name = "bundle.json"): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({ app: "xano", type: "workspace", payload: { workspace: [{ name: "example" }] } }));
  return p;
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

const EPH = { id: 7, name: "e4f2-9ab1", display: "example", xano_domain: "e4f2-9ab1.xano.io", state: "ok", ephemeral_expires_at: "2999-01-01 00:00:00+0000" };
function statePath(dir: string): string {
  return join(dir, ".xano", "ephemeral.json");
}
function writeState(dir: string, wsId: number, rec: Record<string, unknown>): void {
  mkdirSync(join(dir, ".xano"), { recursive: true });
  writeFileSync(statePath(dir), JSON.stringify({ version: 1, environments: { [String(wsId)]: rec } }));
}

describe("sidestep deploy", () => {
  let dir: string;
  let authFile: string;
  let stdout: string[];
  let stderr: string[];
  let cwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidestep-dep-"));
    authFile = writeTokenFile(dir);
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (stdout.push(String(c)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((c) => (stderr.push(String(c)), true));
    cwd = process.cwd();
    process.chdir(dir); // ephemeral state writes under process.cwd()
  });
  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── ephemeral (default dest) ──────────────────────────────────────────────

  it("defaults to --dest ephemeral and creates when no state is tracked", async () => {
    const m = seq(
      res(EPH), // create
      res(EPH), // waitUntilReady GET → ok
      res({ id: 1 }), // import
    );
    await run(["deploy", "--bundle", bundleFile(dir), "--config", authFile, "--workspace", "114"]);

    expect(m.mock.calls[0]![0]).toBe(`${INSTANCE}/api:meta/workspace/114/ephemeral`);
    expect((m.mock.calls[0]![1] as RequestInit).method).toBe("POST");
    // import hits the ENV base URL workspace/1/import
    expect(m.mock.calls[2]![0]).toBe("https://e4f2-9ab1.xano.io/api:meta/workspace/1/import");

    // state persisted for the parent workspace
    const state = JSON.parse(readFileSync(statePath(dir), "utf8"));
    expect(state.environments["114"].name).toBe("e4f2-9ab1");
    expect(state.environments["114"].url).toBe("https://e4f2-9ab1.xano.io");

    // non-TTY machine summary
    const out = JSON.parse(stdout.join(""));
    expect(out).toMatchObject({ dest: "ephemeral", url: "https://e4f2-9ab1.xano.io", created: true });
    expect(stderr.join("")).toMatch(/New ephemeral URL/);
  });

  it("refreshes an existing live ephemeral (URL unchanged, no create)", async () => {
    writeState(dir, 114, { name: "e4f2-9ab1", display: "example", url: "https://e4f2-9ab1.xano.io", expires_at: EPH.ephemeral_expires_at });
    const m = seq(
      res(EPH), // GET existing → alive
      res({ id: 1 }), // import
    );
    await run(["deploy", "--bundle", bundleFile(dir), "--config", authFile, "--workspace", "114"]);

    // no create call — first call is the GET, second the import
    expect(m.mock.calls[0]![0]).toBe(`${INSTANCE}/api:meta/workspace/114/tenant/e4f2-9ab1`);
    expect(m.mock.calls[1]![0]).toBe("https://e4f2-9ab1.xano.io/api:meta/workspace/1/import");
    expect(m).toHaveBeenCalledTimes(2);
    expect(stderr.join("")).toMatch(/Refreshed e4f2-9ab1 \(URL unchanged\)/);
    expect(JSON.parse(stdout.join("")).created).toBe(false);
  });

  it("recreates when the tracked ephemeral has expired, calling out the URL change", async () => {
    writeState(dir, 114, { name: "old-name", display: "example", url: "https://old-name.xano.io", expires_at: "2000-01-01 00:00:00+0000" });
    const fresh = { ...EPH, name: "new-9ab1", xano_domain: "new-9ab1.xano.io" };
    const m = seq(
      res({ ...EPH, name: "old-name", ephemeral_expires_at: "2000-01-01 00:00:00+0000" }), // GET → expired
      res(fresh), // create
      res(fresh), // waitUntilReady → ok
      res({ id: 1 }), // import
    );
    await run(["deploy", "--bundle", bundleFile(dir), "--config", authFile, "--workspace", "114"]);

    expect(m.mock.calls[1]![0]).toBe(`${INSTANCE}/api:meta/workspace/114/ephemeral`); // create
    expect(m.mock.calls[3]![0]).toBe("https://new-9ab1.xano.io/api:meta/workspace/1/import");
    expect(stderr.join("")).toMatch(/New ephemeral URL/);
    expect(JSON.parse(readFileSync(statePath(dir), "utf8")).environments["114"].name).toBe("new-9ab1");
  });

  it("recreates when the tracked ephemeral 404s (swept)", async () => {
    writeState(dir, 114, { name: "gone", display: "example", url: "https://gone.xano.io", expires_at: EPH.ephemeral_expires_at });
    const m = seq(
      res("not found", 404), // GET → gone
      res(EPH), // create
      res(EPH), // ready
      res({ id: 1 }), // import
    );
    await run(["deploy", "--bundle", bundleFile(dir), "--config", authFile, "--workspace", "114"]);
    expect(m.mock.calls[1]![0]).toBe(`${INSTANCE}/api:meta/workspace/114/ephemeral`);
    expect(JSON.parse(stdout.join("")).created).toBe(true);
  });

  it("forwards --name and --expires-hours to create", async () => {
    const m = seq(res(EPH), res(EPH), res({ id: 1 }));
    await run(["deploy", "--bundle", bundleFile(dir), "--config", authFile, "--workspace", "114", "--name", "PR 123", "--expires-hours", "24"]);
    const body = JSON.parse((m.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({ display: "PR 123", expires_hours: 24 });
  });

  it("rejects an invalid --dest at parse time", async () => {
    await expect(run(["deploy", bundleFile(dir), "--config", authFile, "--dest", "bogus"])).rejects.toThrow(/--dest must be/);
  });

  // ── sandbox dest ──────────────────────────────────────────────────────────

  it("--dest sandbox resolves sandbox/me and imports to the sandbox base URL", async () => {
    const m = seq(
      res({ name: "sbx", xano_domain: "sbx.dev.xano.io" }), // sandbox/me
      res({ id: 1 }), // import
    );
    await run(["deploy", "--dest", "sandbox", "--bundle", bundleFile(dir), "--config", authFile]);

    expect(m.mock.calls[0]![0]).toBe(`${INSTANCE}/api:meta/sandbox/me`);
    expect(m.mock.calls[1]![0]).toBe("https://sbx.dev.xano.io/api:meta/workspace/1/import");
    expect(existsSync(statePath(dir))).toBe(false); // no local state for sandbox
    expect(JSON.parse(stdout.join(""))).toMatchObject({ dest: "sandbox", url: "https://sbx.dev.xano.io" });
  });

  // ── removed surfaces ──────────────────────────────────────────────────────

  it("`sandbox deploy` points at `deploy --dest sandbox`", async () => {
    await expect(run(["sandbox", "deploy", bundleFile(dir)])).rejects.toThrow(/deploy --dest sandbox/);
  });
  it("`push` and `workspace deploy` point at `deploy`", async () => {
    await expect(run(["push"])).rejects.toThrow(/use `sidestep deploy`/);
    await expect(run(["workspace", "deploy"])).rejects.toThrow(/use `sidestep deploy`/);
  });
});
