/**
 * U10 — the `codegen` CLI surface.
 *
 * Four commands over one core, so most of what is worth testing is the *edges*:
 * which positional means what, what happens to a non-empty output directory, and
 * whether a tree that does not round-trip fails loudly (KTD-9) or quietly.
 *
 * The live sources are exercised with `fetch` stubbed — the point is that each
 * one reaches `workspace/{id}/export` at the right origin and workspace id, not
 * that the network works. A wrong id there is the difference between reading the
 * user's real workspace and reading someone else's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../src/index.js"; // load every kind + statement registration
import { run } from "../../src/emit/cli.js";
import { encodeWorkspaceArchive } from "../../src/validate/archive.js";
import { workspace } from "../../src/workspace/xano.js";
import { defineFunction } from "../../src/function/define.js";
import { s } from "../../src/statements/s.js";
import { c } from "../../src/values/value.js";

const INSTANCE = "https://default.example.com";

/** A small but real bundle — authored through the SDK, not hand-approximated. */
function sampleBundle(): { payload: Record<string, unknown> } {
  return workspace("ws")
    .registerFunctions([
      defineFunction({
        name: "signup",
        guid: "1".repeat(32),
        stack: [s.set_var("total", c.int(0))],
      }),
    ])
    .export() as unknown as { payload: Record<string, unknown> };
}

/** The tar+gzip archive `workspace/{id}/export` returns, built by the real encoder. */
function archive(bundle: unknown): Response {
  const data = encodeWorkspaceArchive(JSON.stringify(bundle));
  return new Response(Buffer.from(data), { status: 200, statusText: "OK" });
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

function writeTokenFile(dir: string): void {
  mkdirSync(join(dir, ".xano"), { recursive: true });
  writeFileSync(
    join(dir, ".xano", "auth.json"),
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
}

/** `auth/me`, as `resolveScopedWorkspaceId` reads it. */
const AUTH_ME = {
  extras: {
    oauth: { workspace: "ws-guid" },
    instance: { membership: { workspace: [{ guid: "ws-guid", id: 42 }] } },
  },
};

let dir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sidestep-codegen-"));
  cwd = process.cwd();
  process.chdir(dir);
  writeTokenFile(dir);
});

afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("codegen <bundle.json> <path> — the offline form", () => {
  it("writes a tree that re-exports as the bundle it came from", async () => {
    const bundle = sampleBundle();
    writeFileSync(join(dir, "ws.json"), JSON.stringify(bundle));

    await run(["codegen", "ws.json", "out"]);

    expect(existsSync(join(dir, "out", "index.ts"))).toBe(true);
    expect(existsSync(join(dir, "out", "README.md"))).toBe(true);
    expect(existsSync(join(dir, "out", "tsconfig.json"))).toBe(true);
    expect(readFileSync(join(dir, "out", "functions", "signup.ts"), "utf8")).toContain(
      's.set_var("total", c.int(0))',
    );
  });

  it("touches no network at all", async () => {
    // KTD-6: `decodeBundle` is pure and offline, and the file form must stay that
    // way — no auth prompt, no meta call, usable with no login.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    writeFileSync(join(dir, "ws.json"), JSON.stringify(sampleBundle()));
    await run(["codegen", "ws.json", "out"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("creates the output directory when it does not exist", async () => {
    writeFileSync(join(dir, "ws.json"), JSON.stringify(sampleBundle()));
    await run(["codegen", "ws.json", "nested/deeper/out"]);
    expect(existsSync(join(dir, "nested", "deeper", "out", "index.ts"))).toBe(true);
  });

  it("refuses a non-empty target without --force, and writes nothing", async () => {
    // The tree has no merge story, so a silent overwrite would destroy hand edits.
    writeFileSync(join(dir, "ws.json"), JSON.stringify(sampleBundle()));
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "mine.ts"), "// keep me");

    await expect(run(["codegen", "ws.json", "out"])).rejects.toThrow(/is not empty/);
    expect(readFileSync(join(dir, "out", "mine.ts"), "utf8")).toBe("// keep me");
    expect(existsSync(join(dir, "out", "index.ts"))).toBe(false);
  });

  it("writes into a non-empty target with --force", async () => {
    writeFileSync(join(dir, "ws.json"), JSON.stringify(sampleBundle()));
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "mine.ts"), "// keep me");

    await run(["codegen", "ws.json", "out", "--force"]);
    expect(existsSync(join(dir, "out", "index.ts"))).toBe(true);
  });

  it("fails a bundle that cannot round-trip, naming the object (KTD-9)", async () => {
    // An object with no guid cannot be identified, so assembly skips it — the
    // exact silent-loss case verification exists to catch. It must be a hard
    // failure, not a warning, or CI would go green on a divergent tree.
    const bundle = sampleBundle();
    (bundle.payload.function as unknown[]).push({ name: "ghost", description: "", input: [], run: [] });
    writeFileSync(join(dir, "ws.json"), JSON.stringify(bundle));

    await expect(run(["codegen", "ws.json", "out"])).rejects.toThrow(/verification failed/i);
    // The tree is still on disk to inspect, and the README says what went wrong.
    expect(readFileSync(join(dir, "out", "README.md"), "utf8")).toContain("ghost");
  });

  it("skips verification with --no-verify", async () => {
    const bundle = sampleBundle();
    (bundle.payload.function as unknown[]).push({ name: "ghost", description: "", input: [], run: [] });
    writeFileSync(join(dir, "ws.json"), JSON.stringify(bundle));

    await run(["codegen", "ws.json", "out", "--no-verify"]);
    expect(existsSync(join(dir, "out", "index.ts"))).toBe(true);
  });

  it("explains a missing file and a non-bundle JSON file, without a decoder stack trace", async () => {
    await expect(run(["codegen", "nope.json", "out"])).rejects.toThrow(/No bundle file at/);

    writeFileSync(join(dir, "bad.json"), "not json");
    await expect(run(["codegen", "bad.json", "out"])).rejects.toThrow(/not valid JSON/);

    writeFileSync(join(dir, "empty.json"), "{}");
    await expect(run(["codegen", "empty.json", "out"])).rejects.toThrow(/no `payload`/);
  });

  it("needs an output path", async () => {
    writeFileSync(join(dir, "ws.json"), JSON.stringify(sampleBundle()));
    await expect(run(["codegen", "ws.json"])).rejects.toThrow(/needs an output path/);
  });
});

describe("workspace codegen <path> — the real workspace", () => {
  it("reads the workspace the token is scoped to, never a hard-coded id", async () => {
    // Instances number workspaces from their own sequence, so a fixed 1 reads the
    // wrong workspace (or 404s) wherever the primary is not id 1.
    const fetchSpy = seq(res(AUTH_ME), archive(sampleBundle()));
    await run(["workspace", "codegen", "out"]);

    const exportCall = fetchSpy.mock.calls[1]![0] as string;
    expect(exportCall).toBe(`${INSTANCE}/api:meta/workspace/42/export`);
    expect(existsSync(join(dir, "out", "index.ts"))).toBe(true);
  });

  it("honours an explicit --workspace, skipping scope resolution", async () => {
    const fetchSpy = seq(archive(sampleBundle()));
    await run(["workspace", "codegen", "out", "--workspace", "9"]);
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${INSTANCE}/api:meta/workspace/9/export`);
  });

  it("needs an output path", async () => {
    await expect(run(["workspace", "codegen"])).rejects.toThrow(/needs an output path/);
  });
});

describe("workspace — the read-only family", () => {
  it("exports the bundle as JSON", async () => {
    seq(res(AUTH_ME), archive(sampleBundle()));
    await run(["workspace", "export", "--path", join(dir, "ws.json")]);
    const written = JSON.parse(readFileSync(join(dir, "ws.json"), "utf8")) as { payload: unknown };
    expect(written.payload).toBeDefined();
  });

  it("reports which workspace the token is scoped to", async () => {
    seq(res(AUTH_ME), res([{ id: 42, name: "prod", guid: "ws-guid" }]));
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    await run(["workspace", "details"]);
    expect(out.join("")).toContain("42");
  });

  it("says plainly that there is no workspace deploy", async () => {
    // The removed-command tombstone matters: `deploy` is a full replace, so
    // pointing it at a real workspace would destroy data.
    await expect(run(["workspace", "deploy"])).rejects.toThrow(/FULL REPLACE/);
  });

  it("rejects an unknown subcommand with the ones that exist", async () => {
    await expect(run(["workspace", "frobnicate"])).rejects.toThrow(/details.*export.*codegen/s);
  });
});

describe("sandbox and ephemeral codegen", () => {
  it("sandbox codegen resolves the tenant origin and its single workspace", async () => {
    const fetchSpy = seq(
      res({ name: "sb", xano_domain: "sb.xano.io" }),
      res([{ id: 3 }]),
      archive(sampleBundle()),
    );
    await run(["sandbox", "codegen", "out"]);
    // The tenant's own origin, at the id its workspace list reported.
    expect(String(fetchSpy.mock.calls[2]![0])).toContain("/api:meta/workspace/3/export");
    expect(existsSync(join(dir, "out", "index.ts"))).toBe(true);
  });

  it("ephemeral codegen takes the tenant first and the path second", async () => {
    // The one command whose positionals differ — reading them in the wrong order
    // would try to create a directory named after the tenant.
    const live = {
      id: 7,
      name: "e4f2",
      display: "PR 1",
      xano_domain: "e4f2.xano.io",
      state: "ok",
      ephemeral_expires_at: "2999-01-01 00:00:00+0000",
    };
    seq(res(AUTH_ME), res(live), archive(sampleBundle()));

    await run(["ephemeral", "codegen", "e4f2", "out"]);
    expect(existsSync(join(dir, "out", "index.ts"))).toBe(true);
  });

  it("ephemeral codegen without a path says which positional is missing", async () => {
    const live = {
      id: 7,
      name: "e4f2",
      display: "PR 1",
      xano_domain: "e4f2.xano.io",
      state: "ok",
      ephemeral_expires_at: "2999-01-01 00:00:00+0000",
    };
    seq(res(AUTH_ME), res(live), archive(sampleBundle()));
    await expect(run(["ephemeral", "codegen", "e4f2"])).rejects.toThrow(/needs an output path/);
  });
});
