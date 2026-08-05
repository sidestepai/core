/**
 * Item 6b — the `?=` audit, held as a standing guard rather than a one-off pass.
 *
 * Commit `cb07bb2` fixed the `?=` divergences a single real workspace exposed
 * (`lock`, `reset`, `allow_id_field`, `get_input`'s pair, `create_auth`'s order
 * and optionals, `dbo_view`'s return sub-block). The open question was whether
 * OTHER hand-written encoders write `?=` optionals unconditionally too — they
 * simply were not exercised by that one workspace.
 *
 * The oracle that settles it already exists. `codegen-corpus.test.ts` decodes
 * each vendored fixture — captured off a real Xano engine — and requires the
 * re-encode to be `normalize()`-equal. A statement with such a fixture therefore
 * has its `?=` behavior proven against engine bytes. The audit surface is
 * exactly the hand-written statements with NO fixture, where an encoder could
 * write an optional unconditionally with nothing to catch it.
 *
 * Auditing that set once would rot the moment someone adds an encoder. So the
 * set itself is asserted here: every hand-written statement must be either
 * fixture-covered or listed below with a reason. A new encoder lands failing
 * this test until someone writes down which it is — the same self-guarding
 * shape as the corpus's expected-fallback list.
 *
 * The audit that produced this list found **no divergences**. The reasons are
 * recorded so the next pass starts from evidence rather than re-deriving it.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** `src/statements/special/` — the encoders written by hand, not from the spec. */
const SPECIAL_DIR = fileURLToPath(new URL("../../src/statements/special/", import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

/**
 * Hand-written statements with no engine-captured fixture, and why each is not
 * a `?=` risk. Every entry was checked against the engine's own class.
 */
const UNCOVERED_BY_DESIGN: Readonly<Record<string, string>> = {
  // The engine's WorkspaceRun* subclasses all share one base and override only
  // display/name/type plus id migration — the stored context is a single
  // required `id`, so there is no optional to write unconditionally. The shared
  // shape is proven by `mvp:workspace_run_endpoint` AND, since the workflow-test
  // capture, by `mvp:workspace_run_function` — both now have real fixtures.
  "mvp:workspace_run_task": "shares the workspace-run base's single-key `id` context",
  "mvp:workspace_run_tool": "shares the workspace-run base's single-key `id` context",
  "mvp:workspace_run_trigger": "shares the workspace-run base's single-key `id` context",
  "mvp:workspace_run_middleware": "shares the workspace-run base's single-key `id` context",
  "mvp:workspace_run_addon": "shares the workspace-run base's single-key `id` context",
  "mvp:workspace_run_workflow_test": "decode-accurate, no golden; single-key `id` context",

  // All five external-SQL engines are one `dbExternalQuery` encoder differing
  // only in statement name; the postgres variant is fixture-covered.
  "mvp:dbo_external_mssql_query": "same dbExternalQuery encoder as the covered dbo_external_postgres_query",
  "mvp:dbo_external_mysql_query": "same dbExternalQuery encoder as the covered dbo_external_postgres_query",
  "mvp:dbo_external_oracle_query": "same dbExternalQuery encoder as the covered dbo_external_postgres_query",
  "mvp:dbo_external_snowflake_query": "same dbExternalQuery encoder as the covered dbo_external_postgres_query",

  // Engine getInputSchema is empty — nothing optional to get wrong.
  "mvp:comment": "engine getInputSchema is empty",
  "mvp:placeholder": "engine getInputSchema is empty",

  // Already settled on this branch (cb07bb2): input order read from the
  // engine's own getInputSchema, `extras`/`expiration` omitted when unset.
  "mvp:create_auth": "?= optionals already settled against the engine getInputSchema in cb07bb2",

  // Writes `auth.dbo_id` only when an auth table is given, matching the
  // engine's `$data["auth"]["dbo_id"] ?? 0`.
  "mvp:realtime_event": "auth.dbo_id already written conditionally, matching the engine's `?? 0`",

  // Excluded from byte-verify until an action-identity model exists — see the
  // @TODO in `src/statements/special/calls.ts`. Capturing before then would
  // vendor a fixture built on an identity mapping known to be wrong.
  "mvp:action": "excluded from byte-verify pending an action-identity model (see calls.ts @TODO)",
  "mvp:action_package": "excluded from byte-verify pending an action-identity model (see calls.ts @TODO)",
};

/** Every `mvp:*` name a hand-written encoder registers. */
function handWrittenStatements(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(SPECIAL_DIR).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(`${SPECIAL_DIR}${file}`, "utf8");
    for (const match of source.matchAll(/"(mvp:[a-z0-9_]+)"/g)) names.add(match[1]!);
  }
  return names;
}

/** Every `mvp:*` name appearing anywhere in the engine-captured fixture corpus. */
function fixtureCoveredStatements(): Set<string> {
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value === null || typeof value !== "object") return;
    const name = (value as { name?: unknown }).name;
    if (typeof name === "string" && name.startsWith("mvp:")) names.add(name);
    Object.values(value).forEach(walk);
  };
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(`${dir}${entry.name}/`)
        : entry.name.endsWith(".json")
          ? [`${dir}${entry.name}`]
          : [],
    );
  for (const file of files(FIXTURE_DIR)) {
    try {
      walk(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      // A fixture that is not valid JSON is another test's problem.
    }
  }
  return names;
}

describe("hand-written encoder coverage — the standing `?=` audit", () => {
  const hand = handWrittenStatements();
  const covered = fixtureCoveredStatements();

  it("enumerates a plausible number of hand-written statements", () => {
    // Guards the whole file against a regex that silently stops matching.
    expect(hand.size).toBeGreaterThanOrEqual(50);
  });

  it("covers every hand-written statement by a fixture or an explicit reason", () => {
    // A new hand-written encoder lands failing here until someone decides
    // whether it needs an engine capture — which is the point.
    const unexplained = [...hand].filter(
      (name) => !covered.has(name) && !Object.hasOwn(UNCOVERED_BY_DESIGN, name),
    );
    expect(
      unexplained,
      `these hand-written statements have no engine-captured fixture and no recorded reason — ` +
        `capture one (see the xano-fixtures workflow) or add it to UNCOVERED_BY_DESIGN with why`,
    ).toEqual([]);
  });

  it("keeps the exception list honest — no entry that is actually covered", () => {
    // The mirror of the check above: a statement that gains a real fixture must
    // drop off this list, or the list quietly overstates what is unverified.
    const stale = Object.keys(UNCOVERED_BY_DESIGN).filter((name) => covered.has(name));
    expect(stale, "these now have a real fixture and should leave UNCOVERED_BY_DESIGN").toEqual([]);
  });

  it("keeps the exception list live — no entry for a statement that no longer exists", () => {
    const orphaned = Object.keys(UNCOVERED_BY_DESIGN).filter((name) => !hand.has(name));
    expect(orphaned, "these are no longer hand-written encoders").toEqual([]);
  });

  it("states a non-trivial reason for every exception", () => {
    for (const [name, reason] of Object.entries(UNCOVERED_BY_DESIGN)) {
      expect(reason.length, `${name} needs a real reason, not a placeholder`).toBeGreaterThan(20);
    }
  });
});
