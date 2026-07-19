import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../../src/emit/cli.js";
import { runProfileCommand, fetchProfile, resolveTargetWorkspace } from "../../src/emit/profile-command.js";

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

const ME_BODY =
  '{"id":9,"name":"Ada","email":"ada@example.com","workspace":{"id":42,"name":"my-app"},"extras":{"oauth":{"scope":"workspace:write","workspace":"ws-guid"},"instance":{"membership":{"role":"admin"}}}}';

describe("sidestep profile me", () => {
  let dir: string;
  let stdout: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidestep-profile-"));
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

  it("calls auth/me with the bearer token and prints projected JSON to stdout", async () => {
    const authFile = writeTokenFile(dir);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(ME_BODY, { status: 200 }));

    await runProfileCommand(parseArgs(["profile", "me", "--config", authFile]));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${INSTANCE}/api:meta/auth/me`);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer acc-cached");

    const out = JSON.parse(stdout.join(""));
    expect(out.instance).toBe(INSTANCE); // headline: instance base URL, from the token
    expect(out.user).toEqual({ id: 9, name: "Ada", email: "ada@example.com" });
    expect(out.workspace).toEqual({ id: 42, name: "my-app" });
  });

  it("never emits the raw `extras` blob", async () => {
    const authFile = writeTokenFile(dir);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(ME_BODY, { status: 200 }));
    await runProfileCommand(parseArgs(["profile", "me", "--config", authFile]));
    const joined = stdout.join("");
    expect(joined).not.toContain("extras");
    expect(joined).not.toContain("ws-guid");
    expect(joined).not.toContain("membership");
  });

  it("resolveTargetWorkspace returns the numeric workspace id and name", async () => {
    const authFile = writeTokenFile(dir);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(ME_BODY, { status: 200 }));
    const target = await resolveTargetWorkspace(parseArgs(["workspace", "deploy", "--config", authFile]));
    expect(target).toEqual({ instance: INSTANCE, workspaceId: 42, workspaceName: "my-app" });
  });

  it("resolveTargetWorkspace errors when the instance exposes no scoped workspace id", async () => {
    const authFile = writeTokenFile(dir);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"id":9,"name":"Ada","extras":{}}', { status: 200 }),
    );
    await expect(
      resolveTargetWorkspace(parseArgs(["workspace", "deploy", "--config", authFile])),
    ).rejects.toThrow(/Could not resolve the token's target workspace/i);
  });

  it("errors when not signed in", async () => {
    await expect(
      fetchProfile(parseArgs(["profile", "me", "--config", join(dir, "nope.json")])),
    ).rejects.toThrow(/Not signed in/i);
  });

  it("surfaces a non-2xx auth/me response as an error", async () => {
    const authFile = writeTokenFile(dir);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401, statusText: "Unauthorized" }));
    await expect(
      fetchProfile(parseArgs(["profile", "me", "--config", authFile])),
    ).rejects.toThrow(/profile me failed \(401/);
  });
});
