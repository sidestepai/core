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
import { isMissingDependencyError } from "../../src/emit/codegen-command.js";
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
}

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

    await run(["codegen", "ws.json", "out", "--no-install"]);

    // The decoded workspace fills xano/ inside a full init-shaped project.
    expect(existsSync(join(dir, "out", "xano", "index.ts"))).toBe(true);
    expect(existsSync(join(dir, "out", "xano", "README.md"))).toBe(true);
    expect(existsSync(join(dir, "out", "package.json"))).toBe(true);
    expect(existsSync(join(dir, "out", "frontend", "src", "App.tsx"))).toBe(true);
    // The generated tsconfig is dropped — the project's root one covers xano/.
    expect(existsSync(join(dir, "out", "xano", "tsconfig.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "out", "tsconfig.json"), "utf8")).include).toContain(
      "xano",
    );
    expect(readFileSync(join(dir, "out", "xano", "functions", "signup.ts"), "utf8")).toContain(
      's.set_var("total", c.int(0))',
    );
  });

  it("touches no network at all", async () => {
    // KTD-6: `decodeBundle` is pure and offline, and the file form must stay that
    // way — no auth prompt, no meta call, usable with no login.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    writeFileSync(join(dir, "ws.json"), JSON.stringify(sampleBundle()));
    await run(["codegen", "ws.json", "out", "--no-install"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("creates the output directory when it does not exist", async () => {
    writeFileSync(join(dir, "ws.json"), JSON.stringify(sampleBundle()));
    await run(["codegen", "ws.json", "nested/deeper/out", "--no-install"]);
    expect(existsSync(join(dir, "nested", "deeper", "out", "xano", "index.ts"))).toBe(true);
  });

  it("refuses a non-empty target without --force, and writes nothing", async () => {
    // The tree has no merge story, so a silent overwrite would destroy hand edits.
    writeFileSync(join(dir, "ws.json"), JSON.stringify(sampleBundle()));
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "mine.ts"), "// keep me");

    await expect(run(["codegen", "ws.json", "out", "--no-install"])).rejects.toThrow(/is not empty/);
    expect(readFileSync(join(dir, "out", "mine.ts"), "utf8")).toBe("// keep me");
    expect(existsSync(join(dir, "out", "xano", "index.ts"))).toBe(false);
  });

  it("writes into a non-empty target with --force", async () => {
    writeFileSync(join(dir, "ws.json"), JSON.stringify(sampleBundle()));
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "mine.ts"), "// keep me");

    await run(["codegen", "ws.json", "out", "--force", "--no-install"]);
    expect(existsSync(join(dir, "out", "xano", "index.ts"))).toBe(true);
  });

  it("fails a bundle that cannot round-trip, naming the object (KTD-9)", async () => {
    // An object with no guid cannot be identified, so assembly skips it — the
    // exact silent-loss case verification exists to catch. It must be a hard
    // failure, not a warning, or CI would go green on a divergent tree.
    const bundle = sampleBundle();
    (bundle.payload.function as unknown[]).push({ name: "ghost", description: "", input: [], run: [] });
    writeFileSync(join(dir, "ws.json"), JSON.stringify(bundle));

    await expect(run(["codegen", "ws.json", "out", "--no-install"])).rejects.toThrow(/verification failed/i);
    // The tree is still on disk to inspect, and the README says what went wrong.
    expect(readFileSync(join(dir, "out", "xano", "README.md"), "utf8")).toContain("ghost");
  });

  it("skips verification with --no-verify", async () => {
    const bundle = sampleBundle();
    (bundle.payload.function as unknown[]).push({ name: "ghost", description: "", input: [], run: [] });
    writeFileSync(join(dir, "ws.json"), JSON.stringify(bundle));

    await run(["codegen", "ws.json", "out", "--no-verify", "--no-install"]);
    expect(existsSync(join(dir, "out", "xano", "index.ts"))).toBe(true);
  });

  it("explains a missing file and a non-bundle JSON file, without a decoder stack trace", async () => {
    await expect(run(["codegen", "nope.json", "out", "--no-install"])).rejects.toThrow(/No bundle file at/);

    writeFileSync(join(dir, "bad.json"), "not json");
    await expect(run(["codegen", "bad.json", "out", "--no-install"])).rejects.toThrow(/not valid JSON/);

    writeFileSync(join(dir, "empty.json"), "{}");
    await expect(run(["codegen", "empty.json", "out", "--no-install"])).rejects.toThrow(/no `payload`/);
  });

  it("needs an output path", async () => {
    writeFileSync(join(dir, "ws.json"), JSON.stringify(sampleBundle()));
    await expect(run(["codegen", "ws.json", "--no-install"])).rejects.toThrow(/needs an output path/);
  });
});

describe("workspace codegen <path> — the real workspace", () => {
  it("reads the workspace the token is scoped to, never a hard-coded id", async () => {
    // Instances number workspaces from their own sequence, so a fixed 1 reads the
    // wrong workspace (or 404s) wherever the primary is not id 1.
    const fetchSpy = seq(archive(sampleBundle()));
    await run(["workspace", "codegen", "out", "--no-install"]);

    const exportCall = fetchSpy.mock.calls[0]![0] as string;
    expect(exportCall).toBe(`${INSTANCE}/api:meta/workspace/42/export`);
    expect(existsSync(join(dir, "out", "xano", "index.ts"))).toBe(true);
  });

  it("asks the server to skip table rows — a pull decodes configuration only", async () => {
    // The server pages through every row of every table before it emits a byte,
    // so on a workspace holding real data the export outlasts any client-side
    // timeout. None of it is read: the decode direction takes `workspace.json`
    // and ignores the archive's `content/` entries.
    const fetchSpy = seq(archive(sampleBundle()));
    await run(["workspace", "codegen", "out", "--no-install"]);

    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body)) as {
      records: boolean;
    };
    expect(body.records).toBe(false);
  });

  it("skips table rows for `workspace export` too — the bundle never carried them", async () => {
    // Not a behaviour change dressed as one: `decodeWorkspaceArchive` keeps
    // `workspace.json` and discards the archive's `content/` entries, so the rows
    // this used to request were dropped before the file was written. Same bundle,
    // without making the server page through every table to build it.
    const fetchSpy = seq(archive(sampleBundle()));
    await run(["workspace", "export", "--path", join(dir, "ws.json")]);

    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body)) as {
      records: boolean;
    };
    expect(body.records).toBe(false);
  });

  it("rejects --workspace instead of reading a workspace the credential does not address", async () => {
    await expect(run(["workspace", "codegen", "out", "--workspace", "9", "--no-install"])).rejects.toThrow(
      /`--workspace` was removed/,
    );
  });

  it("needs an output path", async () => {
    await expect(run(["workspace", "codegen", "--no-install"])).rejects.toThrow(/needs an output path/);
  });
});

describe("workspace — the read-only family", () => {
  it("exports the bundle as JSON", async () => {
    seq(archive(sampleBundle()));
    await run(["workspace", "export", "--path", join(dir, "ws.json")]);
    const written = JSON.parse(readFileSync(join(dir, "ws.json"), "utf8")) as { payload: unknown };
    expect(written.payload).toBeDefined();
  });

  it("reports the pinned workspace and which credential selected it", async () => {
    seq(res([{ id: 42, name: "prod", guid: "ws-guid" }]));
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    await run(["workspace", "details"]);
    const summary = JSON.parse(out.join("")) as { id: number; name: string; credential: string };
    expect(summary.id).toBe(42);
    expect(summary.name).toBe("prod");
    expect(summary.credential).toBe("oauth");
  });

  it("names a pinned workspace that does not exist, listing the ones that do", async () => {
    // The likeliest hand-authoring mistake: a well-formed id that is simply
    // wrong. Everywhere else it is an opaque 404; here it must be diagnosed.
    writeFileSync(
      join(dir, ".xano", "auth.json"),
      JSON.stringify({
        type: "token",
        instance_base_url: INSTANCE,
        workspace_id: 1,
        meta_api_token: "meta-tok",
      }),
    );
    seq(res([{ id: 9, name: "real-one" }, { id: 11, name: "other" }]));

    await expect(run(["workspace", "details"])).rejects.toThrow(/Workspace 1 does not exist/);
  });

  it("points a wrong pinned workspace at the right fix per credential type", async () => {
    const wrong = { type: "token", instance_base_url: INSTANCE, workspace_id: 1, meta_api_token: "t" };
    writeFileSync(join(dir, ".xano", "auth.json"), JSON.stringify(wrong));
    seq(res([{ id: 9, name: "real-one" }]));
    // A hand-authored credential is fixed by editing the file…
    await expect(run(["workspace", "details"])).rejects.toThrow(/Fix `workspace_id`/);

    // …an oauth one by signing in again.
    writeTokenFile(dir);
    seq(res([{ id: 9, name: "real-one" }])); // pinned id is 42, absent from the list
    await expect(run(["workspace", "details"])).rejects.toThrow(/sidestep login/);
  });

  it("reports a meta API token credential as the source of the workspace", async () => {
    writeFileSync(
      join(dir, ".xano", "auth.json"),
      JSON.stringify({
        type: "token",
        instance_base_url: INSTANCE,
        workspace_id: 7,
        meta_api_token: "meta-tok",
      }),
    );
    seq(res([{ id: 7, name: "via-token", guid: "ws-guid" }]));
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });

    await run(["workspace", "details"]);
    const summary = JSON.parse(out.join("")) as { id: number; credential: string };
    expect(summary.id).toBe(7);
    expect(summary.credential).toBe("token");
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
    await run(["sandbox", "codegen", "out", "--no-install"]);
    // The tenant's own origin, at the id its workspace list reported.
    expect(String(fetchSpy.mock.calls[2]![0])).toContain("/api:meta/workspace/3/export");
    expect(existsSync(join(dir, "out", "xano", "index.ts"))).toBe(true);
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
    seq(res(live), archive(sampleBundle()));

    await run(["ephemeral", "codegen", "e4f2", "out", "--no-install"]);
    expect(existsSync(join(dir, "out", "xano", "index.ts"))).toBe(true);
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
    seq(res(live), archive(sampleBundle()));
    await expect(run(["ephemeral", "codegen", "e4f2", "--no-install"])).rejects.toThrow(/needs an output path/);
  });
});

describe("codegen writes a project (U3)", () => {
  beforeEach(() => {
    writeFileSync(join(dir, "ws.json"), JSON.stringify(sampleBundle()));
  });

  it("writes the same project shell init writes", async () => {
    await run(["codegen", "ws.json", "out", "--no-install"]);
    for (const f of [
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      ".gitignore",
      ".env.example",
      "README.md",
      "frontend/index.html",
      "frontend/src/main.tsx",
      "frontend/src/App.tsx",
      "frontend/src/index.css",
      "frontend/src/lib/api.ts",
    ]) {
      expect(existsSync(join(dir, "out", f))).toBe(true);
    }
    // The scripts that make the advertised flow work.
    const pkg = JSON.parse(readFileSync(join(dir, "out", "package.json"), "utf8"));
    expect(pkg.scripts.build).toContain("tsc --noEmit");
    expect(pkg.scripts["xano:deploy"]).toContain("./xano/index.ts");
  });

  it("keeps the project README and the decode report as distinct files", async () => {
    await run(["codegen", "ws.json", "out", "--no-install"]);
    const root = readFileSync(join(dir, "out", "README.md"), "utf8");
    const report = readFileSync(join(dir, "out", "xano", "README.md"), "utf8");
    expect(root).not.toBe(report);
    expect(root).toMatch(/npm run xano:deploy/);
    expect(report).toContain("Generated SideStep workspace");
  });

  it("writes a provenance marker naming the source", async () => {
    await run(["codegen", "ws.json", "out", "--no-install"]);
    const marker = JSON.parse(
      readFileSync(join(dir, "out", "xano", ".sidestep-codegen.json"), "utf8"),
    );
    expect(marker.source).toBe("file");
    expect(marker.origin).toBe("ws.json");
    expect(typeof marker.generatedAt).toBe("string");
  });

  it("names the app from the target directory, and --name overrides it", async () => {
    await run(["codegen", "ws.json", "My App", "--no-install"]);
    expect(JSON.parse(readFileSync(join(dir, "My App", "package.json"), "utf8")).name).toBe(
      "my-app",
    );
    await run(["codegen", "ws.json", "other", "--name", "acme", "--no-install"]);
    expect(JSON.parse(readFileSync(join(dir, "other", "package.json"), "utf8")).name).toBe("acme");
  });

  it("--ai writes the generated guidance, not the authoring one", async () => {
    await run(["codegen", "ws.json", "out", "--no-install", "--ai", "claude"]);
    const md = readFileSync(join(dir, "out", "CLAUDE.md"), "utf8");
    expect(md).toMatch(/machine-written and disposable/i);
    expect(md).not.toContain("EXAMPLE.md");
  });

  it("all four sources produce the same project shape", async () => {
    const shape = (target: string) =>
      ["package.json", "tsconfig.json", "xano/index.ts", "xano/.sidestep-codegen.json"].every((f) =>
        existsSync(join(dir, target, f)),
      );

    seq(archive(sampleBundle()));
    await run(["workspace", "codegen", "ws-out", "--no-install"]);
    expect(shape("ws-out")).toBe(true);

    vi.restoreAllMocks();
    seq(res({ name: "sb", xano_domain: "sb.xano.io" }), res([{ id: 3 }]), archive(sampleBundle()));
    await run(["sandbox", "codegen", "sb-out", "--no-install"]);
    expect(shape("sb-out")).toBe(true);

    await run(["codegen", "ws.json", "file-out", "--no-install"]);
    expect(shape("file-out")).toBe(true);
  });
});

describe("re-running codegen (U5)", () => {
  beforeEach(() => {
    writeFileSync(join(dir, "ws.json"), JSON.stringify(sampleBundle()));
  });

  it("refreshes xano/ without --force and leaves the project shell alone", async () => {
    await run(["codegen", "ws.json", "out", "--no-install"]);
    const app = join(dir, "out", "frontend", "src", "App.tsx");
    writeFileSync(app, "export default function App() { return <p>mine</p>; }\n");
    const pkgPath = join(dir, "out", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.scripts.mine = "echo hi";
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    // No --force: the marker is what makes re-pulling a real workflow.
    await run(["codegen", "ws.json", "out", "--no-install"]);
    expect(readFileSync(app, "utf8")).toContain("mine");
    expect(JSON.parse(readFileSync(pkgPath, "utf8")).scripts.mine).toBe("echo hi");
    expect(existsSync(join(dir, "out", "xano", "index.ts"))).toBe(true);
  });

  it("drops stale and hand-added files under xano/", async () => {
    await run(["codegen", "ws.json", "out", "--no-install"]);
    writeFileSync(join(dir, "out", "xano", "stale.ts"), "export const gone = 1;\n");
    await run(["codegen", "ws.json", "out", "--no-install"]);
    expect(existsSync(join(dir, "out", "xano", "stale.ts"))).toBe(false);
  });

  it("preserves xano/xano.lock across a refresh", async () => {
    await run(["codegen", "ws.json", "out", "--no-install"]);
    const lockPath = join(dir, "out", "xano", "xano.lock");
    const lock = `{"objects":{"app:notes":{"canonical":"notes"}}}\n`;
    writeFileSync(lockPath, lock);
    await run(["codegen", "ws.json", "out", "--no-install"]);
    // The lock is placed beside the deploy entry, i.e. inside the delete zone —
    // losing it silently re-derives guids for objects that already exist.
    expect(readFileSync(lockPath, "utf8")).toBe(lock);
  });

  it("--force into a foreign project clears its xano/ first", async () => {
    // The init-then-codegen case: an orphan under xano/ stays inside the root
    // tsconfig's include and breaks `npm run build`.
    mkdirSync(join(dir, "authored", "xano"), { recursive: true });
    writeFileSync(join(dir, "authored", "package.json"), "{}");
    writeFileSync(join(dir, "authored", "xano", "tables.ts"), "export const t = 1;\n");

    await expect(run(["codegen", "ws.json", "authored", "--no-install"])).rejects.toThrow(
      /not empty/,
    );
    await run(["codegen", "ws.json", "authored", "--force", "--no-install"]);
    expect(existsSync(join(dir, "authored", "xano", "tables.ts"))).toBe(false);
    expect(existsSync(join(dir, "authored", "xano", "index.ts"))).toBe(true);
  });
});

describe("verification and install (U4)", () => {
  it("still fails a bundle that cannot round-trip when deps are unavailable", async () => {
    // The KTD-9 gate must survive the move: vitest resolves @sidestep/core via
    // its alias, so a genuine mismatch is still caught with --no-install.
    const bundle = sampleBundle();
    (bundle.payload.function as unknown[]).push({
      name: "ghost",
      description: "",
      input: [],
      run: [],
    });
    writeFileSync(join(dir, "ws.json"), JSON.stringify(bundle));
    await expect(run(["codegen", "ws.json", "out", "--no-install"])).rejects.toThrow(
      /verification failed/i,
    );
  });

  it("classifies a missing dependency, and only that", () => {
    const notFound = Object.assign(new Error("Cannot find package '@sidestep/core'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    expect(isMissingDependencyError(notFound)).toBe(true);

    // loadDefault rewraps ERR_MODULE_NOT_FOUND into the tsx-fallback error, which
    // carries the original only on `cause` — the common real-world shape.
    expect(
      isMissingDependencyError(
        new Error('Loading a TypeScript entry ("x.ts") requires `tsx`.', { cause: notFound }),
      ),
    ).toBe(true);

    // A relative import that does not resolve is the tree's fault, not npm's.
    expect(
      isMissingDependencyError(
        Object.assign(new Error("Cannot find module './_shared.js'"), {
          code: "ERR_MODULE_NOT_FOUND",
        }),
      ),
    ).toBe(false);
    expect(isMissingDependencyError(new SyntaxError("Unexpected token"))).toBe(false);
    expect(isMissingDependencyError(undefined)).toBe(false);
  });
});
