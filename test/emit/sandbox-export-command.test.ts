import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, rmSync, mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, run, exportBundleJson } from "../../src/emit/cli.js";
import {
  resolveOutputTarget,
  fetchSandboxMultidoc,
  runSandboxExportCommand,
} from "../../src/emit/sandbox-export-command.js";

const INSTANCE = "https://inst.example.com";
const MULTIDOC = "workspace {\n  name = \"app\"\n}\n"; // a tiny stand-in for the .xs body

/** Write an unexpired token cache so getAccessToken returns without discovery/refresh. */
function writeTokenFile(dir: string): string {
  const path = join(dir, ".xano", "auth.json");
  mkdirSync(join(dir, ".xano"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      access_token: "acc-cached",
      refresh_token: "ref-cached",
      expires_at: Date.now() + 3_600_000,
      scope: "workspace:read",
      instance: INSTANCE,
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

  const auth = { access_token: "acc-1", instance: INSTANCE };

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
  const entryPath = fileURLToPath(new URL("../fixtures/workspace/index.ts", import.meta.url));

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

  it("--format json compiles the entry to a bundle byte-identical to `sidestep export`", async () => {
    const outPath = join(dir, "ws.json");
    await runSandboxExportCommand(parseArgs(["sandbox", "export", "--format", "json", entryPath, "--path", outPath]));

    const expected = await exportBundleJson(parseArgs(["sandbox", "export", "--format", "json", entryPath]));
    expect(readFileSync(outPath, "utf8")).toBe(expected + "\n");
    expect(stdout.join("")).toBe(""); // nothing on the data channel when writing a file
  });

  it("--format json defaults to ./sandbox.json when --path is omitted", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      await runSandboxExportCommand(parseArgs(["sandbox", "export", "--format", "json", entryPath]));
      expect(existsSync(join(dir, "sandbox.json"))).toBe(true);
    } finally {
      cwd.mockRestore();
    }
  });

  it("--format json reads --bundle without recompiling", async () => {
    const bundlePath = join(dir, "pre.json");
    writeFileSync(bundlePath, '{"app":"xano"}');
    await runSandboxExportCommand(
      parseArgs(["sandbox", "export", "--format", "json", "--bundle", bundlePath, "--path", "-"]),
    );
    expect(stdout.join("")).toBe('{"app":"xano"}\n');
  });

  it("--format multidoc writes the fetched .xs body to --name", async () => {
    const authFile = writeTokenFile(dir);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(MULTIDOC, { status: 200 }));
    await runSandboxExportCommand(
      parseArgs(["sandbox", "export", "--format", "multidoc", "--config", authFile, "--path", dir, "--name", "docs"]),
    );
    expect(readFileSync(join(dir, "docs.xs"), "utf8")).toBe(MULTIDOC + "\n");
  });

  it("--format multidoc --path - prints the .xs body to stdout", async () => {
    const authFile = writeTokenFile(dir);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(MULTIDOC, { status: 200 }));
    await runSandboxExportCommand(
      parseArgs(["sandbox", "export", "--format", "multidoc", "--config", authFile, "--path", "-"]),
    );
    expect(stdout.join("")).toBe(MULTIDOC + "\n");
  });

  it("rejects multidoc with an input file (it exports the deployed tenant, takes no input)", async () => {
    const authFile = writeTokenFile(dir);
    await expect(
      runSandboxExportCommand(parseArgs(["sandbox", "export", "--format", "multidoc", entryPath, "--config", authFile])),
    ).rejects.toThrow(/takes no input/i);
  });

  it("rejects json with neither an entry file nor --bundle", async () => {
    await expect(
      runSandboxExportCommand(parseArgs(["sandbox", "export", "--format", "json"])),
    ).rejects.toThrow(/Missing input.*--format json/s);
  });

  it("requires --format", async () => {
    await expect(
      runSandboxExportCommand(parseArgs(["sandbox", "export"])),
    ).rejects.toThrow(/Pass --format json\|multidoc/);
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

  it("run() rejects an unknown sandbox subcommand, listing export", async () => {
    await expect(run(["sandbox", "bogus"])).rejects.toThrow(/sandbox export/);
  });
});
