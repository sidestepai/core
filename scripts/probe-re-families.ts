/**
 * R-E probe — the three undiagnosed families, settled in one deployment.
 *
 * All three reduce to the same kind of question, which only a live engine can
 * answer: what does the engine ACCEPT, and what does it PERSIST?
 *
 *   1. `create_image` stores `input: [{tag:"auth", name:"id", value:"id"}]` on 26
 *      statements, byte-identical every time, while the statement's declared
 *      context schema has no `input[]` at all. Vestigial, or live-but-undeclared?
 *      Either way the SDK must not silently drop a stored binding — so the
 *      question that matters is whether the engine keeps it on the way out.
 *
 *   2. `create_auth` stores its four entries in TWO orders: `dbtable, extras,
 *      expiration, id` (21 of 25) and `id, dbtable, extras, expiration` (4 of 25,
 *      the one the SDK writes). If both mint a token, order is presentation and
 *      the comparison should stop caring; if only one does, order is semantics.
 *
 *   3. `precondition` declares `error` as a tagged value and the SDK writes one,
 *      but real workspaces store a bare string there. Which does the engine keep?
 *
 * Run: npx tsx scripts/probe-re-families.ts
 */
import { readFileSync } from "node:fs";
import "../src/index.js";
import { workspace } from "../src/workspace/xano.js";
import { apiGroup } from "../src/kinds/api-group.js";
import { table } from "../src/kinds/table.js";
import { query } from "../src/kinds/query.js";
import { f } from "../src/fields/catalog.js";
import { s } from "../src/statements/s.js";
import { raw } from "../src/statements/special/raw.js";
import { expr } from "../src/statements/expression.js";
import { c, ref } from "../src/values/value.js";
import { deriveGuid } from "../src/refs/guid.js";
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
    /* rely on the environment */
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
const users = table({
  name: "user",
  auth: true,
  schema: { email: f.email(), name: f.text() },
});
const USER_GUID = deriveGuid("dbo", "user");

/** One rich input entry in the stored spelling. */
function entry(name: string, value: string, tag: string): Record<string, unknown> {
  return { name, value, tag, filters: [], ignore: false, expand: false, children: [] };
}

const seed = query({
  name: "seed",
  verb: "GET",
  apiGroup: api,
  stack: [
    s.db.add({ table: users, row: { email: c.text("a@b.c"), name: c.text("A") }, as: "u" }),
  ],
  response: ref("u"),
});

/** The SDK's entry order — `id` first (4 of 25 real statements). */
const mintSdkOrder = query({
  name: "mint_sdk_order",
  verb: "GET",
  apiGroup: api,
  stack: [
    s.security.create_auth_token({
      table: users,
      id: c.int(1),
      extras: c.obj({}),
      expiration: c.int(86400),
      as: "tok",
    }),
  ],
  response: ref("tok"),
});

/** The majority stored order — `id` LAST (21 of 25). Hand-written, because the
 * SDK has no way to emit it. */
const mintStoredOrder = query({
  name: "mint_stored_order",
  verb: "GET",
  apiGroup: api,
  stack: [
    raw({
      name: "mvp:create_auth",
      as: "tok",
      context: {},
      input: [
        entry("dbtable", USER_GUID, "const"),
        entry("extras", "{}", "const:obj"),
        entry("expiration", "86400", "const:int"),
        entry("id", "1", "const:int"),
      ],
    }),
  ],
  response: ref("tok"),
});

/** A precondition whose `error` the SDK writes as a TAGGED VALUE. */
const precond = query({
  name: "precond",
  verb: "GET",
  apiGroup: api,
  stack: [
    s.set_var("status", c.int(200)),
    s.precondition({
      expr: expr(ref("status"), "=", c.int(200)),
      error: c.text("Access Denied."),
      error_type: "accessdenied",
    }),
    s.set_var("ok", c.bool(true)),
  ],
  response: ref("ok"),
});

/** `create_image` carrying the stored `input[]` its schema does not declare. */
const image = query({
  name: "image",
  verb: "GET",
  apiGroup: api,
  stack: [
    raw({
      name: "mvp:create_image",
      as: "image",
      addon: [],
      input: [entry("id", "id", "auth")],
      output: { items: [], filters: [], customize: false },
      context: { tag: "input", value: "content", filters: [] },
    }),
  ],
  response: c.bool(true),
});

const defs = (xs: unknown[]) => xs as never[];

function bundle(): Record<string, unknown> {
  return workspace("re-probe")
    .registerApiGroups(defs([api]))
    .registerTables(defs([users]))
    .registerQueries(defs([seed, mintSdkOrder, mintStoredOrder, precond, image]))
    .export() as unknown as Record<string, unknown>;
}

function findStatement(exported: unknown, queryName: string, statement: string): unknown {
  const queries =
    (exported as { payload?: { query?: Array<Record<string, unknown>> } }).payload?.query ?? [];
  const q = queries.find((x) => x.name === queryName);
  let hit: unknown;
  const walk = (node: unknown): void => {
    if (hit !== undefined || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const rec = node as Record<string, unknown>;
    if (rec.name === statement) {
      hit = rec;
      return;
    }
    Object.values(rec).forEach(walk);
  };
  walk(q);
  return hit;
}

async function main(): Promise<void> {
  const tenant = await createEphemeral(auth, {
    parentWorkspaceId: PARENT,
    display: "sidestep-re-probe",
    expiresHours: 1,
  });
  console.log(`ephemeral: ${tenant.name}`);
  try {
    const ready = await waitUntilReady(auth, { parentWorkspaceId: PARENT, name: tenant.name });
    const baseUrl = ready.url ?? tenant.url;
    if (!baseUrl) throw new Error("no base URL");

    await importWorkspaceArchive(auth, {
      baseUrl,
      archive: encodeWorkspaceArchive(JSON.stringify(bundle())),
    });
    console.log("imported\n");

    await fetch(`${baseUrl}/api:probe/seed`);

    // --- 2. does entry ORDER change whether a token mints? -------------------
    for (const name of ["mint_sdk_order", "mint_stored_order"]) {
      const res = await fetch(`${baseUrl}/api:probe/${name}`);
      const body = await res.text();
      const minted = res.status === 200 && body.split(".").length === 3;
      console.log(`create_auth ${name.padEnd(18)}: HTTP ${res.status} minted=${minted} ${body.slice(0, 60)}`);
    }

    const exported = await exportWorkspaceBundle(auth, {
      base: baseUrl,
      workspaceId: 1,
      label: "re-probe",
    });

    // What order does the engine hand back for each?
    for (const name of ["mint_sdk_order", "mint_stored_order"]) {
      const st = findStatement(exported, name, "mvp:create_auth") as
        | { input?: Array<{ name: string }> }
        | undefined;
      console.log(`  ${name} persisted order:`, (st?.input ?? []).map((e) => e.name).join(","));
    }

    // --- 3. what does the engine keep in `precondition.error`? ---------------
    const pre = findStatement(exported, "precond", "mvp:precondition") as
      | { context?: Record<string, unknown> }
      | undefined;
    console.log("\nprecondition context.error :", JSON.stringify(pre?.context?.error));
    console.log("precondition context keys  :", JSON.stringify(Object.keys(pre?.context ?? {})));

    // --- 1. does `create_image` keep its undeclared input[]? -----------------
    const img = findStatement(exported, "image", "mvp:create_image") as
      | { input?: unknown }
      | undefined;
    console.log("\ncreate_image persisted input:", JSON.stringify(img?.input));
  } finally {
    await deleteEphemeral(auth, { parentWorkspaceId: PARENT, name: tenant.name }).catch(() => {});
    console.log(`\ncleaned up ${tenant.name}`);
  }
}

await main();
