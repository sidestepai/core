/**
 * #213 probe, round 2 — pin the exact rule for alias-qualified columns.
 *
 * Round 1 established that a `bind[]` join's `where` only resolves a
 * base-table-qualified operand (`q_doc.team`) when the query sets
 * `context.dbo.as` (SDK: `tableAlias`). This round asks how far that goes:
 * does the alias work in the MAIN `where`, in `sort`, in `eval`, and does a
 * bare column still work alongside it?
 *
 * Run: npx tsx scripts/probe-bind-join2.ts
 */
import { readFileSync } from "node:fs";
import "../src/index.js";
import { workspace } from "../src/workspace/xano.js";
import { apiGroup } from "../src/kinds/api-group.js";
import { table } from "../src/kinds/table.js";
import { query } from "../src/kinds/query.js";
import { f } from "../src/fields/catalog.js";
import { s } from "../src/statements/s.js";
import { expr } from "../src/statements/expression.js";
import { c, col, ref } from "../src/values/value.js";
import { createEphemeral, deleteEphemeral, waitUntilReady } from "../src/deploy/ephemeral.js";
import { importWorkspaceArchive } from "../src/deploy/import.js";
import { encodeWorkspaceArchive } from "../src/validate/archive.js";
import type { ResolvedAuth } from "../src/auth/token.js";

function loadEnv(): void {
  try {
    for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim();
    }
  } catch {
    /* no .env */
  }
}
loadEnv();

const INSTANCE = process.env.XANO_VALIDATE_INSTANCE;
const TOKEN = process.env.XANO_VALIDATE_TOKEN;
const PARENT = Number(process.env.XANO_VALIDATE_WORKSPACE_ID ?? 1);
if (!INSTANCE || !TOKEN) throw new Error("set XANO_VALIDATE_INSTANCE and XANO_VALIDATE_TOKEN");

const auth: ResolvedAuth = {
  access_token: TOKEN,
  instance: INSTANCE,
  workspaceId: PARENT,
  credentialType: "token",
};

const api = apiGroup({ name: "probe", canonical: "probe" });
const teamT = table({ name: "q_team", schema: { name: f.text() } });
const docT = table({
  name: "q_doc",
  schema: { title: f.text(), team: f.int({ default: "0" }), meta: f.object({ country: f.text() }) },
});

const seed = query({
  name: "seed",
  verb: "GET",
  apiGroup: api,
  stack: [
    s.db.add({ table: teamT, row: { name: c.text("alpha") }, as: "t" }),
    s.db.add({ table: docT, row: { title: c.text("d1"), team: ref("t.id") } }),
    s.db.add({ table: docT, row: { title: c.text("d2"), team: ref("t.id") } }),
    s.set_var("ok", c.bool(true)),
  ],
  response: ref("ok"),
});

 
const q = (name: string, args: any) =>
  query({
    name,
    verb: "GET",
    apiGroup: api,
    stack: [s.db.query({ table: docT, as: "rows", ...args })],
    response: ref("rows"),
  });

const JOIN_ALIASED = { table: teamT, as: "team_row", join: "left" as const };

/**
 * Cases are built LAZILY. Several of them are the unresolvable spellings this
 * issue is about, and `db.query` now rejects those at export — so the probe
 * records "blocked at export (the fix works)" instead of dying on import. The
 * ones that still build get deployed and hit.
 */
const CASES: { name: string; note: string; build: () => ReturnType<typeof q> }[] = [
  {
    name: "w1_alias_everywhere",
    note: 'tableAlias:"d" — bind where + main where both alias-qualified',
    build: () => q("w1_alias_everywhere", {
      tableAlias: "d",
      bind: [{ ...JOIN_ALIASED, where: expr(col("team_row.id"), "=", col("d.team")) }],
      where: expr(col("d.title"), "=", c.text("d1")),
    }),
  },
  {
    name: "w2_main_where_base_qualified_no_alias",
    note: "no tableAlias — MAIN where qualified with the table name",
    build: () => q("w2_main_where_base_qualified_no_alias", {
      where: expr(col("q_doc.title"), "=", c.text("d1")),
    }),
  },
  {
    name: "w3_main_where_bare_no_alias",
    note: "no tableAlias — MAIN where bare column (the SDK's documented default)",
    build: () => q("w3_main_where_bare_no_alias", { where: expr(col("title"), "=", c.text("d1")) }),
  },
  {
    name: "w4_alias_set_bare_main_where",
    note: 'tableAlias:"d" — MAIN where still bare',
    build: () => q("w4_alias_set_bare_main_where", {
      tableAlias: "d",
      where: expr(col("title"), "=", c.text("d1")),
    }),
  },
  {
    name: "w5_alias_set_bare_bind_where",
    note: 'tableAlias:"d" — bind where uses a BARE base column on the left',
    build: () => q("w5_alias_set_bare_bind_where", {
      tableAlias: "d",
      bind: [{ ...JOIN_ALIASED, where: expr(col("team"), "=", col("team_row.id")) }],
    }),
  },
  {
    name: "w6_sort_joined_dotted",
    note: 'tableAlias:"d" — sort by the JOINED alias path',
    build: () => q("w6_sort_joined_dotted", {
      tableAlias: "d",
      bind: [{ ...JOIN_ALIASED, where: expr(col("team_row.id"), "=", col("d.team")) }],
      sort: [{ sortBy: "team_row.name", dir: "asc" }],
    }),
  },
  {
    name: "w7_sort_joined_dotted_no_alias",
    note: "no tableAlias — sort by the JOINED alias path (bind where uses the bare-left form)",
    build: () => q("w7_sort_joined_dotted_no_alias", {
      bind: [{ ...JOIN_ALIASED, where: expr(col("team"), "=", col("team_row.id")) }],
      sort: [{ sortBy: "team_row.name", dir: "asc" }],
    }),
  },
  {
    name: "w8_eval_joined_dotted",
    note: 'tableAlias:"d" — eval an aliased joined column onto the row',
    build: () => q("w8_eval_joined_dotted", {
      tableAlias: "d",
      bind: [{ ...JOIN_ALIASED, where: expr(col("team_row.id"), "=", col("d.team")) }],
      eval: [{ name: "team_row.name", as: "team_name" }],
    }),
  },
  {
    name: "x1_sort_base_qualified_no_alias",
    note: 'no tableAlias — sort by "q_doc.title"',
    build: () => q("x1_sort_base_qualified_no_alias", { sort: [{ sortBy: "q_doc.title", dir: "asc" }] }),
  },
  {
    name: "x2_eval_base_qualified_no_alias",
    note: 'no tableAlias — eval name "q_doc.title"',
    build: () => q("x2_eval_base_qualified_no_alias", { eval: [{ name: "q_doc.title", as: "t2" }] }),
  },
  {
    name: "x3_aggregate_group_no_alias",
    note: "no tableAlias — aggregate group (the SDK auto-qualifies it to q_doc.team)",
    build: () => q("x3_aggregate_group_no_alias", {
      returnType: "aggregate",
      aggregate: { group: [{ name: "team", as: "team_id" }] },
    }),
  },
  {
    name: "x4_aggregate_group_with_alias",
    note: 'tableAlias:"d" — the same aggregate, qualified to d.team',
    build: () => q("x4_aggregate_group_with_alias", {
      tableAlias: "d",
      returnType: "aggregate",
      aggregate: { group: [{ name: "team", as: "team_id" }] },
    }),
  },
  {
    name: "x5_object_subkey_where",
    note: 'no tableAlias — where on an OBJECT column sub-key: col("meta.country")',
    build: () => q("x5_object_subkey_where", { where: expr(col("meta.country"), "=", c.text("us")) }),
  },
];

const defs = (xs: unknown[]) => xs as never[];

async function main(): Promise<void> {
  const tenant = await createEphemeral(auth, {
    parentWorkspaceId: PARENT,
    display: "sidestep-bind-probe2",
    expiresHours: 1,
  });
  console.log(`ephemeral: ${tenant.name}`);
  try {
    const ready = await waitUntilReady(auth, { parentWorkspaceId: PARENT, name: tenant.name });
    const baseUrl = ready.url ?? tenant.url;
    if (!baseUrl) throw new Error("ephemeral has no base URL");

    const built: { name: string; note: string; def: ReturnType<typeof q> }[] = [];
    for (const cs of CASES) {
      try {
        built.push({ ...cs, def: cs.build() });
      } catch (e) {
        console.log(`\n--- ${cs.name}  [blocked at export]`);
        console.log(`    ${cs.note}`);
        console.log(`    ${(e as Error).message}`);
      }
    }

    await importWorkspaceArchive(auth, {
      baseUrl,
      archive: encodeWorkspaceArchive(
        JSON.stringify(
          workspace("bind-join-probe2")
            .registerApiGroups(defs([api]))
            .registerTables(defs([teamT, docT]))
            .registerQueries(defs([seed, ...built.map((cs) => cs.def)]))
            .export(),
        ),
      ),
    });

    const seeded = await fetch(`${baseUrl}/api:probe/seed`);
    console.log("seed:", seeded.status, (await seeded.text()).slice(0, 120));

    for (const cs of built) {
      const res = await fetch(`${baseUrl}/api:probe/${cs.name}`);
      const body = (await res.text()).slice(0, 260);
      console.log(`\n--- ${cs.name}  [${res.status}]`);
      console.log(`    ${cs.note}`);
      console.log(`    ${body}`);
    }
  } finally {
    await deleteEphemeral(auth, { parentWorkspaceId: PARENT, name: tenant.name }).catch(() => {});
  }
}

await main();
