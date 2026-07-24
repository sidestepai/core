import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNewer, resolveUpdateNotice } from "../../src/emit/update-check.js";

describe("isNewer (dependency-free semver compare)", () => {
  it("compares release versions by x.y.z", () => {
    expect(isNewer("3.10.0", "3.9.25")).toBe(true);
    expect(isNewer("3.9.25", "3.10.0")).toBe(false);
    expect(isNewer("4.0.0", "3.99.99")).toBe(true);
    expect(isNewer("3.9.25", "3.9.25")).toBe(false);
  });

  it("treats a release as newer than a prerelease of the same x.y.z", () => {
    expect(isNewer("3.10.0", "3.10.0-beta.1")).toBe(true);
    expect(isNewer("3.10.0-beta.1", "3.10.0")).toBe(false);
  });

  it("does not nag a prerelease user to 'upgrade' to an older release", () => {
    // On 3.10.0-beta.2, npm's `latest` (3.9.25) is NOT an upgrade.
    expect(isNewer("3.9.25", "3.10.0-beta.2")).toBe(false);
  });

  it("orders prerelease identifiers per semver", () => {
    expect(isNewer("3.10.0-beta.2", "3.10.0-beta.1")).toBe(true);
    expect(isNewer("3.10.0-beta.10", "3.10.0-beta.2")).toBe(true); // numeric, not lexical
    expect(isNewer("3.10.0-rc.1", "3.10.0-beta.1")).toBe(true); // rc > beta lexically
  });

  it("returns false for unparseable versions (e.g. 'unknown', git builds)", () => {
    expect(isNewer("unknown", "3.9.25")).toBe(false);
    expect(isNewer("3.10.0", "unknown")).toBe(false);
  });
});

describe("resolveUpdateNotice (cache + fetch)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidestep-update-"));
    process.env.SIDESTEP_UPDATE_CACHE = join(dir, "update-check.json");
    // A real (mocked) registry URL keeps fetch off the network in every branch.
    process.env.SIDESTEP_UPDATE_REGISTRY = "https://registry.example/latest";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SIDESTEP_UPDATE_CACHE;
    delete process.env.SIDESTEP_UPDATE_REGISTRY;
  });

  const mockFetch = (version: string) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ version }), { status: 200 }),
    );

  it("fetches, caches, and reports an available upgrade", async () => {
    const spy = mockFetch("3.10.0");
    const notice = await resolveUpdateNotice({ current: "3.9.25", force: true });
    expect(notice).toEqual({ current: "3.9.25", latest: "3.10.0" });
    expect(spy).toHaveBeenCalledOnce();

    const cache = JSON.parse(readFileSync(process.env.SIDESTEP_UPDATE_CACHE!, "utf8"));
    expect(cache.latest).toBe("3.10.0");
    expect(typeof cache.checkedAt).toBe("number");
  });

  it("returns null when already up to date", async () => {
    mockFetch("3.9.25");
    const notice = await resolveUpdateNotice({ current: "3.9.25", force: true });
    expect(notice).toBeNull();
  });

  it("serves a fresh cache without hitting the network", async () => {
    writeFileSync(
      process.env.SIDESTEP_UPDATE_CACHE!,
      JSON.stringify({ latest: "3.10.0", checkedAt: Date.now() }),
    );
    const spy = vi.spyOn(globalThis, "fetch");
    const notice = await resolveUpdateNotice({ current: "3.9.25", force: true });
    expect(notice).toEqual({ current: "3.9.25", latest: "3.10.0" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("re-fetches once the cache is stale (>24h)", async () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    writeFileSync(
      process.env.SIDESTEP_UPDATE_CACHE!,
      JSON.stringify({ latest: "3.9.0", checkedAt: twoDaysAgo }),
    );
    const spy = mockFetch("3.11.0");
    const notice = await resolveUpdateNotice({ current: "3.9.25", force: true });
    expect(notice).toEqual({ current: "3.9.25", latest: "3.11.0" });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("falls back to the stale cached latest when the fetch fails", async () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    writeFileSync(
      process.env.SIDESTEP_UPDATE_CACHE!,
      JSON.stringify({ latest: "3.10.0", checkedAt: twoDaysAgo }),
    );
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const notice = await resolveUpdateNotice({ current: "3.9.25", force: true });
    expect(notice).toEqual({ current: "3.9.25", latest: "3.10.0" });
  });

  it("stays silent (and skips the network) for an unknown current version", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const notice = await resolveUpdateNotice({ current: "unknown", force: true });
    expect(notice).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("respects the opt-out env var when not forced", async () => {
    process.env.SIDESTEP_NO_UPDATE_CHECK = "1";
    try {
      const spy = vi.spyOn(globalThis, "fetch");
      const notice = await resolveUpdateNotice({ current: "3.9.25" });
      expect(notice).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      delete process.env.SIDESTEP_NO_UPDATE_CHECK;
    }
  });
});
