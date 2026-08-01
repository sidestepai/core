/**
 * Probe — when the SDK OMITS an optional context member, what does the engine
 * persist back?
 *
 * A decode-side proof is not enough for these. `prove` only shows that the SDK's
 * re-encode reproduces the bytes it was handed; it says nothing about what a
 * real engine writes when it is handed the SDK's own spelling. If the engine
 * materializes an absent member on the way in, then every deploy → pull cycle
 * diverges from the tree that produced it, and the offline corpus cannot see it.
 *
 * Two members, both reached by omitting an optional argument:
 *
 *   • `mvp:realtime_event`'s `context.auth.dbo_id`. The editor's form always
 *     materializes it (stored `0` when no auth table is bound); the SDK writes
 *     nothing. `RealtimeEvent::process` reads `$data["auth"]["dbo_id"] ?? 0`
 *     twice, so the two spellings are the same VALUE — this asks the separate
 *     question of which one comes back out.
 *
 *   • `mvp:array_shift`'s `context.name`, the statement whose empty context this
 *     SDK now fills. The engine's schema declares `name?='': context.name`, so
 *     an unconfigured stub stores `{}` and the SDK re-exports `{name:""}`. Same
 *     question: which does a round trip settle on?
 *
 * Deploys ONE bundle into a fresh tenant, exports it straight back, and prints
 * the stored context beside the one the SDK encoded. Statements are deliberately
 * left unconfigured, because that is the shape the corpus actually holds.
 *
 * Run: npx tsx scripts/probe-persisted-defaults.ts   (reads .env like the other probes)
 */
import { readFileSync } from "node:fs";
import "../src/index.js";
import { workspace } from "../src/workspace/xano.js";
import { apiGroup } from "../src/kinds/api-group.js";
import { query } from "../src/kinds/query.js";
import { s } from "../src/statements/s.js";
import { c, ref } from "../src/values/value.js";
import { encodeStatement } from "../src/statements/statement.js";
import { createEphemeral, deleteEphemeral, waitUntilReady } from "../src/deploy/ephemeral.js";
import { importWorkspaceArchive } from "../src/deploy/import.js";
import { encodeWorkspaceArchive } from "../src/validate/archive.js";
import { exportWorkspaceBundle } from "../src/deploy/workspace-export.js";
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

const anyS = s as unknown as Record<string, Record<string, (a?: unknown) => unknown>>;

/** The statements under test, each built the way the SDK would author it. */
const CASES: ReadonlyArray<{ stored: string; build: () => unknown }> = [
  // No `authTable` — the omission under test.
  {
    stored: "mvp:realtime_event",
    build: () =>
      anyS.api!.realtime_event!({
        channel: c.text("probe"),
        data: c.obj({}),
        authId: c.text(""),
      }),
  },
  // No `name` — an unconfigured shift, exactly as the corpus stores it.
  { stored: "mvp:array_shift", build: () => anyS.array!.shift!() },
];

const defs = (xs: unknown[]) => xs as never[];

function bundle(): Record<string, unknown> {
  const q = query({
    name: "probe",
    verb: "GET",
    apiGroup: api,
    stack: [s.set_var("sentinel", c.text("ok")), ...CASES.map((cs) => cs.build() as never)],
    response: { sentinel: ref("sentinel") },
  });
  return workspace("persisted-defaults-probe")
    .registerApiGroups(defs([api]))
    .registerQueries(defs([q]))
    .export() as unknown as Record<string, unknown>;
}

/**
 * JSON with object keys in a stable order.
 *
 * The engine reorders context members on the way through — it stores
 * `{tag,value,filters}` where the SDK writes `{value,tag,filters}` — and key
 * order carries no meaning in either. Comparing raw JSON reports every statement
 * as DIFFERING and buries the one question being asked, which is whether a
 * MEMBER appeared or vanished.
 */
function stable(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v === null || typeof v !== "object") return v;
    const rec = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(rec).sort().map((k) => [k, sort(rec[k])]));
  };
  return JSON.stringify(sort(value));
}

/** The context the engine STORED for each statement under test. */
function persisted(exported: unknown): Record<string, string> {
  const want = new Set(CASES.map((cs) => cs.stored));
  const found: Record<string, string> = {};
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const rec = node as Record<string, unknown>;
    if (typeof rec.name === "string" && want.has(rec.name) && !(rec.name in found)) {
      found[rec.name] = stable(rec.context);
    }
    Object.values(rec).forEach(walk);
  };
  walk(exported);
  return found;
}

async function main(): Promise<void> {
  const payload = bundle();

  const tenant = await createEphemeral(auth, {
    parentWorkspaceId: PARENT,
    display: "sidestep-persisted-defaults",
    expiresHours: 1,
  });
  console.log(`ephemeral: ${tenant.name}`);
  try {
    const ready = await waitUntilReady(auth, { parentWorkspaceId: PARENT, name: tenant.name });
    const baseUrl = ready.url ?? tenant.url;
    if (!baseUrl) throw new Error("ephemeral has no base URL");

    await importWorkspaceArchive(auth, {
      baseUrl,
      archive: encodeWorkspaceArchive(JSON.stringify(payload)),
    });

    const res = await fetch(`${baseUrl}/api:probe/probe`);
    console.log(`\nGET /api:probe/probe -> ${res.status} ${(await res.text()).slice(0, 200)}`);

    const exported = await exportWorkspaceBundle(auth, {
      base: baseUrl,
      workspaceId: 1,
      label: "persisted-defaults-probe",
    });
    const stored = persisted(exported);

    console.log("\n=== what the SDK encoded vs what the engine persisted");
    let drift = false;
    for (const cs of CASES) {
      const sent = stable(
        (encodeStatement(cs.build() as never) as unknown as { context: unknown }).context,
      );
      const back = stored[cs.stored] ?? "<not found in export>";
      const same = sent === back;
      if (!same) drift = true;
      console.log(`\n  ${cs.stored}  ${same ? "IDENTICAL" : "DIFFERS"}`);
      console.log(`    sent:      ${sent}`);
      console.log(`    persisted: ${back}`);
    }
    console.log(
      drift
        ? "\nVERDICT: the engine rewrites at least one of these — the SDK must write what it writes."
        : "\nVERDICT: the engine persists the SDK's spelling verbatim. Omitting is safe.",
    );
  } finally {
    await deleteEphemeral(auth, { parentWorkspaceId: PARENT, name: tenant.name }).catch(() => {});
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
