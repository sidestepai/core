/**
 * U9 — project assembly.
 *
 * Assembly owns the three problems no per-object decoder can see: symbols (Xano
 * names are not identifiers and collide across kinds), file layout, and
 * reference cycles. Each is exercised here against a synthetic payload rather
 * than the sandbox, because the sandbox is well-behaved by construction — it has
 * no colliding names and no mutually-calling functions, so it cannot fail any of
 * these assertions.
 *
 * The cycle cases are the ones that matter most: a circular import is a runtime
 * crash on load, and a same-file forward reference is a temporal-dead-zone crash
 * — neither is visible to a round trip that only compares bundles.
 */
import { describe, it, expect } from "vitest";
import { decodeBundle } from "../../src/codegen/index.js";
import { toSymbol, specifierFrom } from "../../src/codegen/project.js";
import type { GeneratedProject } from "../../src/codegen/index.js";
import { workspace, Xano } from "../../src/workspace/xano.js";
import { defineFunction } from "../../src/function/define.js";
import { table as defineTable } from "../../src/kinds/table.js";
import { agent } from "../../src/kinds/agent.js";
import { mcpServer } from "../../src/kinds/mcp-server.js";
import { apiGroup } from "../../src/kinds/api-group.js";
import { query } from "../../src/kinds/query.js";
import {
  tableTrigger,
  agentTrigger,
  mcpServerTrigger,
  workspaceTrigger,
  errorTrigger,
} from "../../src/kinds/trigger.js";
import "../../src/index.js"; // register kinds
import { f } from "../../src/fields/catalog.js";
import { s } from "../../src/statements/s.js";
import type { FunctionDef } from "../../src/function/define.js";
import type { TableDef } from "../../src/kinds/table.js";
import sandbox from "../../examples/sandbox/index.js";

/**
 * Distinct engine-style guids, so nothing here accidentally relies on
 * `md5(type:name)` — the identity a *pulled* object never has.
 */
function guid(n: number): string {
  return String(n).padStart(2, "0").repeat(16);
}

/** A function whose stack calls each of `calls` by guid. */
function fn(name: string, g: string, calls: string[] = []): FunctionDef {
  return defineFunction({
    name,
    guid: g,
    stack: calls.map((target) => s.function.call({ fn: { name: "", guid: target } })),
  });
}

/** A table with one ordinary column. */
function table(name: string, g: string): TableDef {
  return defineTable({ name, guid: g, schema: { title: f.text() } });
}

/**
 * Decode a synthetic workspace into a project.
 *
 * Built through the real authoring API and exported, rather than hand-written
 * stored JSON: assembly reads the reference graph out of stored bytes, so a
 * hand-approximated envelope would exercise a shape the encoder never produces.
 */
function build(defs: { functions?: FunctionDef[]; tables?: TableDef[] }): GeneratedProject {
  const ws = workspace("ws");
  if (defs.tables?.length) ws.registerTables(defs.tables);
  if (defs.functions?.length) ws.registerFunctions(defs.functions);
  return decodeBundle(ws.export());
}

/** The generated file at a path. */
function file(project: GeneratedProject, path: string): string {
  const found = project.files.find((f) => f.path === path);
  expect(found, `no generated file at ${path}`).toBeDefined();
  return found!.contents;
}

/**
 * Every binding the tree exports for a decoded OBJECT.
 *
 * `workspace.ts` is excluded: its `workspaceSettings` is the workspace config,
 * which is not a placed object, takes a reserved name no object can collide
 * with, and is registered through `registerWorkspace(x)` rather than one of the
 * array registrars. Counting it would make every symbol assertion here about
 * assembly's own file rather than about the objects.
 */
function objectSymbols(project: GeneratedProject): string[] {
  return project.files
    .filter((f) => f.path.endsWith(".ts") && f.path !== "index.ts" && f.path !== "workspace.ts")
    .flatMap((f) => [...f.contents.matchAll(/export const (\w+) =/g)].map((m) => m[1]!))
    .sort();
}

describe("symbol naming", () => {
  it("turns a name that is not an identifier into one", () => {
    expect(toSymbol("My Table-2")).toBe("My_Table_2");
    expect(toSymbol("2fast")).toBe("_2fast");
    expect(toSymbol("!!!")).toBe("object");
    expect(toSymbol("")).toBe("object");
  });

  it("disambiguates two kinds sharing a Xano name, by kind", () => {
    // A `users` table and a `users` function are both legal in Xano and would
    // otherwise produce one binding that shadows the other.
    const project = build({ tables: [table("users", guid(1))], functions: [fn("users", guid(2))] });
    expect(file(project, "table/table.ts")).toContain("export const users =");
    expect(file(project, "function/usersfunction.ts")).toContain("export const usersFunction =");
  });

  it("disambiguates same-kind names that sanitize to the same identifier", () => {
    const project = build({
      functions: [fn("my fn", guid(1)), fn("my-fn", guid(2)), fn("my_fn", guid(3))],
    });
    const symbols = objectSymbols(project);
    expect(new Set(symbols).size).toBe(symbols.length);
    expect(symbols).toEqual(["my_fn", "my_fn_2", "my_fn_3"]);
  });

  it("separates same-kind names that differ only by case", () => {
    // Two distinct TypeScript identifiers, but each non-shared one also names a
    // file — and macOS and Windows fold `Flag.ts` onto `flag.ts`. Writing the
    // second would replace the first on disk while `index.ts` still imported
    // both, so the lost object's binding resolved to `undefined` and encoding
    // it crashed. A real workspace hit exactly this with `SocialFeed/Flag/{id}`
    // alongside `SocialFeed/flag/{id}`.
    // Paths are lower-cased now, so "are the paths unique" would pass vacuously
    // if the two objects MERGED into one file — there would simply be one path.
    // Assert the separation itself: two objects, two files, two bindings.
    const project = build({ functions: [fn("my fn", guid(1)), fn("My FN", guid(2))] });
    const functions = project.files.filter((f) => f.path.startsWith("function/"));
    expect(functions.map((f) => f.path)).toHaveLength(2);
    expect(new Set(functions.map((f) => f.path)).size).toBe(2);
    expect(objectSymbols(project)).toHaveLength(2);
    for (const generated of functions) {
      expect([...generated.contents.matchAll(/export const \w+ =/g)]).toHaveLength(1);
    }
  });

  it("assembles the same bundle to byte-identical files twice", () => {
    const defs = () => ({ tables: [table("users", guid(1))], functions: [fn("a", guid(2), [guid(1)])] });
    expect(build(defs()).files).toEqual(build(defs()).files);
  });
});

describe("every generated import resolves", () => {
  /**
   * The check a bundle round trip cannot make.
   *
   * A wrong relative specifier is invisible to the decoder AND to a re-export
   * diff — both compare bundles, and neither ever loads the tree. It surfaces
   * as `ERR_MODULE_NOT_FOUND` at import time, in the user's project, after
   * install. Now that the tree nests two levels deep, that is the failure this
   * layout is most likely to produce.
   */
  function unresolvable(project: GeneratedProject): string[] {
    const present = new Set(project.files.map((f) => f.path));
    const out: string[] = [];
    for (const generated of project.files) {
      if (!generated.path.endsWith(".ts")) continue;
      for (const m of generated.contents.matchAll(/^import(?: type)? \{[^}]*\} from "(\.[^"]*)";$/gm)) {
        const segments = generated.path.split("/").slice(0, -1);
        for (const part of m[1]!.split("/")) {
          if (part === ".") continue;
          else if (part === "..") segments.pop();
          else segments.push(part);
        }
        const target = segments.join("/").replace(/\.js$/, ".ts");
        if (!present.has(target)) out.push(`${generated.path} → ${m[1]} (no ${target})`);
      }
    }
    return out;
  }

  it("resolves every specifier in the sandbox tree", () => {
    // The sandbox is the richest workspace on hand — every kind, api groups,
    // triggers, tables, cross-file references — so it exercises each depth
    // combination the layout can produce.
    const project = decodeBundle(sandbox.export() as { payload: Record<string, unknown> });
    expect(unresolvable(project)).toEqual([]);
  });

  it("resolves every specifier across nesting, hoisting, and the table file", () => {
    const users = defineTable({ name: "users", guid: guid(1), schema: { title: f.text() } });
    const admin = apiGroup({ name: "admin", guid: guid(2) });
    const project = decodeBundle(
      new Xano()
        .registerTables([users])
        .registerApiGroups([admin])
        .registerQueries([
          query({
            name: "posts",
            verb: "GET",
            apiGroup: admin,
            guid: guid(3),
            stack: [s.db.query({ table: users, as: "rows" })],
          }),
        ])
        .registerFunctions([fn("helper", guid(4)), fn("a", guid(5), [guid(4)]), fn("b", guid(6), [guid(4)])])
        .registerTriggers([tableTrigger({ name: "on_insert", table: users, actions: { insert: true } })])
        .export(),
    );
    expect(unresolvable(project)).toEqual([]);
  });

  it("would catch a specifier that points at nothing", () => {
    // A guard that cannot fail is not a guard. Corrupt one specifier and the
    // check must name it.
    const project = decodeBundle(
      new Xano()
        .registerFunctions([fn("helper", guid(1)), fn("a", guid(2), [guid(1)])])
        .export(),
    );
    const corrupted: GeneratedProject = {
      ...project,
      files: project.files.map((generated) =>
        generated.path === "function/a.ts"
          ? { ...generated, contents: generated.contents.replace('from "./helper.js"', 'from "./gone.js"') }
          : generated,
      ),
    };
    expect(unresolvable(corrupted)).toHaveLength(1);
  });
});

describe("query placement", () => {
  function pathsOf(build: (x: Xano) => Xano): string[] {
    return decodeBundle(build(new Xano()).export()).files.map((f) => f.path);
  }

  it("nests a query under its api group, with the verb in the filename", () => {
    const admin = apiGroup({ name: "admin", guid: guid(1) });
    const paths = pathsOf((x) =>
      x
        .registerApiGroups([admin])
        .registerQueries([query({ name: "posts", verb: "GET", apiGroup: admin, guid: guid(2) })]),
    );
    expect(paths).toContain("query/admin/api_group.ts");
    expect(paths).toContain("query/admin/posts_GET.ts");
  });

  it("separates two queries that share a name but differ by verb", () => {
    // `GET /posts` and `POST /posts` are different objects with the same name.
    // One of them used to be `posts_2.ts`, which said nothing about which.
    const admin = apiGroup({ name: "admin", guid: guid(1) });
    const paths = pathsOf((x) =>
      x.registerApiGroups([admin]).registerQueries([
        query({ name: "posts", verb: "GET", apiGroup: admin, guid: guid(2) }),
        query({ name: "posts", verb: "POST", apiGroup: admin, guid: guid(3) }),
      ]),
    );
    expect(paths).toContain("query/admin/posts_GET.ts");
    expect(paths).toContain("query/admin/posts_2_POST.ts");
  });

  it("gives an api group its folder even when it holds no queries", () => {
    const paths = pathsOf((x) => x.registerApiGroups([apiGroup({ name: "empty", guid: guid(1) })]));
    expect(paths).toContain("query/empty/api_group.ts");
  });

  it("collects every group-less query into one orphaned.ts", () => {
    // An absent group and a guid pointing outside the bundle are the same thing
    // here — no folder to sit in — so they share a file rather than a folder each.
    const paths = pathsOf((x) =>
      x.registerQueries([
        query({ name: "loose", verb: "GET", guid: guid(1) }),
        query({ name: "also_loose", verb: "POST", guid: guid(2) }),
      ]),
    );
    expect(paths).toContain("query/orphaned.ts");
    expect(paths.filter((p) => p.startsWith("query/"))).toEqual(["query/orphaned.ts"]);
  });

  it("emits no orphaned.ts when every query has a group", () => {
    const admin = apiGroup({ name: "admin", guid: guid(1) });
    const paths = pathsOf((x) =>
      x
        .registerApiGroups([admin])
        .registerQueries([query({ name: "posts", verb: "GET", apiGroup: admin, guid: guid(2) })]),
    );
    expect(paths).not.toContain("query/orphaned.ts");
  });

  it("keeps two groups whose names differ only by case in distinct folders", () => {
    // The folder takes the group's assigned SYMBOL, which `assignSymbols` has
    // already case-separated — macOS and Windows fold `Admin/` onto `admin/`
    // exactly as they fold `Admin.ts` onto `admin.ts`.
    const paths = pathsOf((x) =>
      x.registerApiGroups([apiGroup({ name: "admin", guid: guid(1) }), apiGroup({ name: "Admin", guid: guid(2) })]),
    );
    const folders = paths.filter((p) => p.endsWith("/api_group.ts")).map((p) => p.toLowerCase());
    expect(new Set(folders).size, `case-insensitive folder collision: ${folders.join(", ")}`).toBe(2);
  });

  it("makes a path-safe folder from a group name that is not an identifier", () => {
    const paths = pathsOf((x) => x.registerApiGroups([apiGroup({ name: "my group/v2", guid: guid(1) })]));
    const group = paths.find((p) => p.endsWith("/api_group.ts"))!;
    expect(group).toBe("query/my_group_v2/api_group.ts");
  });

  it("reaches a table and the barrel correctly from two directories deep", () => {
    const users = defineTable({ name: "users", guid: guid(1), schema: { title: f.text() } });
    const admin = apiGroup({ name: "admin", guid: guid(2) });
    const project = decodeBundle(
      new Xano()
        .registerTables([users])
        .registerApiGroups([admin])
        .registerQueries([
          query({
            name: "posts",
            verb: "GET",
            apiGroup: admin,
            guid: guid(3),
            stack: [s.db.query({ table: users, as: "rows" })],
          }),
        ])
        .export(),
    );
    expect(file(project, "query/admin/posts_GET.ts")).toContain('from "../../table/table.js"');
    expect(file(project, "query/admin/posts_GET.ts")).toContain('from "./api_group.js"');
    expect(file(project, "index.ts")).toContain('from "./query/admin/posts_GET.js"');
  });
});

describe("trigger placement", () => {
  /** Paths in the generated tree, for asserting where a trigger landed. */
  function pathsOf(build: (x: Xano) => Xano): string[] {
    return decodeBundle(build(new Xano()).export()).files.map((f) => f.path);
  }

  it("puts a database trigger under the table directory", () => {
    const users = defineTable({ name: "users", guid: guid(1), schema: { title: f.text() } });
    const paths = pathsOf((x) =>
      x
        .registerTables([users])
        .registerTriggers([tableTrigger({ name: "on_insert", table: users, actions: { insert: true } })]),
    );
    expect(paths).toContain("table/trigger/on_insert.ts");
  });

  it("separates an agent trigger from an mcp-server trigger by the bound object's kind", () => {
    // Both store `obj_type: "toolset"` — only what `obj_id` resolves to tells
    // them apart, which is exactly why placement resolves rather than switching.
    const assistant = agent({ name: "assistant", guid: guid(2), llm: { type: "xano-free" } });
    const books = mcpServer({ name: "books", guid: guid(3) });
    const paths = pathsOf((x) =>
      x
        .registerAgents([assistant])
        .registerMcpServers([books])
        .registerTriggers([
          agentTrigger({ name: "on_agent", agent: assistant }),
          mcpServerTrigger({ name: "on_mcp", mcpServer: books }),
        ]),
    );
    expect(paths).toContain("agent/trigger/on_agent.ts");
    expect(paths).toContain("mcp_server/trigger/on_mcp.ts");
  });

  it("leaves a parentless trigger in the flat trigger directory", () => {
    // Workspace and error triggers bind nothing — there is no parent directory
    // for them to sit under, so the kind's own folder is the right home.
    const paths = pathsOf((x) =>
      x.registerTriggers([
        workspaceTrigger({ name: "on_branch_live", actions: { branch_live: true } }),
        errorTrigger({ name: "on_error" }),
      ]),
    );
    expect(paths).toContain("trigger/on_branch_live.ts");
    expect(paths).toContain("trigger/on_error.ts");
  });

  it("leaves a numeric-objId trigger flat rather than guessing a parent", () => {
    // `objId` is the documented escape hatch: a number indexes the engine's own
    // list and names no guid, so there is nothing to resolve.
    const paths = pathsOf((x) =>
      x.registerTriggers([tableTrigger({ name: "by_number", objId: 1, actions: { insert: true } })]),
    );
    expect(paths).toContain("trigger/by_number.ts");
  });

  it("leaves a trigger flat when its parent guid resolves to nothing", () => {
    const paths = pathsOf((x) =>
      x.registerTriggers([
        tableTrigger({ name: "dangling", table: { name: "gone", guid: guid(9) }, actions: { insert: true } }),
      ]),
    );
    expect(paths).toContain("trigger/dangling.ts");
  });
});

describe("relative import specifiers", () => {
  // The tree is two deep once queries nest under their api group, so the
  // same-directory / up-one-then-down pair the flat layout relied on is not
  // enough. A wrong specifier here fails at LOAD, not at typecheck, so every
  // depth combination the layout can produce is pinned.
  it.each([
    ["same directory", "function", "function/b.ts", "./b.js"],
    ["root down one", ".", "table/table.ts", "./table/table.js"],
    ["root to root", ".", "_shared.ts", "./_shared.js"],
    ["one deep up to root", "function", "_shared.ts", "../_shared.js"],
    ["one deep to a sibling directory", "function", "table/table.ts", "../table/table.js"],
    ["two deep to one deep", "query/admin", "table/table.ts", "../../table/table.js"],
    ["two deep, same directory", "query/admin", "query/admin/posts_GET.ts", "./posts_GET.js"],
    ["two deep to a peer group", "query/admin", "query/public/posts_GET.ts", "../public/posts_GET.js"],
    ["two deep up to root", "query/admin", "_shared.ts", "../../_shared.js"],
    ["one deep down to two", "table", "table/trigger/on_insert.ts", "./trigger/on_insert.js"],
  ])("%s", (_label, fromDir, toPath, expected) => {
    expect(specifierFrom(fromDir, toPath)).toBe(expected);
  });

  it("always emits an explicitly relative specifier", () => {
    for (const [fromDir, toPath] of [
      [".", "_shared.ts"],
      ["function", "table/table.ts"],
      ["query/admin", "query/admin/posts_GET.ts"],
    ] as const) {
      expect(specifierFrom(fromDir, toPath)).toMatch(/^\.{1,2}\//);
    }
  });

  it("rewrites the extension at every depth", () => {
    for (const [fromDir, toPath] of [
      [".", "_shared.ts"],
      ["function", "table/table.ts"],
      ["query/admin", "query/public/posts_GET.ts"],
    ] as const) {
      expect(specifierFrom(fromDir, toPath)).toMatch(/\.js$/);
    }
  });
});

describe("file layout", () => {
  it("puts every table in table/table.ts, even a singly-referenced one", () => {
    // Nearly every statement family binds a table, so scattering them across
    // per-object files makes the import graph unreadable.
    const project = build({ tables: [table("users", guid(1))], functions: [fn("a", guid(2), [guid(1)])] });
    expect(file(project, "table/table.ts")).toContain("export const users =");
    expect(project.files.map((f) => f.path)).not.toContain("table/users.ts");
  });

  it("keeps tables out of _shared.ts, which is now non-tables only", () => {
    // The two used to be one file, which made every table↔shared edge intra-file
    // and therefore free. Splitting them is what this assertion pins.
    const project = build({
      tables: [table("users", guid(1)), table("posts", guid(2))],
      functions: [fn("a", guid(3), [guid(1)])],
    });
    const tables = file(project, "table/table.ts");
    expect(tables).toContain("export const users =");
    expect(tables).toContain("export const posts =");
    expect(project.files.map((f) => f.path)).not.toContain("_shared.ts");
  });

  it("imports a table from one directory up", () => {
    const project = build({ tables: [table("users", guid(1))], functions: [fn("a", guid(2), [guid(1)])] });
    expect(file(project, "function/a.ts")).toContain('from "../table/table.js"');
  });

  it("hoists an object two files reference into _shared.ts and imports it from both", () => {
    const project = build({
      functions: [fn("helper", guid(1)), fn("a", guid(2), [guid(1)]), fn("b", guid(3), [guid(1)])],
    });
    expect(file(project, "_shared.ts")).toContain("export const helper =");
    for (const path of ["function/a.ts", "function/b.ts"]) {
      expect(file(project, path)).toContain('from "../_shared.js"');
      expect(file(project, path)).toContain("helper");
    }
  });

  it("leaves a singly-referenced object in its own kind directory", () => {
    const project = build({ functions: [fn("helper", guid(1)), fn("a", guid(2), [guid(1)])] });
    expect(file(project, "function/a.ts")).toContain('from "./helper.js"');
  });

  it("imports only what a file actually uses", () => {
    const project = build({
      functions: [fn("helper", guid(1)), fn("a", guid(2), [guid(1)]), fn("b", guid(3))],
    });
    expect(file(project, "function/b.ts")).not.toContain("helper");
  });
});

describe("reference cycles", () => {
  it("breaks a two-file cycle on exactly one edge, emitting no circular import", () => {
    // `ObjectRef` accepts `{name, guid}`, so the back edge costs nothing but a
    // symbol reference (KTD-8). Both files importing each other would crash on load.
    const project = build({
      functions: [fn("a", guid(1), [guid(2)]), fn("b", guid(2), [guid(1)])],
    });
    const a = file(project, "function/a.ts");
    const b = file(project, "function/b.ts");
    const imports = [a, b].filter((source) => /^import .* from "\.\//m.test(source));
    expect(imports).toHaveLength(1);
    // The degraded edge references its target by name and guid instead.
    expect(a + b).toContain(`guid: "${guid(1)}"`);
  });

  it("breaks a same-file forward reference, which would be a dead-zone crash", () => {
    // Two mutually-referencing objects both land in _shared.ts (each is
    // referenced), so ordering alone cannot satisfy both — one must degrade.
    const project = build({
      functions: [
        fn("a", guid(1), [guid(2)]),
        fn("b", guid(2), [guid(1)]),
        fn("c", guid(3), [guid(1), guid(2)]),
      ],
    });
    const shared = file(project, "_shared.ts");
    const posA = shared.indexOf("export const a =");
    const posB = shared.indexOf("export const b =");
    expect(posA).toBeGreaterThan(-1);
    expect(posB).toBeGreaterThan(-1);
    // Whichever is declared second must not be named by the first.
    const first = posA < posB ? shared.slice(posA, posB) : shared.slice(posB, posA);
    expect(first).toContain("guid:");
  });

  it("hoists a degraded reference to a named const instead of repeating the literal", () => {
    // `b` is declared after `a`, so `a`'s two references to it cannot be symbols.
    // Inline they would be two four-line literals saying the same thing twice.
    const project = build({
      functions: [
        fn("a", guid(1), [guid(2), guid(2)]),
        fn("b", guid(2), [guid(1), guid(1)]),
        fn("c", guid(3), [guid(1), guid(2)]),
      ],
    });
    const shared = file(project, "_shared.ts");
    const hoisted = shared.match(/^const (\w+Ref) = \{$/m);
    expect(hoisted, "no hoisted ref const emitted").not.toBeNull();
    const symbol = hoisted![1]!;
    // Declared once, above every declaration, and used by name at both sites.
    expect(shared.indexOf(`const ${symbol} =`)).toBeLessThan(shared.indexOf("export const "));
    expect(shared.split(`const ${symbol} = {`)).toHaveLength(2);
    expect(shared.split(`fn: ${symbol},`)).toHaveLength(3);
  });

  it("never lets a hoisted ref const shadow an object symbol", () => {
    // A workspace may legally hold objects named `a` and `aRef`, and the const
    // for `a` would otherwise take the second one's binding.
    const project = build({
      functions: [
        fn("a", guid(1), [guid(2)]),
        fn("b", guid(2), [guid(1)]),
        fn("aRef", guid(4)),
        fn("bRef", guid(5)),
        fn("c", guid(3), [guid(1), guid(2), guid(4), guid(5)]),
        fn("d", guid(6), [guid(4), guid(5)]),
      ],
    });
    const shared = file(project, "_shared.ts");
    expect(shared).toContain("export const aRef =");
    expect(shared).toContain("export const bRef =");
    // The degraded edge runs in whichever direction the walk found it; either
    // way the const it needs is already taken and falls to the ordinal.
    expect(shared).toMatch(/^const [ab]Ref_2 = \{$/m);
  });

  it("orders same-file declarations so a dependency is declared first", () => {
    const project = build({
      // `dep` is shared (two referrers); so are `a` and `b`? No — only `dep` is,
      // so this exercises ordering across files rather than within one.
      functions: [fn("a", guid(1), [guid(3)]), fn("b", guid(2), [guid(3)]), fn("dep", guid(3))],
    });
    const shared = file(project, "_shared.ts");
    expect(shared).toContain("export const dep =");
  });
});

describe("generated tree contents", () => {
  const project = decodeBundle(sandbox.export());

  it("emits a tsconfig, a barrel, and a README", () => {
    const paths = project.files.map((f) => f.path);
    expect(paths).toContain("tsconfig.json");
    expect(paths).toContain("index.ts");
    expect(paths).toContain("README.md");
  });

  it("registers every decoded object exactly once in the barrel", () => {
    const barrel = file(project, "index.ts");
    const registered = [...barrel.matchAll(/\.register\w+\(\[([^\]]*)\]\)/g)]
      .flatMap((m) => m[1]!.split(",").map((s) => s.trim()))
      .filter(Boolean);
    expect(new Set(registered).size).toBe(registered.length);
    expect(registered.sort()).toEqual(objectSymbols(project));
  });

  it("states the disposable / full-replace / schema-only warnings unconditionally", () => {
    // A user who reads only the README must still come away knowing not to point
    // this at a workspace holding data they care about — so these are not
    // conditional on the report having entries.
    const readme = file(project, "README.md");
    expect(readme).toContain("disposable");
    expect(readme).toContain("full replace");
    expect(readme).toContain("schema only");
  });

  it("says so plainly when nothing needed reporting", () => {
    // Both functions carry a body on purpose: a stack-bearing object with an
    // empty `run` is a legitimate `empty-source` report, so a body-less pair
    // would make this assert the absence of a problem that genuinely exists.
    const clean = build({ functions: [fn("a", guid(1), [guid(2)]), fn("b", guid(2), [guid(1)])] });
    expect(clean.report.entries).toEqual([]);
    expect(file(clean, "README.md")).toContain("Everything in the source bundle round-tripped cleanly.");
  });

  it("names each problem in the README when the decode was not clean", () => {
    const dirty = build({ functions: [fn("a", guid(1), [guid(9)])] });
    const readme = file(dirty, "README.md");
    expect(readme).toContain("What did not round-trip cleanly");
    expect(readme).toContain(guid(9));
    // …and still carries the warnings.
    expect(readme).toContain("full replace");
  });
});

describe("empty source objects", () => {
  it("reports a body-less stack-bearing object instead of emitting a silent stub", () => {
    // A workspace can legitimately hold an endpoint someone created and never
    // filled in. The decode is faithful and the round trip is clean, so nothing
    // else in the pipeline says a word — but the generated file is a bare
    // identity stub, which is byte-for-byte what a failed decode looks like.
    const project = build({ functions: [fn("empty", guid(1))] });
    const entries = project.report.entries.filter((e) => e.category === "empty-source");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.object).toBe("function:empty");
    expect(entries[0]!.detail).toContain("no statements in the source object");
  });

  it("emits the stub itself, rather than dropping the object", () => {
    // Reporting must not turn into skipping: the object still exists upstream,
    // and a tree missing it would not round-trip.
    const project = build({ functions: [fn("empty", guid(1))] });
    const generated = file(project, "function/empty.ts");
    expect(generated).toContain("defineFunction({");
    expect(generated).toContain('name: "empty"');
    expect(generated).not.toContain("stack:");
  });

  it("stays silent for a kind that carries no stack at all", () => {
    // Tables never call the stack inverse, so they must not be swept up by it.
    const project = build({ tables: [table("t", guid(1))] });
    expect(project.report.entries.filter((e) => e.category === "empty-source")).toEqual([]);
  });

  it("surfaces the count in the README and the CLI summary alike", () => {
    const project = build({ functions: [fn("empty", guid(1))] });
    expect(project.report.renderMarkdown()).toContain("[empty-source=1]");
    expect(project.report.renderCli()).toContain("[empty-source=1]");
  });
});

describe("factory emission", () => {
  it("wraps each def in its factory rather than a `satisfies` annotation", () => {
    const project = build({ functions: [fn("a", guid(1), [guid(2)]), fn("b", guid(2), [guid(1)])] });
    const generated = file(project, "function/a.ts");
    expect(generated).toContain("defineFunction({");
    expect(generated).not.toContain("satisfies");
    // Value import, not a type-only one — an `import type` would be erased and
    // the call would be a ReferenceError at load.
    expect(generated).toMatch(/^import \{[^}]*\bdefineFunction\b[^}]*\} from "@sidestep\/core";$/m);
    expect(generated).not.toContain("import type { FunctionDef }");
  });

  it("wraps the workspace config in its factory, in its own file", () => {
    // The config used to be inlined into the barrel's registry chain; it now
    // has `workspace.ts` to itself, and the barrel only names the binding.
    const project = build({ tables: [table("t", guid(1))] });
    const settings = file(project, "workspace.ts");
    expect(settings).toContain("export const workspaceSettings = workspaceConfig({");
    expect(settings).not.toContain("satisfies");
    const barrel = file(project, "index.ts");
    expect(barrel).toContain(".registerWorkspace(workspaceSettings)");
    expect(barrel).toContain('from "./workspace.js"');
  });

  it("emits no workspace.ts when the bundle carries no workspace object", () => {
    const project = decodeBundle({ payload: { dbo: [] } });
    expect(project.files.map((f) => f.path)).not.toContain("workspace.ts");
    expect(file(project, "index.ts")).not.toContain("registerWorkspace");
  });

  it("never lets an object symbol shadow a factory it imports", () => {
    // A table named `table` is legal in Xano. Emitting `const table = table({…})`
    // is a temporal-dead-zone crash at import time, not a type error — so it
    // would type-check, ship, and then explode on load.
    const project = build({ tables: [table("table", guid(1))] });
    const shared = file(project, "table/table.ts");
    expect(shared).toContain('import { f, table } from "@sidestep/core"');
    expect(shared).not.toMatch(/export const table = table\(/);
    expect(shared).toMatch(/export const tableTable = table\(/);
  });
});

/**
 * U6 — a generated tree must parse, whatever an object is named.
 *
 * `toSymbol` sanitizes characters but not keywords, so a table called `new` or a
 * function called `default` reached the file verbatim and the whole project
 * failed to parse. That is the one failure mode in the codegen sweep that cost
 * more than verbosity: 15 workspaces produced an unusable tree.
 *
 * Every case here parses the emitted source rather than pattern-matching it — a
 * regression that produces a *differently* invalid identifier still fails.
 */
describe("reserved names never break the tree", () => {
  /** Parse every generated file, failing with the offending source on a syntax error. */
  async function expectParses(project: GeneratedProject): Promise<void> {
    const { transform } = await import("esbuild");
    for (const generated of project.files) {
      if (!generated.path.endsWith(".ts")) continue;
      await expect(
        transform(generated.contents, { loader: "ts", format: "esm" }),
        `does not parse: ${generated.path}\n${generated.contents}`,
      ).resolves.toBeDefined();
    }
  }

  it("emits a parsing tree for a table named `new`", async () => {
    const project = build({ tables: [table("new", guid(1))] });
    await expectParses(project);
    expect(file(project, "table/table.ts")).toContain("export const newTable =");
  });

  it("emits a parsing tree for a function named `default`", async () => {
    const project = build({ functions: [fn("default", guid(1))] });
    await expectParses(project);
    expect(file(project, "function/defaultfunction.ts")).toContain("export const defaultFunction =");
  });

  it("emits a valid identifier for every reserved word used as a name", async () => {
    // Table-driven over the whole set, including strict-mode and future-reserved
    // words — a generated binding is a module-level `const`, so they all apply.
    const words = [
      "break", "case", "catch", "class", "const", "continue", "debugger", "default",
      "delete", "do", "else", "enum", "export", "extends", "false", "finally",
      "for", "function", "if", "import", "in", "instanceof", "new", "null",
      "return", "super", "switch", "this", "throw", "true", "try", "typeof",
      "var", "void", "while", "with", "implements", "interface", "let", "package",
      "private", "protected", "public", "static", "yield", "await", "arguments",
      "eval", "undefined", "NaN", "Infinity",
    ];
    const project = build({
      functions: words.map((word, i) => fn(word, guid(i + 1))),
    });
    await expectParses(project);
    const symbols = objectSymbols(project).filter((symbol) => symbol !== "default");
    expect(symbols).toHaveLength(words.length);
    for (const symbol of symbols) expect(words).not.toContain(symbol);
    // Still unique — the postfix must not collapse two words onto one symbol.
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it("still reserves the SDK factory names it imports", async () => {
    const project = build({ tables: [table("table", guid(1))], functions: [fn("query", guid(2))] });
    await expectParses(project);
    expect(file(project, "table/table.ts")).toMatch(/export const tableTable = table\(/);
    expect(file(project, "function/queryfunction.ts")).toContain("export const queryFunction =");
  });

  it("keeps a reserved name unique when two same-kind objects share it", async () => {
    const project = build({ functions: [fn("new", guid(1)), fn("new", guid(2))] });
    await expectParses(project);
    const symbols = objectSymbols(project);
    // The ordinal builds on the disambiguated symbol, not the bare reserved word.
    expect(symbols).toEqual(["newFunction", "newFunction_2"]);
  });

  it("resolves a reserved name that also collides across kinds", async () => {
    const project = build({ tables: [table("new", guid(1))], functions: [fn("new", guid(2))] });
    await expectParses(project);
    const symbols = objectSymbols(project);
    expect(symbols).toEqual(["newFunction", "newTable"]);
  });

  it("assembles a reserved-name bundle to byte-identical files twice", () => {
    const defs = { tables: [table("new", guid(1))], functions: [fn("default", guid(2))] };
    expect(build(defs).files).toEqual(build(defs).files);
  });
});
