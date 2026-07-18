import { describe, it, expect, afterEach } from "vitest";
import "../../src/index.js"; // register kinds + statements
import { createHash } from "node:crypto";
import { deriveGuid, resolveRef } from "../../src/refs/guid.js";
import {
  seedLockOverrides,
  resetLockOverrides,
  isLockSeeded,
  getLockedGuid,
  getLockedCanonical,
} from "../../src/lock/store.js";
import { LOCK_VERSION, type LockFile } from "../../src/lock/lock.js";
import { functionRun } from "../../src/statements/special/calls.js";
import { encodeStatement } from "../../src/statements/statement.js";
import { f } from "../../src/fields/catalog.js";

const PINNED = "0123456789abcdef0123456789abcdef";

function lockWith(objects: LockFile["objects"]): LockFile {
  return { version: LOCK_VERSION, objects };
}

function md5(seed: string): string {
  return createHash("md5").update(seed).digest("hex");
}

afterEach(() => resetLockOverrides());

describe("lock override store", () => {
  it("deriveGuid returns the seeded guid instead of the md5 derivation", () => {
    seedLockOverrides(lockWith({ "function:renamed": { guid: PINNED } }));
    expect(deriveGuid("function", "renamed")).toBe(PINNED);
    expect(deriveGuid("function", "renamed")).not.toBe(md5("function:renamed"));
  });

  it("a store miss falls back to the md5 derivation unchanged", () => {
    seedLockOverrides(lockWith({ "function:other": { guid: PINNED } }));
    expect(deriveGuid("function", "plain")).toBe(md5("function:plain"));
  });

  it("an unseeded store leaves derivation untouched", () => {
    expect(isLockSeeded()).toBe(false);
    expect(deriveGuid("function", "plain")).toBe(md5("function:plain"));
  });

  it("an explicit guid on a def handle still wins over the store", () => {
    seedLockOverrides(lockWith({ "function:target": { guid: PINNED } }));
    expect(resolveRef("function", { name: "target", guid: "explicit-guid" })).toBe(
      "explicit-guid",
    );
    // The bare-name path resolves through the store.
    expect(resolveRef("function", "target")).toBe(PINNED);
  });

  it("survives a second module realm (fresh Symbol.for lookup, no module state)", () => {
    seedLockOverrides(lockWith({ "dbo:users": { guid: PINNED } }));
    // Simulate what another realm's copy of the store module does: a fresh
    // globalThis lookup through the shared symbol registry.
    const store = (globalThis as Record<symbol, unknown>)[
      Symbol.for("sidestep.lock.overrides")
    ] as { entries: Map<string, { guid?: string }> };
    expect(store.entries.get("dbo:users")?.guid).toBe(PINNED);
  });

  it("reset clears overrides; seed→reset→seed follows the one-workspace contract", () => {
    seedLockOverrides(lockWith({ "function:a": { guid: PINNED } }));
    expect(isLockSeeded()).toBe(true);
    resetLockOverrides();
    expect(isLockSeeded()).toBe(false);
    expect(deriveGuid("function", "a")).toBe(md5("function:a"));
    const other = "f".repeat(32);
    seedLockOverrides(lockWith({ "function:a": { guid: other } }));
    expect(deriveGuid("function", "a")).toBe(other);
  });

  it("exposes locked canonicals through the sibling accessor", () => {
    seedLockOverrides(
      lockWith({ "app:public": { guid: PINNED, canonical: "AbC12dEf" }, workspace: { canonical: "WsTok" } }),
    );
    expect(getLockedCanonical("app:public")).toBe("AbC12dEf");
    expect(getLockedCanonical("workspace")).toBe("WsTok");
    expect(getLockedGuid("app:public")).toBe(PINNED);
    expect(getLockedCanonical("app:missing")).toBeUndefined();
  });

  it("statement factories and f.tableRef both emit the seeded guid (string-embedded agreement)", () => {
    const fnGuid = "1".repeat(32);
    const tableGuid = "2".repeat(32);
    seedLockOverrides(
      lockWith({ "function:sayHello": { guid: fnGuid }, "dbo:users": { guid: tableGuid } }),
    );
    // Statement factory: the call context carries the locked guid.
    const stmt = encodeStatement(functionRun({ fn: "sayHello" })) as {
      context: { function: { id: string } };
    };
    expect(stmt.context.function.id).toBe(fnGuid);
    // Field def: the locked guid lands INSIDE the `dbo=<guid>` method-arg string.
    const col = f.tableRef("users") as {
      options: { methods?: Array<{ name: string; arg: string[] }> };
    };
    const at = col.options.methods?.find((m) => m.name === "@");
    expect(at?.arg).toEqual([`dbo=${tableGuid}`]);
  });
});
