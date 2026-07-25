import { describe, it, expect, vi, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { run } from "../../src/emit/cli.js";

/** Capture everything a command writes to stdout during `fn()`. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return out;
}

const resolvedEntry = fileURLToPath(new URL("../fixtures/paths-workspace/index.ts", import.meta.url));
const noCanonEntry = fileURLToPath(new URL("../fixtures/paths-no-canonical/index.ts", import.meta.url));
const fnModule = fileURLToPath(new URL("../fixtures/function-module.ts", import.meta.url));

describe("sidestep paths", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists each query's verb + resolved api:<canonical>/<name> (in-code canonical, no lock)", async () => {
    const out = await captureStdout(() => run(["paths", resolvedEntry]));
    // Both queries, with their real verbs and the /api:<canonical>/<name> path.
    expect(out).toMatch(/GET\s+\/api:abc12345\/links\.list\s+api:abc12345\/links\.list/);
    expect(out).toMatch(/POST\s+\/api:abc12345\/links\.create\s+api:abc12345\/links\.create/);
    // The leading slash on "/links.create" is stripped in the emitted path.
    expect(out).not.toContain("/api:abc12345//links.create");
  });

  it("distinct verbs are preserved and rows are sorted by path", async () => {
    const out = await captureStdout(() => run(["paths", resolvedEntry]));
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(2);
    // Sorted by (canonical, name): links.create before links.list.
    expect(lines[0]).toContain("links.create");
    expect(lines[1]).toContain("links.list");
  });

  it("`routes` is an alias producing identical output", async () => {
    const viaPaths = await captureStdout(() => run(["paths", resolvedEntry]));
    const viaRoutes = await captureStdout(() => run(["routes", resolvedEntry]));
    expect(viaRoutes).toBe(viaPaths);
  });

  it("errors with the export --lock fix when a canonical can't resolve", async () => {
    await expect(run(["paths", noCanonEntry])).rejects.toThrow(/export --lock/);
    await expect(run(["paths", noCanonEntry])).rejects.toThrow(/links\.list/);
  });

  it("rejects a module that does not default-export a Xano registry", async () => {
    await expect(run(["paths", fnModule])).rejects.toThrow(/must default-export a Xano/);
  });
});
