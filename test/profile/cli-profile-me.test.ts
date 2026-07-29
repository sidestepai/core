import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../../src/emit/cli.js";
import { runProfileCommand, fetchProfile } from "../../src/emit/profile-command.js";

const INSTANCE = "https://inst.example.com";

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
  });

  it("prints an aligned human summary (no JSON) when stdout is a TTY", async () => {
    const authFile = writeTokenFile(dir);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(ME_BODY, { status: 200 }));
    // NO_COLOR keeps the assertion free of ANSI escapes; the TTY flag drives the branch.
    const prevColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      await runProfileCommand(parseArgs(["profile", "me", "--config", authFile]));
    } finally {
      if (ttyDesc) Object.defineProperty(process.stdout, "isTTY", ttyDesc);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      if (prevColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prevColor;
    }
    const joined = stdout.join("");
    expect(joined).toContain("Signed in");
    expect(joined).toContain("Ada <ada@example.com>");
    expect(joined).toContain("id 9");
    expect(joined).toContain(INSTANCE);
    expect(() => JSON.parse(joined)).toThrow(); // human view, not JSON
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
  // ── under a hand-authored meta API token credential ──

  function writeMetaTokenFile(dir: string): string {
    const path = join(dir, ".xano", "auth.json");
    mkdirSync(join(dir, ".xano"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        type: "token",
        instance_base_url: INSTANCE,
        workspace_id: 7,
        meta_api_token: "meta-tok",
      }),
    );
    return path;
  }

  it("sends the meta API token as the bearer and reports the credential's instance", async () => {
    const authFile = writeMetaTokenFile(dir);
    const m = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(ME_BODY, { status: 200 }));

    const profile = await fetchProfile(parseArgs(["profile", "me", "--config", authFile]));

    const [url, init] = m.mock.calls[0]!;
    expect(String(url)).toBe(`${INSTANCE}/api:meta/auth/me`);
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer meta-tok");
    // The headline instance comes from the credential, not the response body.
    expect(profile.instance).toBe(INSTANCE);
  });

  it("renders unknown user fields rather than failing when the response omits them", async () => {
    // A meta API token is not an OAuth session; what `auth/me` returns for one is
    // upstream behaviour we do not control, so absent fields must not throw.
    const authFile = writeMetaTokenFile(dir);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    const profile = await fetchProfile(parseArgs(["profile", "me", "--config", authFile]));
    expect(profile.instance).toBe(INSTANCE);
    expect(profile.user).toEqual({ id: undefined, name: undefined, email: undefined });
  });
});
