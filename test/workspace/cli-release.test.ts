import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
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
      type: "oauth",
      access_token: "acc-cached",
      refresh_token: "ref-cached",
      expires_at: Date.now() + 3_600_000,
      scope: "offline_access workspace:write",
      instance: INSTANCE,
      workspace_id: 42,
      auth_host: "https://app.xano.com",
      client_id: "dcr-abc",
    }),
  );
  return path;
}
function bundleFile(dir: string): string {
  const p = join(dir, "bundle.json");
  writeFileSync(p, JSON.stringify({ app: "xano", type: "workspace", payload: {} }));
  return p;
}

describe("sidestep release (gated, coming soon)", () => {
  let dir: string;
  let authFile: string;
  let stderr: string[];
  let stdout: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidestep-rel-"));
    authFile = writeTokenFile(dir);
    stderr = [];
    stdout = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => (stderr.push(String(c)), true));
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (stdout.push(String(c)), true));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints a 'coming soon' message, resolves the token workspace, and imports NOTHING", async () => {
    // Only the workspace-resolution call (/auth/me) should fire — never an import.
    const m = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ extras: { instance: { membership: { workspace: [{ id: 42 }] } } } }), { status: 200 }));

    await run(["release", "--bundle", bundleFile(dir), "--config", authFile]);

    // exactly one fetch: workspace resolution, no import POST
    expect(m).toHaveBeenCalledTimes(1);
    expect(m.mock.calls[0]![0]).toBe(`${INSTANCE}/api:meta/auth/me`);
    const out = stderr.join("");
    expect(out).toMatch(/coming soon/i);
    expect(out).toMatch(/workspace #42/);
    // no import happened, no machine summary emitted
    expect(stdout.join("")).toBe("");
  });
});
