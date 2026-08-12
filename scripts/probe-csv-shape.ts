/**
 * CSV output-shape probe (issue #246) — the evidence behind the `csv_encode` and
 * `csv_create` description notes in `scripts/codegen-filters.ts`.
 *
 * #246 was reported as `fl.map` + `fl.csv_encode` over `db.query` rows failing.
 * The cause was arity, not encoding: the declared-legal `fl.csv_encode()` call
 * fails on an argument count before the filter body runs, which
 * `scripts/probe-filter-arity.ts` now covers catalog-wide. `fl.map` was never
 * implicated — both body shapes bind correctly here.
 *
 * With the arity satisfied, this pins the output behaviors that are easy to
 * mistake for a broken encoder, and are now documented at the call site:
 *   - `csv_encode` writes NO header row; `csv_create` does.
 *   - Column order is per-row and unnormalized, so heterogeneous rows misalign.
 *   - Non-scalar cells are JSON-encoded, and `false` writes as empty.
 *   - A scalar-returning `map` body collapses the array to a single line.
 *
 * Run (maintainer step; needs a live sandbox):
 *   tsx scripts/probe-csv-shape.ts     # reads XANO_VALIDATE_* from .env
 */
import { workspace, table, f, defineFunction, s, c, ref, withFilters, fl, serializeBundle } from "../src/index.js";
import { resolveValidateConfig } from "../src/validate/config.js";
import { MetaClient } from "../src/validate/meta-client.js";

const ROWS = [
  { name: "Ada, Lovelace", score: 10, active: true },
  { name: 'Grace "Amazing" Hopper', score: 20, active: false },
  { name: "Alan Turing", score: 30, active: true },
];

/** The three args the engine demands, at their conventional CSV defaults. */
const ARGS = [c.text(","), c.text('"'), c.text("\\")] as const;

const csvrows = table({
  name: "csvrows",
  schema: { name: f.text(), score: f.int(), active: f.bool({ default: "false" }) },
});

const seed = defineFunction({
  name: "p_seed",
  stack: ROWS.map((r, i) =>
    s.db.add({
      table: csvrows,
      row: { name: c.text(r.name), score: c.int(r.score), active: c.bool(r.active) },
      as: `added_${i}`,
    }),
  ),
  response: c.text("seeded"),
});

/** All three args supplied — does it run at all? */
const encFull = defineFunction({
  name: "p_enc_full",
  stack: [s.set_var("out", withFilters(c.array(ROWS), fl.csv_encode(...ARGS)))],
  response: ref("out"),
});

// The short calls this probe used to make — `fl.csv_encode(separator)` and
// `fl.csv_encode(separator, enclosure)` — are no longer expressible: the typed
// surface now refuses them at author time, which is the #246 fix. Arity is
// `scripts/probe-filter-arity.ts`'s subject; this file is about output shape.

/** Heterogeneous key order — does column alignment survive? */
const encHetero = defineFunction({
  name: "p_enc_hetero",
  stack: [
    s.set_var(
      "out",
      withFilters(
        c.array([
          { name: "Ada", score: 10 },
          { score: 20, name: "Grace" },
          { name: "Alan", extra: "x", score: 30 },
        ]),
        fl.csv_encode(...ARGS),
      ),
    ),
  ],
  response: ref("out"),
});

/** Non-scalar cells. */
const encNested = defineFunction({
  name: "p_enc_nested",
  stack: [
    s.set_var("out", withFilters(c.array([{ name: "Ada", tags: ["a", "b"], meta: { k: 1 } }]), fl.csv_encode(...ARGS))),
  ],
  response: ref("out"),
});

/** The composed chain the issue reports, with the arity satisfied. */
const chainObj = defineFunction({
  name: "p_chain_obj",
  stack: [
    s.db.query({ table: csvrows, as: "rows" }),
    s.set_var(
      "out",
      withFilters(
        ref("rows"),
        fl.map(({ $this }) => ({ name: $this.name, score: $this.score })),
        fl.csv_encode(...ARGS),
      ),
    ),
  ],
  response: ref("out"),
});

/** Scalar map body feeding the encoder. */
const chainScalar = defineFunction({
  name: "p_chain_scalar",
  stack: [
    s.db.query({ table: csvrows, as: "rows" }),
    s.set_var("out", withFilters(ref("rows"), fl.map(({ $this }) => $this.name), fl.csv_encode(...ARGS))),
  ],
  response: ref("out"),
});

/** The header-bearing sibling, arity satisfied (rows + 3). */
const create = defineFunction({
  name: "p_create",
  stack: [
    s.set_var(
      "out",
      withFilters(
        c.array(["name", "score", "active"]),
        fl.csv_create(c.array(ROWS.map((r) => [r.name, r.score, r.active])), ...ARGS),
      ),
    ),
  ],
  response: ref("out"),
});

const PROBES = [encFull, encHetero, encNested, chainObj, chainScalar, create];

async function main() {
  const ws = workspace("csv_probe").registerTables([csvrows]).registerFunctions([seed, ...PROBES]);
  const client = new MetaClient(resolveValidateConfig());
  const imp = await client.importBundle(serializeBundle((ws as unknown as { export(): unknown }).export()), { reset: true });
  if (imp.workspaceId === undefined) throw new Error(`no workspaceId: ${imp.raw.slice(0, 400)}`);
  console.error(`workspace ${imp.workspaceId}`);
  await client.runFunction(imp.workspaceId, "p_seed", {});

  for (const fn of PROBES) {
    const name = (fn as unknown as { name?: string }).name ?? String(fn);
    const res = await client.runFunction(imp.workspaceId, name, {});
    const r = (res.body as { result?: { status?: string; result?: unknown; exception?: { message?: string } } })?.result;
    console.error(`──── ${name}`);
    if (r?.status === "exception") console.error(`  FATAL: ${r.exception?.message}`);
    else console.error(`  ${JSON.stringify(r?.result)}`);
  }
  await client.dispose();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
