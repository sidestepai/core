/**
 * U4 — reference index and guid identity preservation.
 *
 * Note what the natural corpus cannot prove here. Every guid in `test/fixtures/`
 * and in `examples/sandbox/` is SideStep-authored, so it already equals
 * `md5(type:name)` — a decoder that *derived* guids instead of preserving the
 * stored ones would pass every one of those assertions while silently rewriting
 * identity on a real workspace. `engine-guids-bundle.json` exists to fail that
 * implementation: its guids are engine-style random values that no derivation
 * reproduces.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DecodeContext } from "../../src/codegen/context.js";
import { printExpr } from "../../src/codegen/print.js";
import { RefIndex, resolveReference } from "../../src/codegen/ref-index.js";
import { deriveGuid, resolveRef } from "../../src/refs/guid.js";
import { seedLockOverrides, resetLockOverrides } from "../../src/lock/store.js";
import { LOCK_VERSION } from "../../src/lock/lock.js";
import { workspace, defineFunction } from "../../src/index.js";

const ENGINE_BUNDLE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/codegen/engine-guids-bundle.json", import.meta.url)),
    "utf8",
  ),
) as { payload: Record<string, unknown> };

/** Build an index over a payload, returning it with the context that recorded problems. */
function index(payload: Record<string, unknown>): { index: RefIndex; ctx: DecodeContext } {
  const ctx = new DecodeContext();
  return { index: RefIndex.fromPayload(payload, ctx), ctx };
}

describe("RefIndex", () => {
  it("resolves a function's callee guid to that function's name and kind", () => {
    const { index: refs } = index(ENGINE_BUNDLE.payload);
    expect(refs.lookup("2b6d05f1c8e94a37bb1f6d0c5a83e742")).toMatchObject({
      kind: "function",
      name: "load_author",
      payloadKey: "function",
    });
  });

  it("resolves a dbo guid referenced from a db statement to the table", () => {
    const { index: refs } = index(ENGINE_BUNDLE.payload);
    expect(refs.lookup("9f3c81a04be27d6510aa4c8831ef25b7")).toMatchObject({
      kind: "table",
      name: "users",
      payloadKey: "dbo",
    });
  });

  it("splits same-named mcp_server and agent entries sharing the toolset payload key", () => {
    const { index: refs } = index(ENGINE_BUNDLE.payload);
    expect(refs.lookup("e51c9a730b6d2f48ac07153bd8e69f21")).toMatchObject({
      kind: "mcp_server",
      name: "support",
    });
    expect(refs.lookup("48b207ec5f139da6c2e480b1573f9ac0")).toMatchObject({
      kind: "agent",
      name: "support",
    });
  });

  it("indexes tools from the tool payload key, not the toolset one", () => {
    const { index: refs } = index(ENGINE_BUNDLE.payload);
    expect(refs.lookup("1d6f84b0937ea52c48bd0f371c9a5e26")).toMatchObject({
      kind: "tool",
      payloadKey: "tool",
      name: "lookup_user",
    });
  });

  it("does not collide two objects of different kinds sharing a name", () => {
    const { index: refs } = index({
      function: [{ name: "shared", guid: "aaaa000000000000000000000000aaaa" }],
      dbo: [{ name: "shared", guid: "bbbb000000000000000000000000bbbb" }],
    });
    expect(refs.lookup("aaaa000000000000000000000000aaaa")!.kind).toBe("function");
    expect(refs.lookup("bbbb000000000000000000000000bbbb")!.kind).toBe("table");
  });

  it("reports an object with a missing or empty guid instead of deriving one", () => {
    const { index: refs, ctx } = index({ function: [{ name: "no_guid" }, { name: "", guid: "" }] });
    expect(refs.all()).toEqual([]);
    expect(ctx.report.entries).toHaveLength(2);
    expect(ctx.report.entries.every((e) => e.category === "unresolved-ref")).toBe(true);
    expect(ctx.report.entries[0]!.detail).toContain("no_guid");
  });

  it("reports a toolset entry whose stored type discriminates to neither kind", () => {
    const { ctx } = index({
      toolset: [{ name: "mystery", guid: "cccc000000000000000000000000cccc", type: "future" }],
    });
    expect(ctx.report.entries[0]!.detail).toContain("mystery");
  });

  // KTD-7's failure mode, made testable: these guids are engine-random, so an
  // implementation that derives md5(type:name) produces different values here.
  it("preserves engine-random guids that no derivation would reproduce", () => {
    const { index: refs } = index(ENGINE_BUNDLE.payload);
    for (const object of refs.all()) {
      expect(object.guid).not.toBe(deriveGuid(object.payloadKey, object.name));
    }
    expect(refs.all().length).toBeGreaterThan(5);
  });
});

describe("explicit guid vs a seeded xano.lock", () => {
  // A generated tree carries engine guids explicitly, and may be compiled in a
  // process that has also seeded a lock — two identity sources at once. The
  // explicit guid has to win on BOTH sides (the emitted object and every
  // reference to it), or a pulled workspace's references stop agreeing with
  // their targets the moment a lock is present.
  const LOCKED_GUID = "0000000000000000000000000000dead";
  const ENGINE_GUID = "2b6d05f1c8e94a37bb1f6d0c5a83e742";

  beforeEach(() => {
    seedLockOverrides({
      version: LOCK_VERSION,
      objects: { "function:load_author": { guid: LOCKED_GUID } },
    });
  });
  afterEach(() => resetLockOverrides());

  it("uses the explicit guid for the emitted object, not the locked one", () => {
    const app = workspace("lock_precedence").registerFunctions([
      defineFunction({ name: "load_author", guid: ENGINE_GUID, stack: [] }),
    ]);
    const emitted = app.export().payload.function as Array<{ guid: string }>;
    expect(emitted[0]!.guid).toBe(ENGINE_GUID);
  });

  it("uses the explicit guid for a reference to it, not the locked one", () => {
    expect(resolveRef("function", { name: "load_author", guid: ENGINE_GUID })).toBe(ENGINE_GUID);
  });

  it("still falls back to the lock when no explicit guid is present", () => {
    expect(resolveRef("function", "load_author")).toBe(LOCKED_GUID);
  });
});

describe("resolveReference", () => {
  const { index: refs } = index(ENGINE_BUNDLE.payload);
  const callee = "2b6d05f1c8e94a37bb1f6d0c5a83e742";

  it("emits a symbol reference when project assembly supplies one", () => {
    const ctx = new DecodeContext();
    expect(printExpr(resolveReference(ctx, refs, callee, { symbolFor: (t) => t.name }))).toBe(
      "load_author",
    );
    expect(ctx.report.entries).toEqual([]);
  });

  it("degrades to a {name, guid} literal when a symbol would create a cycle", () => {
    const ctx = new DecodeContext();
    expect(printExpr(resolveReference(ctx, refs, callee, { symbolFor: () => null }))).toBe(
      ['{', '  name: "load_author",', `  guid: "${callee}",`, '}'].join("\n"),
    );
    expect(ctx.report.entries).toEqual([]);
  });

  it("emits a {name, guid} literal by default, with no symbol source", () => {
    const ctx = new DecodeContext();
    expect(printExpr(resolveReference(ctx, refs, callee))).toContain(callee);
  });

  it("preserves the literal guid and reports when the target is absent", () => {
    const ctx = new DecodeContext();
    const missing = "ffffffffffffffffffffffffffffffff";
    expect(printExpr(resolveReference(ctx, refs, missing))).toBe(`"${missing}"`);
    expect(ctx.report.entries).toHaveLength(1);
    expect(ctx.report.entries[0]!.category).toBe("unresolved-ref");
    expect(ctx.report.entries[0]!.detail).toContain(missing);
  });

  it("separates a `guid 0` from a guid that is merely missing", () => {
    // 219 of the 220 misses in the survey corpus are `0` — an internal row id
    // standing where portable identity belongs, which no bundle could contain.
    // Sharing one category made `unresolved-ref` mean "unsafe to act on" for a
    // pile of rows where nothing was wrong and nothing could be done.
    const zero = new DecodeContext();
    expect(printExpr(resolveReference(zero, refs, "0"))).toBe('"0"');
    expect(zero.report.entries[0]!.category).toBe("unportable-id");
    expect(zero.report.entries[0]!.detail).toContain("internal row id");

    // The load-bearing negative: a real miss keeps error severity. A `0` guard
    // written as "anything falsy" or "anything short" would swallow this too.
    const real = new DecodeContext();
    resolveReference(real, refs, "00000000000000000000000000000000");
    expect(real.report.entries[0]!.category).toBe("unresolved-ref");
  });
});
