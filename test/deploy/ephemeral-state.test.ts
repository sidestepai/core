import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readEphemeralState,
  getEnvironment,
  setEnvironment,
  clearEnvironment,
  ephemeralStatePath,
  type EphemeralRecord,
} from "../../src/deploy/ephemeral-state.js";

let dir: string;
const rec = (name: string): EphemeralRecord => ({
  name,
  display: name.toUpperCase(),
  url: `https://${name}.xano.io`,
  expires_at: "2026-07-24 20:49:15+0000",
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sidestep-eph-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ephemeral-state", () => {
  it("writes then reads a record back verbatim", () => {
    setEnvironment(dir, 114, rec("e4f2"));
    expect(getEnvironment(readEphemeralState(dir), 114)).toEqual(rec("e4f2"));
  });

  it("keeps records for different workspaces independent", () => {
    setEnvironment(dir, 114, rec("aaa"));
    setEnvironment(dir, 200, rec("bbb"));
    const state = readEphemeralState(dir);
    expect(getEnvironment(state, 114)?.name).toBe("aaa");
    expect(getEnvironment(state, 200)?.name).toBe("bbb");
  });

  it("getEnvironment returns undefined for an absent workspace", () => {
    expect(getEnvironment(readEphemeralState(dir), 999)).toBeUndefined();
  });

  it("clearEnvironment removes only the target workspace", () => {
    setEnvironment(dir, 114, rec("aaa"));
    setEnvironment(dir, 200, rec("bbb"));
    expect(clearEnvironment(dir, 114)).toBe(true);
    const state = readEphemeralState(dir);
    expect(getEnvironment(state, 114)).toBeUndefined();
    expect(getEnvironment(state, 200)?.name).toBe("bbb");
  });

  it("clearEnvironment returns false when nothing is tracked", () => {
    expect(clearEnvironment(dir, 114)).toBe(false);
  });

  it("returns empty state for a missing file (no throw)", () => {
    expect(readEphemeralState(dir)).toEqual({ version: 1, environments: {} });
  });

  it("returns empty state for a corrupt file (no throw, recreatable)", () => {
    mkdirSync(join(dir, ".xano"), { recursive: true });
    writeFileSync(ephemeralStatePath(dir), "{ not json", "utf8");
    expect(readEphemeralState(dir)).toEqual({ version: 1, environments: {} });
    // still writable afterwards
    setEnvironment(dir, 1, rec("z"));
    expect(getEnvironment(readEphemeralState(dir), 1)?.name).toBe("z");
  });

  it("creates .xano/ and gitignores it when the dir is a git root", () => {
    mkdirSync(join(dir, ".git"), { recursive: true }); // make `dir` look like a repo root
    setEnvironment(dir, 114, rec("aaa"));
    expect(existsSync(ephemeralStatePath(dir))).toBe(true);
    const gi = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(gi).toMatch(/\.xano\//);
  });
});
