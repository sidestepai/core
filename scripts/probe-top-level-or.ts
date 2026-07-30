/**
 * R-D probe — is a FLAT top-level OR the same thing as a WRAPPED one?
 *
 * `encodeExpression` always joins root siblings with AND, so an `or(a, b)` at
 * the root emits one `{type:"group"}` node wrapping both. Real workspaces store
 * the flat spelling instead — `[{or:false, …}, {or:true, …}]` — which the SDK has
 * no way to author, so those statements can only fall back to `raw()`.
 *
 * Splicing a root `or(...)`'s children up to the top level would fix that, but it
 * CHANGES EMITTED BYTES for an authoring form that already ships. That is exactly
 * the class of change the plan says cannot be proven offline, so this probe asks
 * a live engine two questions:
 *
 *   1. EVALUATION — do the two spellings select the same rows / take the same
 *      branch, across the full truth table of a two-term OR?
 *   2. PERSISTENCE — does the engine keep the flat spelling on the way back out,
 *      or normalize it into a group? If it rewrites, the splice is pointless; if
 *      it keeps it, the splice reproduces what real workspaces already store.
 *
 * Both bundles are the SAME bundle: the flat one is produced by rewriting the
 * grouped one's root groups in place, so nothing but the shape under test differs.
 *
 * Run: npx tsx scripts/probe-top-level-or.ts     (reads .env like the other probes)
 */
import { readFileSync } from "node:fs";
import "../src/index.js";
import { workspace } from "../src/workspace/xano.js";
import { apiGroup } from "../src/kinds/api-group.js";
import { table } from "../src/kinds/table.js";
import { query } from "../src/kinds/query.js";
import { f } from "../src/fields/catalog.js";
import { input } from "../src/inputs/input.js";
import { s } from "../src/statements/s.js";
import { cmp, or } from "../src/statements/expression.js";
import { c, col, inp, ref } from "../src/values/value.js";
import { createEphemeral, deleteEphemeral, waitUntilReady } from "../src/deploy/ephemeral.js";
import { importWorkspaceArchive } from "../src/deploy/import.js";
import { encodeWorkspaceArchive } from "../src/validate/archive.js";
import { exportWorkspaceBundle } from "../src/deploy/workspace-export.js";
import { calcSignatureJson } from "../src/workspace/export.js";
import type { ResolvedAuth } from "../src/auth/token.js";

// --- credentials ------------------------------------------------------------
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
/**
 * Built through the REAL authoring surface, so the grouped side is exactly the
 * bytes the SDK ships today — not a hand-written approximation of them. The flat
 * side is then produced by rewriting that same bundle's root groups, so the only
 * difference between the two deployments is the shape under test.
 */
const api = apiGroup({ name: "probe", canonical: "probe" });

const item = table({
  name: "item",
  schema: { a: f.int({ default: "0" }), b: f.int({ default: "0" }), label: f.text() },
});

/** Insert the four rows of the two-term truth table. */
const seed = query({
  name: "seed",
  verb: "GET",
  apiGroup: api,
  stack: [
    s.db.add({ table: item, row: { a: c.int(0), b: c.int(0), label: c.text("neither") } }),
    s.db.add({ table: item, row: { a: c.int(1), b: c.int(0), label: c.text("a-only") } }),
    s.db.add({ table: item, row: { a: c.int(0), b: c.int(1), label: c.text("b-only") } }),
    s.db.add({ table: item, row: { a: c.int(1), b: c.int(1), label: c.text("both") } }),
    s.set_var("ok", c.bool(true)),
  ],
  response: ref("ok"),
});

/** Which rows does the ENGINE select? This expression lives in the query's own
 * search block — where 10 of the 23 real OR containers sit. */
const rows = query({
  name: "rows",
  verb: "GET",
  apiGroup: api,
  stack: [
    s.db.query({
      table: item,
      where: or(cmp(col("a"), "==", c.int(1)), cmp(col("b"), "==", c.int(1))),
      output: ["label"],
      as: "hits",
    }),
  ],
  response: ref("hits"),
});

/** Which branch does the engine take? 13 of the real containers are conditionals,
 * which evaluate at runtime rather than pushing the expression into a read — a
 * separate question from the one `rows` asks. */
const branch = query({
  name: "branch",
  verb: "GET",
  apiGroup: api,
  input: { a: input.int(), b: input.int() },
  stack: [
    s.set_var("taken", c.text("no")),
    s.conditional({
      when: or(cmp(inp("a"), "==", c.int(1)), cmp(inp("b"), "==", c.int(1))),
      then: [s.set_var("taken", c.text("yes"))],
    }),
  ],
  response: ref("taken"),
});

const defs = (xs: unknown[]) => xs as never[];

function groupedBundle(): Record<string, unknown> {
  return workspace("or-probe")
    .registerApiGroups(defs([api]))
    .registerTables(defs([item]))
    .registerQueries(defs([seed, rows, branch]))
    .export() as unknown as Record<string, unknown>;
}

/**
 * Rewrite every root container holding exactly one non-ORed group into that
 * group's children, spliced flat — the transformation the fix would make in the
 * encoder. Applied to the whole bundle so it reaches the query and the
 * conditional alike.
 */
function resign(bundle: Record<string, unknown>): Record<string, unknown> {
  // The bundle is signed over its own contents, so a rewritten payload has to be
  // re-signed or the import rejects it before the engine ever sees the shape.
  const { sig: _drop, ...unsigned } = bundle;
  return { ...unsigned, sig: calcSignatureJson(unsigned) };
}

function spliceRootGroups(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(spliceRootGroups);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "expression" && Array.isArray(value) && value.length === 1) {
      const only = value[0] as Record<string, unknown> | null;
      const inner = (only?.group as { expression?: unknown[] } | undefined)?.expression;
      if (only?.type === "group" && only.or === false && Array.isArray(inner)) {
        out[key] = inner.map(spliceRootGroups);
        continue;
      }
    }
    out[key] = spliceRootGroups(value);
  }
  return out;
}

// --- driver -----------------------------------------------------------------
async function deployAndProbe(
  baseUrl: string,
  payload: Record<string, unknown>,
  label: string,
): Promise<{ rows: unknown; branches: Record<string, unknown>; persisted: unknown }> {
  await importWorkspaceArchive(auth, {
    baseUrl,
    archive: encodeWorkspaceArchive(JSON.stringify(payload)),
  });

  await fetch(`${baseUrl}/api:probe/seed`);
  const selected = await (await fetch(`${baseUrl}/api:probe/rows`)).json();
  const branches: Record<string, unknown> = {};
  for (const [a, b] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    const res = await fetch(`${baseUrl}/api:probe/branch?a=${a}&b=${b}`);
    branches[`a=${a},b=${b}`] = await res.json();
  }

  // What did the engine actually STORE? If it rewrites the flat form back into a
  // group, the splice buys nothing.
  const exported = await exportWorkspaceBundle(auth, {
    base: baseUrl,
    workspaceId: 1,
    label: "or-probe",
  });
  // Walk for the conditional's expression wherever the export puts it, rather
  // than assuming a path — a missed lookup would read as "no OR persisted" and
  // silently turn a failed probe into a passing one.
  let persisted: unknown;
  const findExpr = (node: unknown): void => {
    if (persisted !== undefined || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(findExpr);
    const rec = node as Record<string, unknown>;
    if (rec.name === "mvp:conditional") {
      persisted = (rec.context as { expr?: unknown } | undefined)?.expr;
      if (persisted !== undefined) return;
    }
    Object.values(rec).forEach(findExpr);
  };
  findExpr(exported);
  if (persisted === undefined) console.log("  !! could not locate the conditional in the export");

  console.log(`\n--- ${label}`);
  console.log("  rows selected:", JSON.stringify(selected));
  console.log("  branch taken :", JSON.stringify(branches));
  console.log("  persisted    :", JSON.stringify(persisted));
  return { rows: selected, branches, persisted };
}

/**
 * Each variant gets its OWN tenant. Importing twice into one tenant is rejected
 * ("invalid workspace signature") once the first import has claimed it, and a
 * fresh tenant per variant is the cleaner comparison anyway — neither result can
 * be contaminated by the other's seeded rows.
 */
async function inFreshTenant<T>(
  label: string,
  body: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const tenant = await createEphemeral(auth, {
    parentWorkspaceId: PARENT,
    display: "sidestep-or-probe",
    expiresHours: 1,
  });
  console.log(`ephemeral for ${label}: ${tenant.name}`);
  try {
    const ready = await waitUntilReady(auth, { parentWorkspaceId: PARENT, name: tenant.name });
    const baseUrl = ready.url ?? tenant.url;
    if (!baseUrl) throw new Error("ephemeral has no base URL");
    return await body(baseUrl);
  } finally {
    await deleteEphemeral(auth, { parentWorkspaceId: PARENT, name: tenant.name }).catch(() => {});
  }
}

async function main(): Promise<void> {
  {
    const grouped = groupedBundle();
    const flat = resign(spliceRootGroups(groupedBundle()) as Record<string, unknown>);

    const g = await inFreshTenant("GROUPED", (url) =>
      deployAndProbe(url, grouped, "GROUPED (what the SDK emits today)"),
    );
    const f = await inFreshTenant("FLAT", (url) =>
      deployAndProbe(url, flat, "FLAT (what real workspaces store)"),
    );

    const sameRows = JSON.stringify(g.rows) === JSON.stringify(f.rows);
    const sameBranch = JSON.stringify(g.branches) === JSON.stringify(f.branches);
    // Test the top-level NODES, not the serialized text: every statement node
    // carries an empty `group:{expression:[]}` sibling key, so searching the JSON
    // for "group" reports a wrapper on a form that plainly has none.
    const topNodes = (f.persisted as { expression?: Array<Record<string, unknown>> } | undefined)
      ?.expression;
    const keptFlat = (topNodes ?? []).some((n) => n.or === true);
    const flatIsFlat = (topNodes ?? []).every((n) => n.type === "statement");

    console.log("\n=== VERDICT");
    console.log(`  same rows selected     : ${sameRows}`);
    console.log(`  same branch taken      : ${sameBranch}`);
    console.log(`  flat form persisted    : ${keptFlat && flatIsFlat} (kept an OR sibling: ${keptFlat}, no group wrapper: ${flatIsFlat})`);
    console.log(
      `  → splice is ${sameRows && sameBranch && flatIsFlat ? "SAFE" : "NOT proven"}`,
    );
  }
}

await main();
