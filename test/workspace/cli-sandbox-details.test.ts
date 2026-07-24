import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../../src/emit/cli.js";
import {
  runSandboxDetailsCommand,
  fetchSandboxDetails,
  sandboxBaseUrl,
} from "../../src/emit/sandbox-details-command.js";

const INSTANCE = "https://inst.example.com";

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

const SANDBOX_BODY = JSON.stringify({
  id: 7,
  name: "tc24-abcd-x1y2",
  display: "My Sandbox",
  state: "ok",
  xano_domain: "abc123.xano.io",
  sandbox_expires_at: 1_900_000_000_000,
  // internals that must never be echoed back:
  k8s: { pods: 3 },
  license: "tier1",
  cluster: { id: "c-1" },
});

describe("sidestep sandbox details", () => {
  let dir: string;
  let stdout: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidestep-sandbox-details-"));
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

  it("prints an aligned human summary (no JSON) when stdout is a TTY", async () => {
    const authFile = writeTokenFile(dir);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(SANDBOX_BODY, { status: 200 }));
    const prevColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1"; // assert on plain text, not ANSI
    const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      await runSandboxDetailsCommand(parseArgs(["sandbox", "details", "--config", authFile]));
    } finally {
      if (ttyDesc) Object.defineProperty(process.stdout, "isTTY", ttyDesc);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      if (prevColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prevColor;
    }
    const joined = stdout.join("");
    expect(joined).toContain("Base URL");
    expect(joined).toContain("https://abc123.xano.io");
    expect(joined).toContain("My Sandbox");
    expect(joined).toContain("(ok)");
    expect(() => JSON.parse(joined)).toThrow(); // human view, not JSON
  });

  it("calls sandbox/me with the bearer token and prints the base URL + projected fields", async () => {
    const authFile = writeTokenFile(dir);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(SANDBOX_BODY, { status: 200 }));

    await runSandboxDetailsCommand(parseArgs(["sandbox", "details", "--config", authFile]));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${INSTANCE}/api:meta/sandbox/me`);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer acc-cached");

    const out = JSON.parse(stdout.join(""));
    expect(out.baseUrl).toBe("https://abc123.xano.io"); // headline: derived from xano_domain
    expect(out.sandbox).toEqual({
      id: 7,
      name: "tc24-abcd-x1y2",
      display: "My Sandbox",
      state: "ok",
      xanoDomain: "abc123.xano.io",
      expiresAt: 1_900_000_000_000,
    });
  });

  it("never echoes the raw tenant internals", async () => {
    const authFile = writeTokenFile(dir);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(SANDBOX_BODY, { status: 200 }));
    await runSandboxDetailsCommand(parseArgs(["sandbox", "details", "--config", authFile]));
    const joined = stdout.join("");
    expect(joined).not.toContain("k8s");
    expect(joined).not.toContain("cluster");
    expect(joined).not.toContain("tier1");
  });

  it("errors when not signed in", async () => {
    await expect(
      fetchSandboxDetails(parseArgs(["sandbox", "details", "--config", join(dir, "nope.json")])),
    ).rejects.toThrow(/Not signed in/i);
  });

  it("surfaces a non-2xx sandbox/me response as an error", async () => {
    const authFile = writeTokenFile(dir);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 403, statusText: "Forbidden" }));
    await expect(
      fetchSandboxDetails(parseArgs(["sandbox", "details", "--config", authFile])),
    ).rejects.toThrow(/sandbox details failed \(403/);
  });
});

describe("sandboxBaseUrl", () => {
  it("prefers the tenant's own xano_domain over the instance origin", () => {
    expect(sandboxBaseUrl({ name: "t", xano_domain: "abc.xano.io" }, INSTANCE)).toBe("https://abc.xano.io");
  });

  it("keeps localhost hosts on http", () => {
    expect(sandboxBaseUrl({ xano_domain: "localhost:9999" }, INSTANCE)).toBe("http://localhost:9999");
  });

  it("falls back to the instance origin with a /tenant/<name> prefix when there is no domain", () => {
    expect(sandboxBaseUrl({ name: "tc24-abcd" }, INSTANCE)).toBe(`${INSTANCE}/tenant/tc24-abcd`);
  });

  it("falls back to the bare instance origin when the tenant has neither field", () => {
    expect(sandboxBaseUrl({}, INSTANCE)).toBe(INSTANCE);
  });
});
