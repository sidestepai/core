import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, rmSync, mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, run } from "../../src/emit/cli.js";
import {
  resolveOutputTarget,
  fetchSandboxMultidoc,
  runSandboxExportCommand,
} from "../../src/emit/sandbox-export-command.js";

const INSTANCE = "https://inst.example.com";
const MULTIDOC = "workspace {\n  name = \"app\"\n}\n"; // a tiny stand-in for the .xs body

/** The sandbox tenant sandbox/me returns; no xano_domain → base = <instance>/tenant/<name>. */
const TENANT = { name: "tc-1" };
/** The packageExport bundle the workspace-export archive decodes to. */
const BUNDLE_OBJ = { app: "xano", version: "1.03", type: "workspace", payload: { workspace: { name: "app" } } };

/** Build a gzipped ustar archive holding a single workspace.json (mirrors decodeWorkspaceArchive's reader). */
function makeWorkspaceArchive(obj: unknown): Uint8Array {
  const content = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(512);
  header.write("workspace.json", 0, "utf8"); // name @0..100
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, "utf8"); // octal size @124..136
  const data = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(data);
  return gzipSync(Buffer.concat([header, data, Buffer.alloc(512)])); // trailing zero block ends the tar
}

/** Route the json-export call chain: sandbox/me → workspace list → workspace/{id}/export archive. */
function mockSandboxJsonFetch(opts: { workspaces?: Array<{ id: number; name?: string }>; bundle?: unknown } = {}) {
  const workspaces = opts.workspaces ?? [{ id: 1, name: "tc-1" }];
  const bundle = opts.bundle ?? BUNDLE_OBJ;
  return vi.spyOn(globalThis, "fetch").mockImplementation((input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith("/api:meta/sandbox/me")) return Promise.resolve(new Response(JSON.stringify(TENANT), { status: 200 }));
    if (url.endsWith("/api:meta/workspace")) return Promise.resolve(new Response(JSON.stringify(workspaces), { status: 200 }));
    if (/\/api:meta\/workspace\/\d+\/export$/.test(url)) return Promise.resolve(new Response(makeWorkspaceArchive(bundle), { status: 200 }));
    throw new Error(`unexpected fetch: ${url}`);
  });
}

/** Write an unexpired token cache so getAccessToken returns without discovery/refresh. */
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
      scope: "workspace:read",
      instance: INSTANCE,
      workspace_id: 42,
      auth_host: "https://app.xano.com",
      client_id: "dcr-abc",
    }),
  );
  return path;
}

// ---------------------------------------------------------------------------

describe("resolveOutputTarget", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidestep-export-target-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("routes `-` to stdout regardless of name/ext", () => {
    expect(resolveOutputTarget({ path: "-", name: "whatever", ext: "json" })).toEqual({ kind: "stdout" });
    expect(resolveOutputTarget({ path: "-", ext: "xs" })).toEqual({ kind: "stdout" });
  });

  it("defaults to ./sandbox.<ext> when no path is given", () => {
    expect(resolveOutputTarget({ ext: "json" })).toEqual({ kind: "file", path: resolve("sandbox.json") });
    expect(resolveOutputTarget({ ext: "xs" })).toEqual({ kind: "file", path: resolve("sandbox.xs") });
  });

  it("honors --name for the default basename", () => {
    expect(resolveOutputTarget({ name: "prod", ext: "xs" })).toEqual({ kind: "file", path: resolve("prod.xs") });
  });

  it("joins the basename when path is an existing directory", () => {
    expect(resolveOutputTarget({ path: dir, ext: "json" })).toEqual({ kind: "file", path: resolve(join(dir, "sandbox.json")) });
    expect(resolveOutputTarget({ path: dir, name: "ws", ext: "json" })).toEqual({
      kind: "file",
      path: resolve(join(dir, "ws.json")),
    });
  });

  it("joins the basename when path ends in a separator (even if non-existent)", () => {
    expect(resolveOutputTarget({ path: "out/", ext: "xs" })).toEqual({ kind: "file", path: resolve("out/sandbox.xs") });
  });

  it("treats a full file path as a verbatim target and ignores --name", () => {
    expect(resolveOutputTarget({ path: "artifacts/ws.json", name: "ignored", ext: "json" })).toEqual({
      kind: "file",
      path: resolve("artifacts/ws.json"),
    });
  });
});

// ---------------------------------------------------------------------------

describe("fetchSandboxMultidoc", () => {
  afterEach(() => vi.restoreAllMocks());

  const auth = { access_token: "acc-1", instance: INSTANCE, workspaceId: 5, credentialType: "oauth" as const };

  it("GETs /api:meta/sandbox/multidoc with a bearer token and no query params, returning the raw body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(MULTIDOC, { status: 200 }));
    const out = await fetchSandboxMultidoc(auth);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${INSTANCE}/api:meta/sandbox/multidoc`);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer acc-1");
    expect(out).toBe(MULTIDOC);
  });

  it("surfaces a non-2xx response as an error with status and body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upgrade your plan", { status: 402, statusText: "Payment Required" }),
    );
    await expect(fetchSandboxMultidoc(auth)).rejects.toThrow(/multidoc\) failed \(402.*upgrade your plan/s);
  });

  it("round-trips a large body unchanged", async () => {
    const big = "x = 1\n".repeat(500_000);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(big, { status: 200 }));
    expect(await fetchSandboxMultidoc(auth)).toBe(big);
  });
});

// ---------------------------------------------------------------------------

describe("sidestep sandbox export", () => {
  let dir: string;
  let stdout: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidestep-sandbox-export-"));
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      stdout.push(typeof c === "string" ? c : c.toString());
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("json (the default) exports the DEPLOYED sandbox workspace as a bundle", async () => {
    const authFile = writeTokenFile(dir);
    const fetchMock = mockSandboxJsonFetch();
    await runSandboxExportCommand(parseArgs(["sandbox", "export", "--config", authFile, "--path", join(dir, "ws.json")]));

    expect(readFileSync(join(dir, "ws.json"), "utf8")).toBe(JSON.stringify(BUNDLE_OBJ, null, 2) + "\n");
    // The chain hit sandbox/me → workspace list → workspace/{id}/export, all bearer-authed.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/api:meta/sandbox/me"))).toBe(true);
    expect(urls.some((u) => /\/api:meta\/workspace\/1\/export$/.test(u))).toBe(true);
  });

  it("json asks the sandbox to skip table rows — nothing on the read side consumes them", async () => {
    const authFile = writeTokenFile(dir);
    const fetchMock = mockSandboxJsonFetch();
    await runSandboxExportCommand(parseArgs(["sandbox", "export", "--config", authFile, "--path", join(dir, "ws.json")]));

    const exportCall = fetchMock.mock.calls.find((c) => /\/workspace\/1\/export$/.test(String(c[0])))!;
    const body = JSON.parse(String((exportCall[1] as RequestInit).body)) as { records: boolean };
    expect(body.records).toBe(false);
  });

  it("json defaults to ./sandbox.json in the cwd when --path is omitted", async () => {
    const authFile = writeTokenFile(dir);
    mockSandboxJsonFetch();
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      await runSandboxExportCommand(parseArgs(["sandbox", "export", "--config", authFile]));
      expect(existsSync(join(dir, "sandbox.json"))).toBe(true);
    } finally {
      cwd.mockRestore();
    }
  });

  it("json --path - streams the bundle to stdout", async () => {
    const authFile = writeTokenFile(dir);
    mockSandboxJsonFetch();
    await runSandboxExportCommand(parseArgs(["sandbox", "export", "--format", "json", "--config", authFile, "--path", "-"]));
    expect(stdout.join("")).toBe(JSON.stringify(BUNDLE_OBJ, null, 2) + "\n");
  });

  it("json errors with guidance when the sandbox has no workspace yet", async () => {
    const authFile = writeTokenFile(dir);
    mockSandboxJsonFetch({ workspaces: [] });
    await expect(
      runSandboxExportCommand(parseArgs(["sandbox", "export", "--config", authFile, "--path", "-"])),
    ).rejects.toThrow(/no workspace to export yet.*deploy --dest sandbox/is);
  });

  it("multidoc writes the fetched .xs body to --name", async () => {
    const authFile = writeTokenFile(dir);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(MULTIDOC, { status: 200 }));
    await runSandboxExportCommand(
      parseArgs(["sandbox", "export", "--format", "multidoc", "--config", authFile, "--path", dir, "--name", "docs"]),
    );
    expect(readFileSync(join(dir, "docs.xs"), "utf8")).toBe(MULTIDOC + "\n");
  });

  it("multidoc --path - prints the .xs body to stdout", async () => {
    const authFile = writeTokenFile(dir);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(MULTIDOC, { status: 200 }));
    await runSandboxExportCommand(
      parseArgs(["sandbox", "export", "--format", "multidoc", "--config", authFile, "--path", "-"]),
    );
    expect(stdout.join("")).toBe(MULTIDOC + "\n");
  });

  it("rejects a local input file — export always reads the deployed sandbox", async () => {
    const authFile = writeTokenFile(dir);
    await expect(
      runSandboxExportCommand(parseArgs(["sandbox", "export", "some/index.ts", "--config", authFile])),
    ).rejects.toThrow(/takes no input.*sidestep export/is);
    await expect(
      runSandboxExportCommand(parseArgs(["sandbox", "export", "--bundle", "pre.json", "--config", authFile])),
    ).rejects.toThrow(/takes no input/i);
  });
});

// ---------------------------------------------------------------------------

describe("parseArgs / CLI dispatch for sandbox export", () => {
  let stdout: string[];
  beforeEach(() => {
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      stdout.push(typeof c === "string" ? c : c.toString());
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("parses --format/--path/--name in both flag forms", () => {
    const a = parseArgs(["sandbox", "export", "--format", "multidoc", "--path", "./o.xs", "--name", "docs"]);
    expect([a.format, a.path, a.name]).toEqual(["multidoc", "./o.xs", "docs"]);
    const b = parseArgs(["sandbox", "export", "--format=json", "--path=-", "--name=ws"]);
    expect([b.format, b.path, b.name]).toEqual(["json", "-", "ws"]);
  });

  it("rejects an unknown --format value", () => {
    expect(() => parseArgs(["sandbox", "export", "--format", "yaml"])).toThrow(/--format must be "json" or "multidoc"/);
  });

  it("leaves format undefined and keeps flags out of positionals", () => {
    const a = parseArgs(["sandbox", "export", "--path", "-"]);
    expect(a.format).toBeUndefined();
    expect(a.positionals).toEqual([]);
  });

  it("run() dispatches `sandbox export --format multidoc` through the command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidestep-sandbox-export-run-"));
    try {
      const authFile = writeTokenFile(dir);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(MULTIDOC, { status: 200 }));
      await run(["sandbox", "export", "--format", "multidoc", "--config", authFile, "--path", "-"]);
      expect(stdout.join("")).toBe(MULTIDOC + "\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("run() rejects an unknown sandbox subcommand, listing the ones that exist", async () => {
    await expect(run(["sandbox", "bogus"])).rejects.toThrow(/export.*codegen.*details/s);
  });
});
