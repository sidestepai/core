/**
 * The build-time diagnostics collector (KTD5), plus the regression tests that
 * keep guards OFF the shapes a source check cleared (KTD2b).
 *
 * The negative tests here are the point. Four shapes the audit asked us to
 * block at `export()` turned out to be engine defects against bytes the
 * engine's own tooling emits — a guard on any of them would refuse a supported
 * shape and have to be un-shipped the moment the engine is fixed. Each carries
 * a test so a future reading of the issue does not re-add it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Xano } from "../../src/workspace/xano.js";
import {
  DiagnosticBag,
  emitDiagnostic,
  formatDiagnostic,
  setDiagnosticSink,
} from "../../src/workspace/diagnostics.js";
import type { Diagnostic } from "../../src/workspace/diagnostics.js";
import { table } from "../../src/kinds/table.js";
import { query } from "../../src/kinds/query.js";
import { apiGroup } from "../../src/kinds/api-group.js";
import { task } from "../../src/kinds/task.js";
import { defineFunction } from "../../src/function/define.js";
import { s } from "../../src/statements/s.js";
import { f } from "../../src/fields/catalog.js";
import { c, ref, inp } from "../../src/values/value.js";
import { middleware } from "../../src/kinds/middleware.js";
import { input } from "../../src/inputs/input.js";
import "../../src/kinds/workspace-config.js"; // side-effect: register the "workspace" kind
import "../../src/kinds/function.js"; // side-effect: register the "function" kind

/** Capture every warning emitted during `fn()`, restoring the sink after. */
function captureWarnings(fn: () => void): Diagnostic[] {
  const seen: Diagnostic[] = [];
  const previous = setDiagnosticSink((d) => seen.push(d));
  try {
    fn();
  } finally {
    setDiagnosticSink(previous);
  }
  return seen;
}

afterEach(() => setDiagnosticSink());

describe("DiagnosticBag", () => {
  it("prefixes every message with `sidestep:` exactly once", () => {
    expect(formatDiagnostic({ severity: "warning", code: "x", message: "hello" })).toBe(
      "sidestep: hello",
    );
  });

  it("emits warnings through the sink and throws on the first error only at flush", () => {
    const bag = new DiagnosticBag();
    bag.warn("a", "careful");
    bag.error("b", "broken");
    // Recording does not throw — the whole set is reported at once.
    expect(bag.all()).toHaveLength(2);

    const seen: Diagnostic[] = [];
    const previous = setDiagnosticSink((d) => seen.push(d));
    try {
      expect(() => bag.flush()).toThrow(/sidestep: broken/);
    } finally {
      setDiagnosticSink(previous);
    }
    // The warning is still delivered even though the export failed.
    expect(seen.map((d) => d.code)).toEqual(["a"]);
  });

  it("reports EVERY error, not just the first", () => {
    const bag = new DiagnosticBag();
    bag.error("a", "first problem");
    bag.error("b", "second problem");
    expect(() => bag.flush()).toThrow(/first problem[\s\S]*second problem/);
    expect(() => bag.flush()).toThrow(/2 errors/);
  });

  it("flushes cleanly when nothing was recorded", () => {
    expect(() => new DiagnosticBag().flush()).not.toThrow();
  });

  it("routes an immediate error through the same format", () => {
    expect(() => emitDiagnostic({ severity: "error", code: "x", message: "nope" })).toThrow(
      "sidestep: nope",
    );
  });

  it("silences the whole set when the sink is a no-op", () => {
    const seen = captureWarnings(() => {
      emitDiagnostic({ severity: "warning", code: "x", message: "quiet" });
    });
    expect(seen).toHaveLength(1);
    // ...and with a no-op sink nothing escapes at all.
    const previous = setDiagnosticSink(() => {});
    try {
      expect(() =>
        emitDiagnostic({ severity: "warning", code: "x", message: "quiet" }),
      ).not.toThrow();
    } finally {
      setDiagnosticSink(previous);
    }
  });
});

/**
 * Every case below is pinned to a live deploy against a fresh ephemeral, one
 * table shape per environment. The result matrix:
 *
 * | seeded table declares      | deploy            |
 * |----------------------------|-------------------|
 * | `f.text({ array: true })`  | import 500        |
 * | `f.object({ … })`          | import 500        |
 * | `f.json()`                 | import 500        |
 * | `f.vector(N)`              | import 500        |
 * | `f.geo.point()`            | deploys           |
 * | all four, UNSEEDED         | deploys           |
 * | scalars only, seeded       | deploys           |
 *
 * The engine source reads as though all of these are handled, so do not
 * "correct" this guard from the source — re-run the probe instead.
 */
describe("seeded table with a non-scalar column (#195)", () => {
  const seededWith = (schema: Record<string, unknown>) =>
    new Xano()
      .registerWorkspace({ name: "app" })
      .registerTables([
        table({ name: "thing", schema: schema as never, seed: [{ label: "a" }] as never }),
      ]);

  const messageOf = (fn: () => void): string => {
    try {
      fn();
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  };

  it("refuses an f.json() column, naming the table, the column and the escape", () => {
    const message = messageOf(() => seededWith({ label: f.text(), meta: f.json() }).export());
    expect(message).toContain('table "thing", column "meta"');
    expect(message).toContain("f.json()");
    expect(message).toContain("separate unseeded table");
    // The failure lands after the workspace has been cleared — say so, because
    // that is why this is worth refusing rather than warning about.
    expect(message).toContain("AFTER the full replace");
    // Declaring the column stays supported; the message must not read as a ban.
    expect(message).toContain("fine to declare on an unseeded table");
  });

  it("refuses f.object(), f.vector() and an array column too", () => {
    for (const [name, schema] of [
      ["blob", { label: f.text(), blob: f.object({ a: f.text() }) }],
      ["embedding", { label: f.text(), embedding: f.vector(8) }],
      ["tags", { label: f.text(), tags: f.text({ array: true }) }],
    ] as const) {
      expect(() => seededWith(schema).export()).toThrow(new RegExp(`column "${name}"`));
    }
  });

  it("reports every offending column in one export, not just the first", () => {
    const message = messageOf(() =>
      seededWith({ label: f.text(), meta: f.json(), tags: f.text({ array: true }) }).export(),
    );
    expect(message).toContain('column "meta"');
    expect(message).toContain('column "tags"');
    expect(message).toContain("2 errors");
  });

  it("does NOT fire on a geo column — a seeded geo table deploys", () => {
    expect(() => seededWith({ label: f.text(), at: f.geo.point() }).export()).not.toThrow();
  });

  it("does NOT fire on an UNSEEDED table with every non-scalar column", () => {
    expect(() =>
      new Xano()
        .registerWorkspace({ name: "app" })
        .registerTables([
          table({
            name: "thing",
            schema: {
              tags: f.text({ array: true }),
              blob: f.object({ a: f.text() }),
              meta: f.json(),
              emb: f.vector(4),
            },
          }),
        ])
        .export(),
    ).not.toThrow();
  });

  it("does NOT fire on a scalar-only seeded table", () => {
    expect(() => seededWith({ label: f.text(), count: f.int() }).export()).not.toThrow();
  });
});

describe("s.db.bulk.update with a partial item (#203)", () => {
  // Confirmed at source: bulk update and bulk patch differ by one argument to
  // the input-schema builder — update writes each omitted column's default,
  // patch strips defaults so an absent key contributes nothing.
  const doc = table({
    name: "p_doc",
    schema: { title: f.text(), owner: f.int(), status: f.text() },
  });

  const exportWith = (stack: unknown[]) =>
    captureWarnings(() => {
      new Xano()
        .registerWorkspace({ name: "app" })
        .registerTables([doc])
        .registerFunctions([defineFunction({ name: "fn", stack: stack as never })])
        .export();
    });

  it("warns and names exactly the columns that will be cleared", () => {
    const seen = exportWith([
      s.db.bulk.update({
        table: doc,
        items: c.array([{ id: 1, status: "archived" }]),
        as: "res",
      }),
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.code).toBe("db.bulk-update-partial-item");
    expect(seen[0]!.message).toContain('"title"');
    expect(seen[0]!.message).toContain('"owner"');
    // `status` is supplied, and the system columns are not the author's job.
    expect(seen[0]!.message).not.toContain('"status"');
    expect(seen[0]!.message).not.toContain('"created_at"');
    expect(seen[0]!.message).toContain("s.db.bulk.patch");
  });

  it("takes the union of keys across items", () => {
    const seen = exportWith([
      s.db.bulk.update({
        table: doc,
        items: c.array([
          { id: 1, status: "archived" },
          { id: 2, title: "t" },
        ]),
        as: "res",
      }),
    ]);
    expect(seen[0]!.message).toContain('"owner"');
    expect(seen[0]!.message).not.toContain('"title"');
  });

  it("is silent when every writable column is supplied", () => {
    const seen = exportWith([
      s.db.bulk.update({
        table: doc,
        items: c.array([{ id: 1, title: "t", owner: 2, status: "open" }]),
        as: "res",
      }),
    ]);
    expect(seen).toHaveLength(0);
  });

  it("is silent for a dynamic items list — it cannot be read at build time", () => {
    const seen = exportWith([
      s.set_var("items", c.array([])),
      s.db.bulk.update({ table: doc, items: ref("items"), as: "res" }),
    ]);
    expect(seen).toHaveLength(0);
  });

  it("is silent for bulk.patch with a partial item — that is the correct statement", () => {
    const seen = exportWith([
      s.db.bulk.patch({
        table: doc,
        items: c.array([{ id: 1, status: "archived" }]),
        as: "res",
      }),
    ]);
    expect(seen).toHaveLength(0);
  });
});

describe("reading an internal column a db.get did not return (#224)", () => {
  const users = table({
    name: "p_user",
    schema: { email: f.email(), password: f.password(), name: f.text() },
  });

  const exportWith = (stack: unknown[]) =>
    captureWarnings(() => {
      new Xano()
        .registerWorkspace({ name: "app" })
        .registerTables([users])
        .registerFunctions([defineFunction({ name: "fn", stack: stack as never })])
        .export();
    });

  it("warns on the canonical login read, naming the column and the fix", () => {
    const seen = exportWith([
      s.db.get({ table: users, fieldName: "email", fieldValue: c.text("a@b.co"), as: "u" }),
      s.set_var("hash", ref("u.password")),
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.code).toBe("db.internal-column-read");
    expect(seen[0]!.message).toContain("Unable to locate var: u.password");
    expect(seen[0]!.message).toContain("output");
  });

  it("is silent once the column is named in `output`", () => {
    const seen = exportWith([
      s.db.get({
        table: users,
        fieldName: "email",
        fieldValue: c.text("a@b.co"),
        output: ["id", "email", "password"],
        as: "u",
      }),
      s.set_var("hash", ref("u.password")),
    ]);
    expect(seen).toHaveLength(0);
  });

  it("is silent when the column read is not internal", () => {
    const seen = exportWith([
      s.db.get({ table: users, fieldName: "email", fieldValue: c.text("a@b.co"), as: "u" }),
      s.set_var("who", ref("u.name")),
    ]);
    expect(seen).toHaveLength(0);
  });

  it("is silent for a var bound by something other than db.get", () => {
    // No false positives on a var this check cannot reason about.
    const seen = exportWith([
      s.set_var("u", c.text("not a row")),
      s.set_var("hash", ref("u.password")),
    ]);
    expect(seen).toHaveLength(0);
  });

  it("reports a given reference once, not once per occurrence", () => {
    const seen = exportWith([
      s.db.get({ table: users, fieldName: "email", fieldValue: c.text("a@b.co"), as: "u" }),
      s.set_var("a", ref("u.password")),
      s.set_var("b", ref("u.password")),
    ]);
    expect(seen).toHaveLength(1);
  });
});

/**
 * Pinned to a live run against a fresh ephemeral, one endpoint per case:
 *
 *   control (no inp)                -> 200
 *   middleware reads inp("probe")   -> 500 Unable to locate input: probe
 *   throws under `silent`           -> 200  (guard NOT enforced)
 *   throws under `rethrow`          -> 500  (authored error surfaces)
 *   throws with NO policy set       -> 200  (today's default — an inert guard)
 *
 * The declared input carried a `default`, and it did not stand in.
 */
describe("middleware input and inp() (#210)", () => {
  const exportWith = (def: Parameters<typeof middleware>[0]) =>
    captureWarnings(() => {
      new Xano().registerWorkspace({ name: "app" }).registerMiddleware([middleware(def)]).export();
    });

  it("warns that a declared `input` is never bound, pointing at get_all_input", () => {
    const seen = exportWith({ name: "mw", input: { probe: input.text() }, stack: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.code).toBe("middleware.input-never-bound");
    expect(seen[0]!.message).toContain("s.util.get_all_input");
    expect(seen[0]!.message).toContain("{ type, vars }");
  });

  it("warns — never throws — because real stored middleware declares inputs", () => {
    // A captured middleware in this repo's corpus declares `vars` and `type`
    // inputs. Refusing the field at export would make such a workspace
    // impossible to pull, edit and push back, which is worse than the runtime
    // failure being reported.
    expect(() =>
      new Xano()
        .registerWorkspace({ name: "app" })
        .registerMiddleware([middleware({ name: "mw", input: { probe: input.text() }, stack: [] })])
        .export(),
    ).not.toThrow();
  });

  it("warns on an inp() read inside a middleware stack, quoting the runtime error", () => {
    const seen = exportWith({ name: "mw", stack: [s.set_var("v", inp("probe"))] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.code).toBe("middleware.inp-unresolvable");
    expect(seen[0]!.message).toContain("Unable to locate input: probe");
  });

  it("reports a repeated inp() read once", () => {
    const seen = exportWith({
      name: "mw",
      stack: [s.set_var("a", inp("probe")), s.set_var("b", inp("probe"))],
    });
    expect(seen).toHaveLength(1);
  });

  it("is silent for a middleware that reads no inputs", () => {
    expect(exportWith({ name: "mw", stack: [s.set_var("v", c.text("ok"))] })).toHaveLength(0);
  });

  it("does not warn about inp() in a NON-middleware stack", () => {
    // `inp()` is correct everywhere else; the breakage is specific to middleware.
    const seen = captureWarnings(() => {
      new Xano()
        .registerWorkspace({ name: "app" })
        .registerFunctions([
          defineFunction({ name: "fn", stack: [s.set_var("v", inp("probe"))] }),
        ])
        .export();
    });
    expect(seen).toHaveLength(0);
  });
});

describe("unresolved cross-object references", () => {
  const group = () => apiGroup({ name: "pub", canonical: "abc12345" });

  const withQuery = (name: string, extra: Record<string, unknown> = {}) => {
    const g = group();
    return new Xano()
      .registerWorkspace({ name: "app" })
      .registerApiGroups([g])
      .registerQueries([
        query({ name, verb: "GET", apiGroup: g, stack: [], response: c.bool(true), ...extra }),
      ]);
  };

  it("refuses a call to an object that is not registered, naming the referrer", () => {
    let message = "";
    try {
      const g = group();
      new Xano()
        .registerWorkspace({ name: "app" })
        .registerApiGroups([g])
        .registerFunctions([
          defineFunction({
            name: "caller",
            // A bare name with a typo: resolves to a well-formed guid pointing
            // at nothing. This is the exact shape that shipped in the sandbox.
            stack: [s.task.call({ task: "nightly_cleanup_typo" })],
          }),
        ])
        .export();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('function "caller"');
    expect(message).toContain("not registered on this workspace");
    expect(message).toMatch(/guid [0-9a-f]{32}/);
    // The engine's own error text, so the author can connect the two.
    expect(message).toContain("Invalid <kind> reference");
  });

  it("passes once the target is registered", () => {
    const cleanup = task({ name: "nightly_cleanup", stack: [] });
    const seen = captureWarnings(() => {
      new Xano()
        .registerWorkspace({ name: "app" })
        .registerTasks([cleanup])
        .registerFunctions([
          defineFunction({ name: "caller", stack: [s.task.call({ task: cleanup })] }),
        ])
        .export();
    });
    expect(seen).toHaveLength(0);
  });

  it("reports one diagnostic per target, however many statements reference it", () => {
    let message = "";
    try {
      new Xano()
        .registerWorkspace({ name: "app" })
        .registerFunctions([
          defineFunction({ name: "a", stack: [s.task.call({ task: "gone" })] }),
          defineFunction({ name: "b", stack: [s.task.call({ task: "gone" })] }),
        ])
        .export();
    } catch (error) {
      message = (error as Error).message;
    }
    // One target, one finding — naming both referrers rather than repeating.
    expect(message).not.toContain("2 errors");
    expect(message).toContain('function "a"');
    expect(message).toContain('function "b"');
  });

  it("does NOT fire on a 32-hex string in an author VALUE", () => {
    // The load-bearing false-positive case, and the reason the check can be an
    // error: `examples/sandbox` has an auth-token example whose statement input
    // value is a literal 32-hex string. A value is not a reference.
    const seen = captureWarnings(() => {
      withQuery("q", {
        stack: [s.set_var("v", c.text("157d4a98d979cf04b9ccdb98dfc15229"))],
      }).export();
    });
    expect(seen).toHaveLength(0);
  });

  it("does NOT fire on a partial bundle, which may reference outside itself", () => {
    // A `share`/`schema`/`content` bundle is not a self-contained workspace —
    // codegen is handed exactly this shape when a pull misses a parent.
    expect(() =>
      new Xano()
        .setBundleType("share")
        .registerWorkspace({ name: "app" })
        .registerFunctions([defineFunction({ name: "a", stack: [s.task.call({ task: "gone" })] })])
        .export(),
    ).not.toThrow();
  });
});

describe("shapes deliberately NOT guarded — engine bugs, labelled `external`", () => {
  // Each of these was verified against the engine source: SideStep's emitted
  // bytes match what Xano's own tooling writes, so the failure is upstream and
  // a guard here would block a supported shape. Do not re-add them.

  it('accepts idType: "uuid" with no diagnostic (#205)', () => {
    const seen = captureWarnings(() => {
      new Xano()
        .registerWorkspace({ name: "app" })
        .registerTables([table({ name: "thing", idType: "uuid", schema: { label: f.text() } })])
        .export();
    });
    expect(seen).toHaveLength(0);
  });

  it("accepts useXdo: true with no diagnostic (#214)", () => {
    const seen = captureWarnings(() => {
      new Xano()
        .registerWorkspace({ name: "app", use_xdo: true })
        .registerTables([table({ name: "thing", schema: { label: f.text() } })])
        .export();
    });
    expect(seen).toHaveLength(0);
  });

  it("accepts a `.` in a query name with no diagnostic (#227)", () => {
    const group = apiGroup({ name: "pub", canonical: "abc12345" });
    const seen = captureWarnings(() => {
      new Xano()
        .registerWorkspace({ name: "app" })
        .registerApiGroups([group])
        .registerQueries([
          query({
            name: "export.zip",
            verb: "GET",
            apiGroup: group,
            stack: [],
            response: c.bool(true),
          }),
        ])
        .export();
    });
    expect(seen).toHaveLength(0);
  });
});

describe("migrated warnings keep their behavior", () => {
  it("still warns (and does not block) on an auth table that isn't flagged", () => {
    const users = table({ name: "users", schema: { email: f.email() } });
    const group = apiGroup({ name: "pub", canonical: "abc12345" });
    const seen = captureWarnings(() => {
      new Xano()
        .registerWorkspace({ name: "app" })
        .registerTables([users])
        .registerApiGroups([group])
        .registerQueries([
          query({
            name: "me",
            verb: "GET",
            apiGroup: group,
            auth: users,
            stack: [],
            response: c.bool(true),
          }),
        ])
        .export();
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.code).toBe("query.auth-table-unflagged");
    expect(formatDiagnostic(seen[0]!)).toMatch(/^sidestep: query "me".*table\("users"|users/s);
  });
});
