/**
 * Probe — is a `set_var` with an EMPTY `context` the same statement as one
 * storing the blank const explicitly?
 *
 * The offline claim, traced through the engine's own source: `set_var`'s context
 * IS its tagged value, and the optional-schema pass supplies every member when
 * the key is absent — `tag` from its `?=const` default, `filters` because a list
 * defaults to `[]`, and `value` from the `text` type's `""`. If that holds, an
 * empty `context: {}` is the blank const spelled a second way, and the decoder
 * may read it back as `c.text("")`.
 *
 * A source trace is not a behaviour, so this asks a live engine two questions:
 *
 *   1. EVALUATION — does a `set_var` with an empty context bind the SAME value
 *      as one carrying the explicit blank const? (`""`, not null, not missing.)
 *   2. PERSISTENCE — what does the engine store back for each? If it rewrites
 *      the empty form into the explicit one, the canonicalization direction the
 *      fix takes is the engine's own.
 *
 * Both bundles are the SAME bundle: the empty one is produced by blanking the
 * explicit one's context in place and re-signing, so nothing but the shape under
 * test differs.
 *
 * Run: npx tsx scripts/probe-empty-setvar.ts     (reads .env like the other probes)
 */
import { readFileSync } from "node:fs";
import "../src/index.js";
import { workspace } from "../src/workspace/xano.js";
import { apiGroup } from "../src/kinds/api-group.js";
import { query } from "../src/kinds/query.js";
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

/**
 * `blank` is the statement under test. `sentinel` sits after it so the response
 * can distinguish "the var holds an empty string" from "the query died before
 * reaching the end" — an empty body would otherwise read like a pass.
 */
const val = query({
  name: "val",
  verb: "GET",
  apiGroup: api,
  stack: [s.set_var("blank", c.text("")), s.set_var("sentinel", c.text("reached"))],
  response: { blank: ref("blank"), sentinel: ref("sentinel") },
});

const defs = (xs: unknown[]) => xs as never[];

function explicitBundle(): Record<string, unknown> {
  return workspace("setvar-probe")
    .registerApiGroups(defs([api]))
    .registerQueries(defs([val]))
    .export() as unknown as Record<string, unknown>;
}

/** Re-sign a rewritten payload — the import rejects an unsigned one outright. */
function resign(bundle: Record<string, unknown>): Record<string, unknown> {
  const unsigned = { ...bundle };
  delete unsigned.sig;
  return { ...unsigned, sig: calcSignatureJson(unsigned) };
}

/** Blank the `blank` set_var's context, leaving every other statement alone. */
function emptyContext(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(emptyContext);
  if (node === null || typeof node !== "object") return node;
  const rec = node as Record<string, unknown>;
  if (rec.name === "mvp:set_var" && rec.as === "blank") return { ...rec, context: {} };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = emptyContext(v);
  return out;
}

/** The context the engine STORED for the statement under test. */
function persistedContext(exported: unknown): unknown {
  let found: unknown;
  const walk = (node: unknown): void => {
    if (found !== undefined || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const rec = node as Record<string, unknown>;
    if (rec.name === "mvp:set_var" && rec.as === "blank") {
      found = rec.context;
      return;
    }
    Object.values(rec).forEach(walk);
  };
  walk(exported);
  return found;
}

async function deployAndProbe(
  baseUrl: string,
  payload: Record<string, unknown>,
  label: string,
): Promise<{ body: unknown; persisted: unknown }> {
  await importWorkspaceArchive(auth, {
    baseUrl,
    archive: encodeWorkspaceArchive(JSON.stringify(payload)),
  });

  const res = await fetch(`${baseUrl}/api:probe/val`);
  const body = await res.json();

  const exported = await exportWorkspaceBundle(auth, {
    base: baseUrl,
    workspaceId: 1,
    label: "setvar-probe",
  });
  const persisted = persistedContext(exported);
  if (persisted === undefined) console.log("  !! could not locate the set_var in the export");

  console.log(`\n--- ${label}`);
  console.log("  deployed ctx :", JSON.stringify(persistedContext(payload)));
  console.log("  response     :", `${res.status} ${JSON.stringify(body)}`);
  console.log("  persisted ctx:", JSON.stringify(persisted));
  return { body, persisted };
}

/** Each variant gets its own tenant — a second import into one tenant is rejected. */
async function inFreshTenant<T>(label: string, body: (baseUrl: string) => Promise<T>): Promise<T> {
  const tenant = await createEphemeral(auth, {
    parentWorkspaceId: PARENT,
    display: "sidestep-setvar-probe",
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
  const explicit = explicitBundle();
  const empty = resign(emptyContext(explicitBundle()) as Record<string, unknown>);

  const e = await inFreshTenant("EXPLICIT", (url) => deployAndProbe(url, explicit, "EXPLICIT"));
  const m = await inFreshTenant("EMPTY", (url) => deployAndProbe(url, empty, "EMPTY"));

  console.log("\n=== verdict");
  const sameEval = JSON.stringify(e.body) === JSON.stringify(m.body);
  const samePersist = JSON.stringify(e.persisted) === JSON.stringify(m.persisted);
  console.log(`  evaluation identical : ${sameEval}`);
  console.log(`  persistence identical: ${samePersist}`);
  console.log(
    sameEval
      ? "  → the two spellings are ONE statement; reading the empty form as c.text(\"\") is sound."
      : "  → the spellings DIFFER at runtime; the decode rule is WRONG and must be reverted.",
  );
}

await main();
