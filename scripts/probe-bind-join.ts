/**
 * #213 probe — does a `db.query` `bind[]` join accept the dotted `alias.column`
 * form the docs specify, and if not, WHICH spelling does the engine accept?
 *
 * The report: `expr(col("team_row.id"), "=", col("q_doc.team"))` in a bind's
 * `where` fails at runtime with
 *   ParseError: Invalid value for param:"team_row.id"
 * The engine's own stored fixture for a join uses the same dotted shape, so the
 * question is which SIDE / which spelling the engine actually resolves.
 *
 * Every variant below is one endpoint in ONE tenant, so a single deploy answers
 * the whole matrix. Each returns rows or the engine's error verbatim.
 *
 * Run: npx tsx scripts/probe-bind-join.ts    (reads .env like the other probes)
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
import type { DbWhere } from "../src/statements/special/db.js";

function loadEnv(): void {
  try {
    for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim();
    }
  } catch {
    /* no .env — rely on the environment */
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

// --- the probe workspace ----------------------------------------------------
const api = apiGroup({ name: "probe", canonical: "probe" });

const teamT = table({ name: "q_team", schema: { name: f.text() } });
const docT = table({ name: "q_doc", schema: { title: f.text(), team: f.int({ default: "0" }) } });

const seed = query({
  name: "seed",
  verb: "GET",
  apiGroup: api,
  stack: [
    s.db.add({ table: teamT, row: { name: c.text("alpha") }, as: "t" }),
    s.db.add({ table: docT, row: { title: c.text("d1"), team: ref("t.id") } }),
    s.set_var("ok", c.bool(true)),
  ],
  response: ref("ok"),
});

/** One endpoint per candidate spelling of the SAME join condition. */
const VARIANTS: { name: string; note: string; where: DbWhere; tableAlias?: string }[] = [
  {
    name: "v1_joined_left_dotted",
    note: 'expr(col("team_row.id"), "=", col("q_doc.team")) — exactly as reported',
    where: expr(col("team_row.id"), "=", col("q_doc.team")),
  },
  {
    name: "v2_base_left_dotted",
    note: 'operands swapped: expr(col("q_doc.team"), "=", col("team_row.id"))',
    where: expr(col("q_doc.team"), "=", col("team_row.id")),
  },
  {
    name: "v3_joined_left_bare",
    note: 'bare left: expr(col("id"), "=", col("q_doc.team"))',
    where: expr(col("id"), "=", col("q_doc.team")),
  },
  {
    name: "v4_base_left_bare",
    note: 'bare left: expr(col("team"), "=", col("team_row.id"))',
    where: expr(col("team"), "=", col("team_row.id")),
  },
  {
    name: "v5_joined_left_dotted_bare_right",
    note: 'dotted joined alias on the LEFT, bare base column right: col("team_row.id") = col("team")',
    where: expr(col("team_row.id"), "=", col("team")),
  },
  {
    name: "v6_base_qualified_right_only",
    note: 'isolates the base-table qualifier on the right: col("team") = col("q_doc.id")',
    where: expr(col("team"), "=", col("q_doc.id")),
  },
  {
    name: "v7_alias_declared",
    note: 'same as v1 but the base table declares tableAlias:"q_doc" explicitly',
    tableAlias: "q_doc",
    where: expr(col("team_row.id"), "=", col("q_doc.team")),
  },
  {
    name: "v8_alias_declared_distinct",
    note: 'base tableAlias:"d" — both sides dotted: col("team_row.id") = col("d.team")',
    tableAlias: "d",
    where: expr(col("team_row.id"), "=", col("d.team")),
  },
];

const endpoints = VARIANTS.map((v) =>
  query({
    name: v.name,
    verb: "GET",
    apiGroup: api,
    stack: [
      s.db.query({
        table: docT,
        ...(v.tableAlias ? { tableAlias: v.tableAlias } : {}),
        bind: [{ table: teamT, as: "team_row", join: "left", where: v.where }],
        as: "rows",
      }),
    ],
    response: ref("rows"),
  }),
);

const defs = (xs: unknown[]) => xs as never[];

function bundle(): Record<string, unknown> {
  return workspace("bind-join-probe")
    .registerApiGroups(defs([api]))
    .registerTables(defs([teamT, docT]))
    .registerQueries(defs([seed, ...endpoints]))
    .export() as unknown as Record<string, unknown>;
}

async function main(): Promise<void> {
  const tenant = await createEphemeral(auth, {
    parentWorkspaceId: PARENT,
    display: "sidestep-bind-probe",
    expiresHours: 1,
  });
  console.log(`ephemeral: ${tenant.name}`);
  try {
    const ready = await waitUntilReady(auth, { parentWorkspaceId: PARENT, name: tenant.name });
    const baseUrl = ready.url ?? tenant.url;
    if (!baseUrl) throw new Error("ephemeral has no base URL");

    await importWorkspaceArchive(auth, {
      baseUrl,
      archive: encodeWorkspaceArchive(JSON.stringify(bundle())),
    });

    const seeded = await fetch(`${baseUrl}/api:probe/seed`);
    console.log("seed:", seeded.status, (await seeded.text()).slice(0, 200));

    for (const v of VARIANTS) {
      const res = await fetch(`${baseUrl}/api:probe/${v.name}`);
      const body = (await res.text()).slice(0, 300);
      console.log(`\n--- ${v.name}  [${res.status}]`);
      console.log(`    ${v.note}`);
      console.log(`    ${body}`);
    }

    // What XanoScript does the engine render each of these to? That is the form
    // the runtime parser sees, and the only way to tell an operand it treats as a
    // column reference from one it treats as a literal.
    const md = await fetch(
      new URL(`/api:meta/workspace/${PARENT}/tenant/${tenant.name}/multidoc`, INSTANCE),
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    const text = await md.text();
    console.log("\n=== multidoc (raw) ===");
    console.log(text);
  } finally {
    await deleteEphemeral(auth, { parentWorkspaceId: PARENT, name: tenant.name }).catch(() => {});
  }
}

await main();
