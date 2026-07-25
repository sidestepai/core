import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readTokens,
  writeTokens,
  resolveAuthFilePath,
  ensureGitignored,
  type TokenRecord,
} from "../../src/auth/store.js";
import { parseArgs } from "../../src/emit/cli.js";

const record: TokenRecord = {
  access_token: "acc",
  refresh_token: "ref",
  expires_at: 1_700_000_000_000,
  scope: "offline_access workspace:write",
  instance: "https://x8ki.xano.io",
  auth_host: "https://app.xano.com",
  client_id: "dcr-abc",
};

describe("auth store", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidestep-store-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.XANO_CONFIG;
    delete process.env.XANO_GLOBAL_CONFIG;
  });

  it("round-trips a token record through write/read", () => {
    const path = join(dir, ".xano", "auth.json");
    writeTokens(path, record);
    expect(readTokens(path)).toEqual(record);
  });

  it("creates the token file with 0600 permissions", () => {
    const path = join(dir, ".xano", "auth.json");
    writeTokens(path, record);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp residue after an overwrite", () => {
    const path = join(dir, "auth.json");
    writeTokens(path, record);
    writeTokens(path, { ...record, access_token: "acc2" });
    expect(readTokens(path)?.access_token).toBe("acc2");
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("returns null for a missing file", () => {
    expect(readTokens(join(dir, "nope.json"))).toBeNull();
  });

  it("throws an actionable error on a corrupt token file", () => {
    const path = join(dir, "auth.json");
    writeFileSync(path, "{ not json");
    expect(() => readTokens(path)).toThrow(/corrupt/i);
  });

  it("throws when a token file is valid JSON but missing required fields", () => {
    const path = join(dir, "auth.json");
    writeFileSync(path, JSON.stringify({ hello: "world" }));
    expect(() => readTokens(path)).toThrow(/missing expected fields/i);
  });

  it("refuses to overwrite an existing non-token-cache file", () => {
    const path = join(dir, "package.json");
    writeFileSync(path, JSON.stringify({ name: "important" }));
    expect(() => writeTokens(path, record)).toThrow(/not a sidestep token cache/i);
    // The original file is untouched.
    expect(JSON.parse(readFileSync(path, "utf8")).name).toBe("important");
  });

  it("overwrites an existing token cache in place", () => {
    const path = join(dir, "auth.json");
    writeTokens(path, record);
    writeTokens(path, { ...record, access_token: "acc2" });
    expect(readTokens(path)?.access_token).toBe("acc2");
  });

  it("resolveAuthFilePath honors flag > env > --local > default (global)", () => {
    // An explicit --config wins over everything, including --local.
    const flag = parseArgs(["push", "--config", "/tmp/flag.json", "--local"]);
    expect(resolveAuthFilePath(flag)).toBe("/tmp/flag.json");

    // $XANO_CONFIG wins over --local too.
    process.env.XANO_CONFIG = "/tmp/env.json";
    expect(resolveAuthFilePath(parseArgs(["push", "--local"]))).toBe("/tmp/env.json");
    delete process.env.XANO_CONFIG;

    // --local (no explicit path) resolves the project-local cache.
    const loc = resolveAuthFilePath(parseArgs(["push", "--local"]), "write");
    expect(loc.endsWith(join(".xano", "auth.json"))).toBe(true);

    // The default (write mode) is now the shared global cache.
    process.env.XANO_GLOBAL_CONFIG = join(dir, "global-auth.json");
    expect(resolveAuthFilePath(parseArgs(["push"]), "write")).toBe(join(dir, "global-auth.json"));
    delete process.env.XANO_GLOBAL_CONFIG;
  });

  it("read mode prefers the project-local cache, then falls back to the global one", () => {
    const cwd = process.cwd();
    const globalPath = join(dir, "global", "auth.json");
    const localDir = join(dir, "project");
    mkdirSync(localDir, { recursive: true });
    process.env.XANO_GLOBAL_CONFIG = globalPath;
    try {
      process.chdir(localDir);
      // Compute the local path from the realpath-resolved cwd (macOS maps
      // /var/folders → /private/var/folders), matching what resolve() returns.
      const localPath = join(process.cwd(), ".xano", "auth.json");

      // Neither exists yet → return the global path (the default) so errors
      // point at the conventional shared location.
      expect(resolveAuthFilePath(parseArgs(["push"]))).toBe(globalPath);

      // Only the global cache exists → use it.
      writeTokens(globalPath, record);
      expect(resolveAuthFilePath(parseArgs(["push"]))).toBe(globalPath);

      // A project-local cache takes precedence over the global one.
      writeTokens(localPath, record);
      expect(resolveAuthFilePath(parseArgs(["push"]))).toBe(localPath);

      // …but an explicit --local always targets the project cache.
      expect(resolveAuthFilePath(parseArgs(["push", "--local"]))).toBe(localPath);
    } finally {
      process.chdir(cwd);
    }
  });

  describe("ensureGitignored", () => {
    beforeEach(() => {
      // Make `dir` look like a repo root.
      mkdirSync(join(dir, ".git"));
    });

    it("appends `.xano/` when the default cache dir is not yet ignored", () => {
      const path = join(dir, ".xano", "auth.json");
      const changed = ensureGitignored(path);
      expect(changed).toBe(true);
      expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".xano/");
    });

    it("is a no-op when the entry already exists", () => {
      writeFileSync(join(dir, ".gitignore"), "node_modules/\n.xano/\n");
      const changed = ensureGitignored(join(dir, ".xano", "auth.json"));
      expect(changed).toBe(false);
    });

    it("matches an existing entry that lacks the trailing slash", () => {
      writeFileSync(join(dir, ".gitignore"), ".xano\n");
      expect(ensureGitignored(join(dir, ".xano", "auth.json"))).toBe(false);
    });

    it("creates .gitignore when the project has none", () => {
      expect(existsSync(join(dir, ".gitignore"))).toBe(false);
      ensureGitignored(join(dir, ".xano", "auth.json"));
      expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    });

    it("ignores the bare filename for a root-level custom auth file", () => {
      ensureGitignored(join(dir, "mytoken.json"));
      expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("mytoken.json");
    });

    it("does nothing for a token file outside the repo tree", () => {
      const outside = join(tmpdir(), "sidestep-outside-auth.json");
      expect(ensureGitignored(outside)).toBe(false);
    });
  });
});
