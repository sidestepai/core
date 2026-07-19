import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/emit/cli.js";

const INSTANCE = "https://inst.example.com";

const ME_BODY = '{"id":9,"name":"Ada","email":"ada@example.com","workspace":{"id":42,"name":"my-app"}}';

function writeTokenFile(dir: string): string {
  const path = join(dir, ".xano", "auth.json");
  mkdirSync(join(dir, ".xano"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      access_token: "acc-cached",
      refresh_token: "ref-cached",
      expires_at: Date.now() + 3_600_000,
      scope: "workspace:write",
      instance: INSTANCE,
      auth_host: "https://app.xano.com",
      client_id: "dcr-abc",
    }),
  );
  return path;
}

interface RouteHandlers {
  me?: string;
  deploy?: () => Response;
  staticBuild?: () => Response;
}

function routeFetch(h: RouteHandlers = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const u = String(input);
    if (u.includes("/auth/me")) return new Response(h.me ?? ME_BODY, { status: 200 });
    if (u.includes("/workspace/deploy")) {
      return h.deploy ? h.deploy() : new Response('{"base_url":"https://inst/w","workspace":{"id":42,"name":"my-app"}}', { status: 200 });
    }
    if (u.includes("/static_host/")) {
      return h.staticBuild ? h.staticBuild() : new Response('{"url":"https://my-app.dev.site"}', { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
}

function bundleFile(dir: string): string {
  const p = join(dir, "b.json");
  writeFileSync(p, JSON.stringify({ app: "xano", payload: {} }));
  return p;
}

function deployUrl(fetchMock: ReturnType<typeof routeFetch>): string {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/workspace/deploy"))!;
  return String(call[0]);
}

describe("sidestep workspace deploy", () => {
  let dir: string;
  let authFile: string;
  let lockPath: string;
  let stdout: string[];
  let stderr: string[];
  let priorExit: typeof process.exitCode;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidestep-ws-"));
    authFile = writeTokenFile(dir);
    lockPath = join(dir, "xano.lock");
    stdout = [];
    stderr = [];
    priorExit = process.exitCode;
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      stdout.push(typeof c === "string" ? c : c.toString());
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      stderr.push(typeof c === "string" ? c : c.toString());
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = priorExit;
  });

  it("resolves + displays the target workspace, then POSTs the bundle to /api:meta/workspace/deploy", async () => {
    const fetchMock = routeFetch();
    await run(["workspace", "deploy", "--bundle", bundleFile(dir), "--config", authFile]);

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/workspace/deploy"))!;
    expect(String(call[0])).toBe(`${INSTANCE}/api:meta/workspace/deploy`);
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ app: "xano", payload: {} });
    expect(stderr.join("")).toMatch(/workspace "my-app" \(id 42\)/);
  });

  it("reconciles the server lock into the local xano.lock (server wins, local-only preserved)", async () => {
    writeFileSync(lockPath, JSON.stringify({ version: 1, objects: { "dbo:users": { guid: "g-old" }, "dbo:local": { guid: "g-local" } } }));
    routeFetch({
      deploy: () => new Response('{"base_url":"https://inst/w","workspace":{"id":42},"lock":{"version":1,"objects":{"dbo:users":{"guid":"g-server"}}}}', { status: 200 }),
    });

    await run(["workspace", "deploy", "--bundle", bundleFile(dir), "--config", authFile, `--lock=${lockPath}`]);

    const saved = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(saved.objects["dbo:users"]).toEqual({ guid: "g-server" }); // server wins
    expect(saved.objects["dbo:local"]).toEqual({ guid: "g-local" }); // local-only preserved
  });

  it("--reset without confirmation aborts before any deploy POST (non-interactive)", async () => {
    const fetchMock = routeFetch();
    await expect(
      run(["workspace", "deploy", "--bundle", bundleFile(dir), "--config", authFile, "--reset"]),
    ).rejects.toThrow(/--reset needs confirmation/);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/workspace/deploy"))).toBe(false);
  });

  it("--reset --confirm-workspace matching the resolved name proceeds with ?mode=reset and the server-enforced confirm_workspace", async () => {
    const fetchMock = routeFetch();
    await run(["workspace", "deploy", "--bundle", bundleFile(dir), "--config", authFile, "--reset", "--confirm-workspace=my-app"]);
    expect(deployUrl(fetchMock)).toBe(`${INSTANCE}/api:meta/workspace/deploy?mode=reset&confirm_workspace=my-app`);
  });

  it("--reset --confirm-workspace with a wrong name aborts", async () => {
    routeFetch();
    await expect(
      run(["workspace", "deploy", "--bundle", bundleFile(dir), "--config", authFile, "--reset", "--confirm-workspace=wrong"]),
    ).rejects.toThrow(/does not match the target workspace "my-app"/);
  });

  it("a workspace-key mismatch refuses to update the lock (distinct exit code); --adopt-workspace rebinds it", async () => {
    writeFileSync(lockPath, JSON.stringify({ version: 1, objects: { workspace: { canonical: "wc-local" } } }));
    const serverLock = '{"base_url":"https://inst/w","workspace":{"id":42},"lock":{"version":1,"objects":{"workspace":{"canonical":"wc-server"}}}}';
    routeFetch({ deploy: () => new Response(serverLock, { status: 200 }) });

    await run(["workspace", "deploy", "--bundle", bundleFile(dir), "--config", authFile, `--lock=${lockPath}`]);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).objects.workspace.canonical).toBe("wc-local"); // NOT updated
    expect(stderr.join("")).toMatch(/differs from the server's/);
    expect(process.exitCode).toBe(2);
    process.exitCode = priorExit;

    routeFetch({ deploy: () => new Response(serverLock, { status: 200 }) });
    await run(["workspace", "deploy", "--bundle", bundleFile(dir), "--config", authFile, `--lock=${lockPath}`, "--adopt-workspace"]);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).objects.workspace.canonical).toBe("wc-server"); // rebound
  });

  it("surfaces canonical_changes as a warning", async () => {
    routeFetch({
      deploy: () => new Response('{"base_url":"https://inst/w","workspace":{"id":42},"canonical_changes":["app:api"]}', { status: 200 }),
    });
    await run(["workspace", "deploy", "--bundle", bundleFile(dir), "--config", authFile]);
    expect(stderr.join("")).toMatch(/1 public URL\(s\) changed.*app:api/);
  });

  it("--static uploads to the static-host build endpoint with the resolved numeric workspace id", async () => {
    mkdirSync(join(dir, "site"));
    writeFileSync(join(dir, "site", "index.html"), "<h1>hi</h1>");
    const fetchMock = routeFetch();
    await run(["workspace", "deploy", "--bundle", bundleFile(dir), "--config", authFile, "--static", join(dir, "site")]);
    const build = fetchMock.mock.calls.find((c) => String(c[0]).includes("/static_host/"))!;
    expect(String(build[0])).toBe(`${INSTANCE}/api:meta/workspace/42/static_host/default/build`);
    expect((build[1] as RequestInit).body).toBeInstanceOf(FormData);
  });

  it("--static failure after a committed deploy exits with a distinct code and a resumable message", async () => {
    writeFileSync(lockPath, JSON.stringify({ version: 1, objects: {} }));
    mkdirSync(join(dir, "site"));
    writeFileSync(join(dir, "site", "index.html"), "<h1>hi</h1>");
    routeFetch({
      deploy: () => new Response('{"base_url":"https://inst/w","workspace":{"id":42},"lock":{"version":1,"objects":{"dbo:u":{"guid":"g"}}}}', { status: 200 }),
      staticBuild: () => new Response("nope", { status: 500, statusText: "ERR" }),
    });

    await run(["workspace", "deploy", "--bundle", bundleFile(dir), "--config", authFile, `--lock=${lockPath}`, "--static", join(dir, "site")]);

    expect(process.exitCode).toBe(3);
    expect(stderr.join("")).toMatch(/static-host upload failed/);
    expect(stderr.join("")).toMatch(/Re-run .*--static/);
    // Lock was still reconciled before the static step.
    expect(JSON.parse(readFileSync(lockPath, "utf8")).objects["dbo:u"]).toEqual({ guid: "g" });
    process.exitCode = priorExit;
  });

  it("writes a fresh xano.lock from the server response on a first deploy with no local lock", async () => {
    routeFetch({
      deploy: () => new Response('{"base_url":"https://inst/w","workspace":{"id":42},"lock":{"version":1,"objects":{"dbo:u":{"guid":"g"}}}}', { status: 200 }),
    });
    expect(existsSync(lockPath)).toBe(false);
    await run(["workspace", "deploy", "--bundle", bundleFile(dir), "--config", authFile, `--lock=${lockPath}`]);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).objects["dbo:u"]).toEqual({ guid: "g" });
  });
});
