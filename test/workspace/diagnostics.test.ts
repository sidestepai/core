/**
 * The build-time diagnostics collector (KTD5), plus the regression tests that
 * keep guards OFF the shapes a source check cleared (KTD2b).
 *
 * The negative tests here are the point. Five shapes the audit asked us to
 * block at `export()` turned out to be engine defects against bytes the
 * engine's own tooling emits — a guard on any of them refuses a supported
 * shape and has to be un-shipped the moment the engine is fixed. One of them
 * (#195) was guarded for a single release before its real cause surfaced
 * upstream, which is the cautionary case: it had a clean live reproduction and
 * was still wrong. Each carries a test so a future reading of the issue does
 * not re-add it.
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
import { encodeRealtimeMessage } from "../../src/kinds/realtime-message.js";
import { encodeTool } from "../../src/kinds/toolset.js";
import { task } from "../../src/kinds/task.js";
import { defineFunction } from "../../src/function/define.js";
import { s } from "../../src/statements/s.js";
import { raw } from "../../src/statements/special/raw.js";
import { isRegisteredStatement } from "../../src/statements/statement.js";
import { STATEMENT_SURFACES } from "../../src/statements/surfaces.js";
import { checkDecodeOnlyStatements } from "../../src/workspace/guards.js";
import { f } from "../../src/fields/catalog.js";
import { c, ref, inp } from "../../src/values/value.js";
import { middleware } from "../../src/kinds/middleware.js";
import { realtimeServer } from "../../src/kinds/realtime-server.js";
import { realtimeChannel } from "../../src/kinds/realtime-channel.js";
import { realtimeChannelTrigger, realtimeServerTrigger } from "../../src/kinds/trigger.js";
import { obj } from "../../src/values/obj.js";
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

  it("accepts a seeded table with a non-scalar column (#195)", () => {
    // Guarded for one release on the strength of a live reproduction, then
    // removed: the cause was a stale per-worker model cache upstream
    // (DEV-7605) that dropped the column's value cast, not anything about the
    // authored shape. Nothing an author could have avoided, and nothing to
    // refuse. A reproduction proves a symptom, not a rule.
    const seen = captureWarnings(() => {
      new Xano()
        .registerWorkspace({ name: "app" })
        .registerTables([
          table({
            name: "thing",
            schema: { label: f.text(), tags: f.text({ array: true }), meta: f.json() },
            seed: [{ label: "a", tags: ["x"], meta: {} }] as never,
          }),
        ])
        .export();
    });
    expect(seen).toHaveLength(0);
  });

  // #227. The earlier reading of this — that the engine stores the name
  // unsanitized and the router tolerates a "." — was checked against the router
  // and was right about the router and wrong about the write. Live deploy of a
  // six-name matrix settled it: `export_zip` served 200, while `export.zip`,
  // `export.csv`, `export.xyz`, `ex.port` and `dir.d/leaf` ALL persisted with
  // `name: null` and 404'd. So it is not extensions, not static-file handling,
  // and not the router — the engine's stored charset rejects the write and the
  // import path swallows the failure. Refusing it at authoring time is refusing
  // silent data loss, and the rule is the engine's own, not a stricter one.
  it("refuses a `.` in a query name, naming the character and the silent-null failure (#227)", () => {
    const group = apiGroup({ name: "pub", canonical: "abc12345" });
    expect(() =>
      query({ name: "export.zip", verb: "GET", apiGroup: group, stack: [], response: c.bool(true) }),
    ).toThrow(/contains "\."/);
    expect(() =>
      query({ name: "export.zip", verb: "GET", apiGroup: group, stack: [], response: c.bool(true) }),
    ).toThrow(/EMPTY name/);
  });

  it("refuses every out-of-charset query name, and accepts the ones the engine stores (#227)", () => {
    const group = apiGroup({ name: "pub", canonical: "abc12345" });
    const mk = (name: string) =>
      query({ name, verb: "GET", apiGroup: group, stack: [], response: c.bool(true) });

    // Every shape proven to null out on the live engine.
    for (const name of ["export.zip", "export.csv", "ex.port", "dir.d/leaf"]) {
      expect(() => mk(name), name).toThrow(/cannot store/);
    }
    // …and the neighbours that are not dots but are equally unstorable.
    for (const name of ["a b", "café", "a|b", "a+b", "a%2Eb", "a:b"]) {
      expect(() => mk(name), name).toThrow(/cannot store/);
    }
    // The full stored charset, including a path param and the control from the
    // live matrix, must still pass untouched.
    for (const name of ["export_zip", "export-zip", "a/b/c", "ABC123", "x"]) {
      expect(() => mk(name), name).not.toThrow();
    }
    expect(() =>
      query({
        name: "users/{user_id}/posts",
        verb: "GET",
        apiGroup: group,
        input: { user_id: input.int() },
        stack: [],
        response: c.bool(true),
      }),
    ).not.toThrow();
  });

  it("refuses a query name past the engine's 200-character cap (#227)", () => {
    const group = apiGroup({ name: "pub", canonical: "abc12345" });
    const mk = (name: string) =>
      query({ name, verb: "GET", apiGroup: group, stack: [], response: c.bool(true) });
    expect(() => mk("a".repeat(200))).not.toThrow();
    expect(() => mk("a".repeat(201))).toThrow(/201 characters/);
  });

  // `query()` is not the only door — `QueryDef` is public and the kind registry
  // encodes plain objects, so the backstop has to hold too.
  it("refuses a hand-built dotted def at export, not just at query() (#227)", () => {
    const group = apiGroup({ name: "pub", canonical: "abc12345" });
    expect(() =>
      new Xano()
        .registerWorkspace({ name: "app" })
        .registerApiGroups([group])
        .registerQueries([
          { name: "export.zip", verb: "GET", apiGroup: group, stack: [], response: c.bool(true) } as never,
        ])
        .export(),
    ).toThrow(/cannot store/);
  });

  // The engine puts this same whitelist on four fields, not one. A guard on
  // `query` alone would leave the identical silent-null on the other three.
  it("refuses an unstorable name on every kind that carries the charset (#227)", () => {
    const server = realtimeServer({ name: "chat", canonical: "chat1234" });
    const channel = realtimeChannel({ name: "room", server });

    // Channel paths take the route charset — "/" and "{}" are legal, "." is not.
    expect(() => realtimeChannel({ name: "rooms.v2", server })).toThrow(/cannot store/);
    expect(() => realtimeChannel({ name: "rooms/{room_id}", server, input: { room_id: input.text() } })).not.toThrow();

    // A tool name is route-shaped too.
    expect(() => encodeTool({ name: "fetch.url" })).toThrow(/cannot store/);
    expect(() => encodeTool({ name: "fetch_url" })).not.toThrow();

    // A realtime message name is NOT: the engine stores no "/" or "{}" here, so
    // the guard has to be narrower rather than copied from the query rule.
    expect(() => encodeRealtimeMessage({ name: "msg.sent", channel })).toThrow(/cannot store/);
    expect(() => encodeRealtimeMessage({ name: "msg/sent", channel })).toThrow(/only letters, digits, "_" and "-"/);
    expect(() => encodeRealtimeMessage({ name: "msg_sent", channel })).not.toThrow();
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

/**
 * #235. `mvp:placeholder` is the one shape the audit turned up that is OURS
 * rather than the engine's — and the only reason it clears the KTD2c bar for a
 * hard error is that the rule is upstream's, not an inference from a
 * reproduction: Xano's own CLI blocks a push whose preview names this
 * statement, alongside a syntax error. There is no `s.` surface for it, so the
 * only route into a bundle is a pull that carried one through `raw()`.
 */
describe("statements the engine writes but will not import (#235)", () => {
  /** A workspace whose one function carries a raw `mvp:placeholder`. */
  const withPlaceholder = () =>
    new Xano()
      .registerWorkspace({ name: "app" })
      .registerFunctions([
        defineFunction({
          name: "half_built",
          stack: [raw({ name: "mvp:placeholder", context: { name: "todo" }, input: [] })],
        }),
      ]);

  it("has no authoring surface at all", () => {
    expect("placeholder" in s).toBe(false);
    expect(STATEMENT_SURFACES.some(([, stored]) => stored === "mvp:placeholder")).toBe(false);
    expect(isRegisteredStatement("mvp:placeholder")).toBe(false);
  });

  it("refuses to export a bundle carrying one, naming the object and the fix", () => {
    let message = "";
    try {
      withPlaceholder().export();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('function "half_built"');
    expect(message).toContain("mvp:placeholder");
    expect(message).toContain("Missing statement: mvp:placeholder");
    expect(message).toContain("raw(");
  });

  it("reports one diagnostic per object, not one per copy", () => {
    const bag = new DiagnosticBag();
    checkDecodeOnlyStatements(
      {
        function: [
          {
            name: "half_built",
            run: [
              { name: "mvp:placeholder", context: { name: "a" } },
              { name: "mvp:placeholder", context: { name: "b" } },
            ],
          },
        ],
      },
      bag,
    );
    expect(bag.all()).toHaveLength(1);
    expect(bag.all()[0]!.code).toBe("statement.decode-only");
  });

  it("stays silent on a workspace that carries none", () => {
    const seen = captureWarnings(() =>
      new Xano()
        .registerWorkspace({ name: "app" })
        .registerFunctions([defineFunction({ name: "fine", stack: [s.comment("all good")] })])
        .export(),
    );
    expect(seen).toHaveLength(0);
  });
});

/**
 * #199/#200. The audit reported that a realtime gate FAILS OPEN — that a
 * `connect`/`join` stack which raises admits the client, with no error frame and
 * no close code — and that `inp()` cannot resolve inside a `join`/`leave`
 * trigger at all. The plan's deliverables followed from those two claims: a
 * fail-closed helper wrapping every decision in `s.try_catch`, and a BUILD ERROR
 * on `inp()` in a join/leave stack.
 *
 * Neither claim holds at the current engine, and both were checked at the
 * source before anything was built (KTD2b):
 *
 *  - Both gates FAIL CLOSED. The transport seeds a deny decision before running
 *    the stack and keeps it in the `catch`; `connect` additionally pushes an
 *    error frame and closes with 4401. The engine's own comment states the rule
 *    — a gate that cannot answer must not admit — and contrasts it with a
 *    normal message, which fails open so one workspace bug cannot black-hole a
 *    channel.
 *  - `join` and `leave` MERGE the channel's typed path params into the trigger
 *    event specifically so the stack reads them as `$input.<param>`. `inp()` is
 *    the correct spelling there, and a build error would have blocked the
 *    engine's intended pattern.
 *
 * All three changes landed 2026-07-26/28, roughly two weeks before the audit
 * ran, so this is not a rollout lag like #196. So: no helper, no build error,
 * and these regression tests exist so neither is re-added from a reading of the
 * issues. What DID ship is the one lockout this leaves — see below.
 */
describe("realtime gates (#199/#200)", () => {
  const server = realtimeServer({ name: "rt" });
  const room = realtimeChannel({ name: "rooms/{id}", server, input: { id: input.int() } });

  const build = (triggers: unknown[]) =>
    new Xano()
      .registerWorkspace({ name: "app" })
      .registerRealtimeServers([server])
      .registerRealtimeChannels([room])
      .registerTriggers(triggers);

  it("warns that a gating trigger with no response refuses every client", () => {
    const seen = captureWarnings(() =>
      build([
        realtimeChannelTrigger({ name: "gate", channel: room, actions: { join: true }, stack: () => [] }),
      ]).export(),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.code).toBe("realtime.gate-denies-everyone");
    expect(seen[0]!.message).toContain('trigger "gate"');
    expect(seen[0]!.message).toContain("join");
    // The message has to say a crash denies too, or a reader "fixes" this by
    // adding a try_catch, which is the shape the wrong model produced.
    expect(seen[0]!.message).toContain("A crash denies too");
  });

  it("warns for a server connect gate on the same terms", () => {
    const seen = captureWarnings(() =>
      build([
        realtimeServerTrigger({
          name: "front_door",
          realtimeServer: server,
          actions: { connect: true },
          stack: () => [],
        }),
      ]).export(),
    );
    expect(seen.map((d) => d.code)).toEqual(["realtime.gate-denies-everyone"]);
  });

  it("stays quiet once the gate can say yes", () => {
    const seen = captureWarnings(() =>
      build([
        realtimeChannelTrigger({
          name: "gate",
          channel: room,
          actions: { join: true },
          stack: () => [],
          response: () => obj({ allowed: c.bool(true) }),
        }),
      ]).export(),
    );
    expect(seen).toHaveLength(0);
  });

  it("says nothing about the OBSERVATIONAL actions, whose return is ignored", () => {
    // `leave`/`disconnect` discard their return, and `deliver` with no response
    // delivers the original payload unchanged — a working default, not a
    // lockout. Warning on these would be noise on every correct workspace.
    const seen = captureWarnings(() =>
      build([
        realtimeChannelTrigger({ name: "obs", channel: room, actions: { leave: true, deliver: true }, stack: () => [] }),
        realtimeServerTrigger({ name: "bye", realtimeServer: server, actions: { disconnect: true }, stack: () => [] }),
      ]).export(),
    );
    expect(seen).toHaveLength(0);
  });

  it("does NOT reject inp() in a join or leave stack — the engine binds path params there", () => {
    // The planned build error. `join`/`leave` merge the channel's typed path
    // params into the event so the stack reads them as `$input.<param>`; this
    // is the engine's intended way to gate per room.
    const seen = captureWarnings(() =>
      build([
        realtimeChannelTrigger({
          name: "per_room",
          channel: room,
          actions: { join: true, leave: true },
          stack: () => [s.set_var("room", inp("id"))],
          response: () => obj({ allowed: c.bool(true) }),
        }),
      ]).export(),
    );
    expect(seen).toHaveLength(0);
  });
});
