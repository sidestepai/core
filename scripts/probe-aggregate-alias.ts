/**
 * Does the CAPTURED `db_query_aggregate` fixture shape actually RUN? (#213 follow-up)
 *
 * The corpus fixture USED TO store `group`/`eval` names qualified by the table
 * name (`posts.published`) with no `context.dbo.as` beside them. It had been
 * captured from a live engine — but via `_capture.ts`, which deploys bytes THIS
 * SDK authored and reads back what the engine stored. Round-tripping a statement
 * is not the same as executing it, so that golden was never evidence the shape
 * ran. It did not: `Unsupported object reference - posts.published`.
 *
 * `db.query` now declares the alias it qualifies with, so the authored form is
 * fixed and a1/a2 both pass. a0 reconstructs the PRE-FIX bytes by stripping
 * `dbo.as` back out of the emitted bundle (and re-signing it), so this file keeps
 * reproducing the original failure rather than quietly agreeing with itself.
 * a3 checks that an author-dotted name — what codegen emits when pulling a stored
 * workspace — is still left alone, which is what keeps a pull byte-exact.
 *
 * Run: npx tsx scripts/probe-aggregate-alias.ts
 */
import { readFileSync } from "node:fs";
import "../src/index.js";
import { workspace } from "../src/workspace/xano.js";
import { apiGroup } from "../src/kinds/api-group.js";
import { table } from "../src/kinds/table.js";
import { query } from "../src/kinds/query.js";
import { f } from "../src/fields/catalog.js";
import { s } from "../src/statements/s.js";
import { c, ref } from "../src/values/value.js";
import { createEphemeral, deleteEphemeral, waitUntilReady } from "../src/deploy/ephemeral.js";
import { importWorkspaceArchive } from "../src/deploy/import.js";
import { encodeWorkspaceArchive } from "../src/validate/archive.js";
import { calcSignatureJson } from "../src/workspace/export.js";
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
const posts = table({
  name: "posts",
  schema: { published: f.bool(), score: f.decimal({ default: "0" }) },
});

const seed = query({
  name: "seed",
  verb: "GET",
  apiGroup: api,
  stack: [
    s.db.add({ table: posts, row: { published: c.bool(true), score: c.decimal(3) } }),
    s.db.add({ table: posts, row: { published: c.bool(true), score: c.decimal(4) } }),
    s.db.add({ table: posts, row: { published: c.bool(false), score: c.decimal(9) } }),
    s.set_var("ok", c.bool(true)),
  ],
  response: ref("ok"),
});

const AGG = {
  group: [{ name: "published", as: "published" }],
  eval: [
    { name: "id", as: "count", filters: [{ name: "count" }] },
    { name: "score", as: "total", filters: [{ name: "sum" }] },
  ],
};

 
const q = (name: string, args: any) =>
  query({
    name,
    verb: "GET",
    apiGroup: api,
    stack: [s.db.query({ table: posts, returnType: "aggregate", as: "rollup", ...args })],
    response: ref("rollup"),
  });

const CASES: { name: string; note: string; def: ReturnType<typeof q> }[] = [
  {
    name: "a1_fixture_shape",
    note: "bare authored names, no tableAlias — the previously-captured golden's authoring",
    def: q("a1_fixture_shape", { aggregate: AGG }),
  },
  {
    name: "a2_with_alias",
    note: 'the same statement with tableAlias:"posts"',
    def: q("a2_with_alias", { tableAlias: "posts", aggregate: AGG }),
  },
  {
    name: "a3_author_dotted_with_alias",
    note: 'author-dotted names + tableAlias:"posts" (what a pulled workspace re-emits)',
    def: q("a3_author_dotted_with_alias", {
      tableAlias: "posts",
      aggregate: {
        group: [{ name: "posts.published", as: "published" }],
        eval: [{ name: "posts.id", as: "count", filters: [{ name: "count" }] }],
      },
    }),
  },
];

const defs = (xs: unknown[]) => xs as never[];

/** Remove every `dbo.as` in a bundle — reconstructs the shape that predates the fix. */
function stripDboAs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripDboAs);
  if (node === null || typeof node !== "object") return node;
  const rec = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === "dbo" && v !== null && typeof v === "object" && "as" in (v as object)) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.as;
      out[k] = rest;
      continue;
    }
    out[k] = stripDboAs(v);
  }
  return out;
}

async function main(): Promise<void> {
  const tenant = await createEphemeral(auth, {
    parentWorkspaceId: PARENT,
    display: "sidestep-agg-probe",
    expiresHours: 1,
  });
  console.log(`ephemeral: ${tenant.name}`);
  try {
    const ready = await waitUntilReady(auth, { parentWorkspaceId: PARENT, name: tenant.name });
    const baseUrl = ready.url ?? tenant.url;
    if (!baseUrl) throw new Error("ephemeral has no base URL");

    const bundle = workspace("agg-probe")
      .registerApiGroups(defs([api]))
      .registerTables(defs([posts]))
      .registerQueries(defs([seed, ...CASES.map((cs) => cs.def)]))
      .export() as unknown as Record<string, unknown>;

    // a0 — the PRE-FIX bytes: same bundle with every `dbo.as` stripped back out.
    // The bundle is signed over its own contents, so it has to be re-signed or the
    // import is rejected before the engine sees the shape.
    const stripped = stripDboAs(structuredClone(bundle)) as Record<string, unknown>;
    delete stripped.sig;
    const preFix = { ...stripped, sig: calcSignatureJson(stripped) };

    await importWorkspaceArchive(auth, {
      baseUrl,
      archive: encodeWorkspaceArchive(JSON.stringify(preFix)),
    });
    const a0 = await fetch(`${baseUrl}/api:probe/a1_fixture_shape`);
    console.log(`\n--- a0_pre_fix_bytes  [${a0.status}]`);
    console.log("    the same statement with `dbo.as` stripped — what the old golden froze");
    console.log(`    ${(await a0.text()).slice(0, 300)}`);

    await importWorkspaceArchive(auth, {
      baseUrl,
      archive: encodeWorkspaceArchive(JSON.stringify(bundle)),
    });

    const seeded = await fetch(`${baseUrl}/api:probe/seed`);
    console.log("seed:", seeded.status, (await seeded.text()).slice(0, 120));

    for (const cs of CASES) {
      const res = await fetch(`${baseUrl}/api:probe/${cs.name}`);
      console.log(`\n--- ${cs.name}  [${res.status}]`);
      console.log(`    ${cs.note}`);
      console.log(`    ${(await res.text()).slice(0, 300)}`);
    }
  } finally {
    await deleteEphemeral(auth, { parentWorkspaceId: PARENT, name: tenant.name }).catch(() => {});
  }
}

await main();
