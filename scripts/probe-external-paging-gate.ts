/**
 * Probe — does a classic `external` blob need `context.return.<type>.paging`
 * with `enabled: true` for its page/per_page to take effect?
 *
 * The SDK assumes it does: `encodeReturn` is called with `forceEnabled = true`
 * whenever `external` is set, so it always writes a paging block. Three real
 * `db.query` statements store `external` with NO paging block at all
 * (`context.return` is the bare `{type:"list"}`), which the SDK therefore cannot
 * reproduce — they fall back to `raw()`.
 *
 * Only the engine can say which is right, and the answer decides the fix:
 *
 *  - if the gate IS required, those stored queries simply do not paginate, the
 *    SDK's forced gate is correct, and `raw()` is the right outcome for them;
 *  - if it is NOT required, the force is over-eager — it writes bytes the engine
 *    does not need, and dropping it would let those three decode.
 *
 * Five rows are seeded and the query asks `external` for `per_page: 2`. Both
 * variants are rewrites of the SAME bundle: the gated one is what the SDK emits
 * today, the ungated one has `context.return` replaced with the bare
 * `{type:"list"}` those workspaces actually store.
 *
 * Run: npx tsx scripts/probe-external-paging-gate.ts   (reads .env like the others)
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
import { exportWorkspaceBundle } from "../src/deploy/workspace-export.js";
import { calcSignatureJson } from "../src/workspace/export.js";
import type { ResolvedAuth } from "../src/auth/token.js";

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

const api = apiGroup({ name: "probe", canonical: "probe" });
const item = table({ name: "item", schema: { label: f.text() } });

const seed = query({
  name: "seed",
  verb: "GET",
  apiGroup: api,
  stack: [
    ...["a", "b", "c", "d", "e"].map((l) => s.db.add({ table: item, row: { label: c.text(l) } })),
    s.set_var("ok", c.bool(true)),
  ],
  response: ref("ok"),
});

/**
 * `per_page: 2` asked for through the classic blob. `permissions.per_page`
 * defaults to FALSE, so it has to be turned on explicitly or the engine ignores
 * the field regardless of the gate — which would make both variants agree for
 * the wrong reason.
 */
const paged = query({
  name: "paged",
  verb: "GET",
  apiGroup: api,
  stack: [
    s.db.query({
      table: item,
      external: {
        value: c.obj({ page: 1, per_page: 2 }),
        permissions: { page: true, per_page: true, search: true, sort: true },
      },
      as: "rows",
    }),
  ],
  response: ref("rows"),
});

const defs = (xs: unknown[]) => xs as never[];

function bundle(): Record<string, unknown> {
  return workspace("ext-gate-probe")
    .registerApiGroups(defs([api]))
    .registerTables(defs([item]))
    .registerQueries(defs([seed, paged]))
    .export() as unknown as Record<string, unknown>;
}

function resign(b: Record<string, unknown>): Record<string, unknown> {
  const unsigned = { ...b };
  delete unsigned.sig;
  return { ...unsigned, sig: calcSignatureJson(unsigned) };
}

/** Replace every `db.query`'s return block with the bare `{type:"list"}`. */
function ungate(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(ungate);
  if (node === null || typeof node !== "object") return node;
  const rec = node as Record<string, unknown>;
  if (rec.name === "mvp:dbo_view" && rec.context !== null && typeof rec.context === "object") {
    return { ...rec, context: { ...(rec.context as object), return: { type: "list" } } };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = ungate(v);
  return out;
}

/** The `context.return` the engine stored for the paged query. */
function storedReturn(exported: unknown): string {
  let found: string | undefined;
  const walk = (node: unknown): void => {
    if (found !== undefined || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const rec = node as Record<string, unknown>;
    if (rec.name === "mvp:dbo_view") {
      found = JSON.stringify((rec.context as { return?: unknown } | undefined)?.return);
      return;
    }
    Object.values(rec).forEach(walk);
  };
  walk(exported);
  return found ?? "(not found)";
}

async function deployAndProbe(
  baseUrl: string,
  payload: Record<string, unknown>,
  label: string,
): Promise<{ count: number | string; body: string; stored: string }> {
  await importWorkspaceArchive(auth, {
    baseUrl,
    archive: encodeWorkspaceArchive(JSON.stringify(payload)),
  });
  await fetch(`${baseUrl}/api:probe/seed`);
  const res = await fetch(`${baseUrl}/api:probe/paged`);
  const text = await res.text();
  let count: number | string = "(unparsed)";
  try {
    const j = JSON.parse(text);
    count = Array.isArray(j) ? j.length : Array.isArray(j?.items) ? `envelope:${j.items.length}` : "(not a list)";
  } catch {
    /* leave unparsed */
  }
  const exported = await exportWorkspaceBundle(auth, {
    base: baseUrl,
    workspaceId: 1,
    label: "ext-gate-probe",
  });

  console.log(`\n--- ${label}`);
  console.log(`  rows returned : ${count}   (5 seeded, external asked for per_page 2)`);
  console.log(`  body          : ${text.slice(0, 140)}`);
  const stored = storedReturn(exported);
  console.log(`  stored return : ${stored}`);
  return { count, body: text, stored };
}

async function inFreshTenant<T>(label: string, body: (baseUrl: string) => Promise<T>): Promise<T> {
  const tenant = await createEphemeral(auth, {
    parentWorkspaceId: PARENT,
    display: "sidestep-ext-gate-probe",
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
  const gated = bundle();
  const ungated = resign(ungate(bundle()) as Record<string, unknown>);

  const g = await inFreshTenant("GATED (what the SDK writes)", (u) =>
    deployAndProbe(u, gated, "GATED — return.list.paging.enabled = true"),
  );
  const u = await inFreshTenant("UNGATED (what those workspaces store)", (uu) =>
    deployAndProbe(uu, ungated, "UNGATED — return is the bare {type:\"list\"}"),
  );

  console.log("\n=== verdict");
  console.log(`  gated   → ${g.count}`);
  console.log(`  ungated → ${u.count}`);
  const same = String(g.count) === String(u.count);
  console.log(
    same
      ? "  → SAME response shape: the gate changes nothing observable here, so forcing\n" +
          "    the paging block writes bytes the engine does not need."
      : "  → DIFFERENT response shapes. The gate is what produces the paging ENVELOPE\n" +
        "    ({items, curPage, perPage, …}); without it the query returns a bare array.\n" +
        "    So a stored query with `external` and NO paging block cannot be authored\n" +
        "    through the SDK without changing what its callers receive — `raw()` is the\n" +
        "    correct outcome for those, and the fallback should stay.",
  );
  console.log(
    "\n  NOT settled by this run: whether the blob's `per_page` is honoured at all.\n" +
      "  It asked for 2 and BOTH variants returned all 5 (the gated one reporting\n" +
      "  perPage 25), so the stated reason for forcing the gate — 'so its page/per_page\n" +
      "  take effect' — is unverified. Worth its own probe before trusting that comment.",
  );
}

await main();
