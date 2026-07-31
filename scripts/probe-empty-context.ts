/**
 * Probe — is an EMPTY `context` the same statement as one storing the members
 * the engine's optional-schema pass would fill in?
 *
 * `scripts/probe-empty-setvar.ts` settled this for `mvp:set_var`, whose default
 * tag is `const`. It does NOT settle it for the rest of the family, because the
 * default tag is per-statement: the `UpdateVarBase` subclasses override it to
 * `const:decimal`, `const:int` and `const:array`, and `die`/`setheader` default
 * to **input** — a blank input REFERENCE rather than a constant. Assuming one
 * tag across the family would have mis-decoded five statements, so each distinct
 * tag gets deployed and run here.
 *
 * One query per statement under test, each shaped `sentinel="before"` → the
 * statement → `sentinel="after"`, returning the sentinel. If a spelling changes
 * what the engine does, the two deployments differ in status or body.
 *
 * **Both variants are rewrites of the SAME bundle**, and the comparison is
 * EMPTY (`context: {}`) against the FILL the decoder claims it stands for —
 * `{name:"", value:"", tag:<default>, filters:[]}`. An earlier run of this probe
 * compared the empty form against a statement carrying a REAL variable name
 * instead, which differs by construction and proved nothing; the fill is the
 * only comparison that tests the claim. Note the fill is a broken statement in
 * both spellings — it names no variable — so "identical" here means both fail
 * the same way, which is exactly what faithful decoding of broken stored bytes
 * requires.
 *
 * Run: npx tsx scripts/probe-empty-context.ts     (reads .env like the other probes)
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

/** One statement under test, and the stored name whose context gets blanked. */
interface Case {
  readonly route: string;
  readonly stored: string;
  readonly tag: string;
  /** Whether this statement's context also carries the target variable's name. */
  readonly named: boolean;
  /**
   * Set when the default lives on ONE context MEMBER rather than on the whole
   * context — the loops. "Empty" then means that member absent, not `{}`.
   */
  readonly member?: string;
  readonly build: () => unknown;
}

const CASES: readonly Case[] = [
  // const — the tag `set_var` already proved, re-run here through a DIFFERENT
  // statement so the family result does not rest on one surface.
  { route: "text_append", stored: "mvp:text_append", named: true, tag: "const",
    build: () => (s as never as Record<string, Record<string, (a: unknown) => unknown>>).text.append({ name: "acc", value: c.text("x") }) },
  // const:decimal — arithmetic. Number("") is 0, so a blank operand is a no-op.
  { route: "math_sub", stored: "mvp:math_sub", named: true, tag: "const:decimal",
    build: () => (s as never as Record<string, Record<string, (a: unknown) => unknown>>).math.sub({ name: "acc_n", value: c.int(1) }) },
  // const:int — a standalone class with no `name` member.
  { route: "sleep", stored: "mvp:sleep", named: false, tag: "const:int",
    build: () => (s as never as Record<string, Record<string, (a: unknown) => unknown>>).util.sleep({ value: c.int(1) }) },
  // const:array — the only member of the family defaulting to an array.
  { route: "array_merge", stored: "mvp:array_merge", named: true, tag: "const:array",
    build: () => (s as never as Record<string, Record<string, (a: unknown) => unknown>>).array.merge({ name: "acc_a", value: c.array([]) }) },
  // input — the two that do NOT default to a constant. This is the case an
  // analogy from `set_var` would have got wrong.
  { route: "setheader", stored: "mvp:setheader", named: false, tag: "input",
    build: () => (s as never as Record<string, Record<string, (a: unknown) => unknown>>).util.set_header({ value: c.text("x-probe: 1") }) },
  // Member-level defaults: the iterand is one key of the loop's context, so
  // "empty" is that key ABSENT. `foreach` defaults to a var REFERENCE.
  { route: "foreach", stored: "mvp:foreach", named: false, tag: "var", member: "list",
    build: () => s.foreach({ as: "row", list: ref("acc_a"), body: [] }) },
  { route: "forloop", stored: "mvp:for", named: false, tag: "const:int", member: "cnt",
    build: () => s.for({ as: "i", count: c.int(2), body: [] }) },
];

const defs = (xs: unknown[]) => xs as never[];

function bundle(): Record<string, unknown> {
  const queries = CASES.map((cs) =>
    query({
      name: cs.route,
      verb: "GET",
      apiGroup: api,
      stack: [
        s.set_var("acc", c.text("seed")),
        s.set_var("acc_n", c.int(10)),
        s.set_var("acc_a", c.array([])),
        s.set_var("sentinel", c.text("before")),
        cs.build() as never,
        s.set_var("sentinel", c.text("after")),
      ],
      response: { sentinel: ref("sentinel"), acc: ref("acc"), acc_n: ref("acc_n") },
    }),
  );
  return workspace("empty-ctx-probe")
    .registerApiGroups(defs([api]))
    .registerQueries(defs(queries))
    .export() as unknown as Record<string, unknown>;
}

/** Re-sign a rewritten payload — the import rejects an unsigned one outright. */
function resign(b: Record<string, unknown>): Record<string, unknown> {
  const unsigned = { ...b };
  delete unsigned.sig;
  return { ...unsigned, sig: calcSignatureJson(unsigned) };
}

const UNDER_TEST = new Map(CASES.map((cs) => [cs.stored, cs]));

/**
 * Rewrite every statement under test's context — to `{}`, or to the fill the
 * decoder claims that empty form stands for. Everything else is left alone.
 */
function rewriteContexts(node: unknown, mode: "empty" | "fill"): unknown {
  if (Array.isArray(node)) return node.map((n) => rewriteContexts(n, mode));
  if (node === null || typeof node !== "object") return node;
  const rec = node as Record<string, unknown>;
  const cs = typeof rec.name === "string" ? UNDER_TEST.get(rec.name) : undefined;
  if (cs) {
    const blank = { value: "", tag: cs.tag, filters: [] };
    if (cs.member) {
      // Member-level: drop the key, or set it to the blank value.
      const ctx = { ...(rec.context as Record<string, unknown>) };
      if (mode === "empty") delete ctx[cs.member];
      else ctx[cs.member] = blank;
      return { ...rec, context: ctx };
    }
    const fill = cs.named ? { name: "", ...blank } : blank;
    return { ...rec, context: mode === "empty" ? {} : fill };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = rewriteContexts(v, mode);
  return out;
}

/** The context the engine STORED for each statement under test. */
function persisted(exported: unknown): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const rec = node as Record<string, unknown>;
    if (typeof rec.name === "string" && UNDER_TEST.has(rec.name) && !(rec.name in found)) {
      found[rec.name] = JSON.stringify(rec.context);
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
): Promise<{ responses: Record<string, string>; stored: Record<string, string> }> {
  await importWorkspaceArchive(auth, {
    baseUrl,
    archive: encodeWorkspaceArchive(JSON.stringify(payload)),
  });

  const responses: Record<string, string> = {};
  for (const cs of CASES) {
    const res = await fetch(`${baseUrl}/api:probe/${cs.route}`);
    responses[cs.route] = `${res.status} ${(await res.text()).slice(0, 160)}`;
  }
  const exported = await exportWorkspaceBundle(auth, {
    base: baseUrl,
    workspaceId: 1,
    label: "empty-ctx-probe",
  });

  console.log(`\n--- ${label}`);
  for (const cs of CASES) console.log(`  ${cs.route.padEnd(12)} ${responses[cs.route]}`);
  return { responses, stored: persisted(exported) };
}

/** Each variant gets its own tenant — a second import into one is rejected. */
async function inFreshTenant<T>(label: string, body: (baseUrl: string) => Promise<T>): Promise<T> {
  const tenant = await createEphemeral(auth, {
    parentWorkspaceId: PARENT,
    display: "sidestep-empty-ctx-probe",
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
  const filled = resign(rewriteContexts(bundle(), "fill") as Record<string, unknown>);
  const empty = resign(rewriteContexts(bundle(), "empty") as Record<string, unknown>);

  const e = await inFreshTenant("FILLED", (u) => deployAndProbe(u, filled, "FILLED"));
  const m = await inFreshTenant("EMPTY", (u) => deployAndProbe(u, empty, "EMPTY"));

  console.log("\n=== verdict (per tag)");
  let allSame = true;
  for (const cs of CASES) {
    const same = e.responses[cs.route] === m.responses[cs.route];
    allSame &&= same;
    console.log(`  ${cs.tag.padEnd(14)} ${cs.route.padEnd(12)} identical=${same}`);
    if (!same) {
      console.log(`      filled: ${e.responses[cs.route]}`);
      console.log(`      empty   : ${m.responses[cs.route]}`);
    }
  }
  console.log("\n=== what the engine persisted");
  for (const n of UNDER_TEST.keys()) {
    console.log(`  ${n.padEnd(20)} filled=${e.stored[n]}  empty=${m.stored[n]}`);
  }
  console.log(
    allSame
      ? "\n→ every tag behaves identically; reading an empty context as the filled one is sound."
      : "\n→ a tag DIFFERS at runtime; that statement must be removed from the fill table.",
  );
}

await main();
