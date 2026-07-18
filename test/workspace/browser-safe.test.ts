/**
 * Proves the public `@sidestep/core` entry (`dist/index.js`) is browser-safe: a
 * frontend can import a query and call `getPath()` without dragging Node built-
 * ins (`node:fs`, `node:crypto`) into the bundle. Regression guard for the
 * bundler failure `Could not resolve "crypto"/"fs"`.
 *
 * Bundles the BUILT dist with esbuild targeting the browser — a successful
 * bundle IS the assertion (esbuild errors on unresolved node builtins for a
 * browser target). The complementary case confirms the `/node` entry still
 * legitimately depends on `fs`, so the split is real.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const distIndex = join(repoRoot, "dist", "index.js");
const distNode = join(repoRoot, "dist", "node.js");

async function bundleForBrowser(entrySource: string): Promise<{ ok: boolean; error?: string; outfile: string }> {
  const dir = mkdtempSync(join(tmpdir(), "sidestep-browser-"));
  const entry = join(dir, "entry.mjs");
  const outfile = join(dir, "out.mjs");
  writeFileSync(entry, entrySource);
  try {
    await build({ entryPoints: [entry], bundle: true, platform: "browser", format: "esm", outfile, logLevel: "silent" });
    return { ok: true, outfile };
  } catch (e) {
    return { ok: false, error: (e as Error).message, outfile };
  } finally {
    // Leave outfile for the caller to import; caller removes dir.
  }
}

describe("@sidestep/core is browser-safe", () => {
  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "ignore" });
    expect(existsSync(distIndex)).toBe(true);
  }, 120_000);

  it("bundles a query + getPath() for the browser and returns the right path", async () => {
    // The query binds a table via f.tableRef → resolveRef → deriveGuid (md5),
    // exercising the pure-JS hash on the browser code path.
    const res = await bundleForBrowser(
      `import { workspace, apiGroup, query, table, f, input } from ${JSON.stringify(distIndex)};\n` +
        `const users = table({ name: "user", auth: true, schema: { email: f.email() } });\n` +
        `const tweets = table({ name: "tweet", schema: { author: f.tableRef(users), body: f.text() } });\n` +
        `const g = apiGroup({ name: "twitter", canonical: "tw01" });\n` +
        `const list = query({ name: "list_tweets", verb: "GET", apiGroup: g, input: { limit: input.int() } });\n` +
        `export const PATH = list.getPath();\n` +
        `export const VERB = list.verb;\n`,
    );
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    const mod = await import(pathToFileURL(res.outfile).href);
    expect(mod.PATH).toBe("/api:tw01/list_tweets");
    expect(mod.VERB).toBe("GET");
    rmSync(join(res.outfile, ".."), { recursive: true, force: true });
  });

  it("the /node entry legitimately depends on node:fs (the split is real)", async () => {
    const res = await bundleForBrowser(
      `import { writeBundle } from ${JSON.stringify(distNode)};\n` + `export default writeBundle;\n`,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Could not resolve "fs"|node:fs/);
    rmSync(join(res.outfile, ".."), { recursive: true, force: true });
  });
});
