/**
 * Probe — issue #248: `s.return(c.obj({…}))` fails with `ERROR_FATAL "Unable to
 * decode."` while a scalar returns fine.
 *
 * The offline trace says the cause is the stored FORM, not the statement: a
 * statement's `{value, tag, filters}` is flattened into one piped string before
 * evaluation, and the reader that splits it back apart ends the value at the
 * first unquoted `}` outside brackets. A populated `const:obj` JSON string
 * therefore arrives truncated and fails to decode; `{}` plus one `set` filter
 * per key — what the editor writes — has every key inside a quoted filter
 * argument and survives.
 *
 * Both spellings go into ONE tenant so nothing but the value under test differs:
 *
 *   /api:ret/scalar   — the control that already worked
 *   /api:ret/legacy   — a populated JSON string, written verbatim (the bug)
 *   /api:ret/fixed    — what `c.obj({…})` writes now
 *   /api:ret/nested   — nesting, arrays and a dotted key through the same path
 *   /api:ret/keys     — every key shape the encoder bracket-escapes
 *   /api:ret/numkey   — the engine's numeric-key data model, pinned as-is
 *
 * Run: npx tsx scripts/probe-obj-return.ts     (reads .env like the other probes)
 */
import { readFileSync } from "node:fs";
import "../src/index.js";
import { workspace } from "../src/workspace/xano.js";
import { apiGroup } from "../src/kinds/api-group.js";
import { query } from "../src/kinds/query.js";
import { s } from "../src/statements/s.js";
import { c } from "../src/values/value.js";
import { rawValue } from "../src/values/raw-value.js";
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

const api = apiGroup({ name: "ret", canonical: "ret" });
const defs = (xs: unknown[]) => xs as never[];

const CASES: Array<{ name: string; expected: unknown }> = [
  { name: "scalar", expected: "done" },
  { name: "legacy", expected: null },
  { name: "fixed", expected: { a: 1 } },
  {
    name: "nested",
    expected: { s: "x", n: 1.5, b: true, z: null, "a.b": 2, list: [1, { k: 2 }], deep: { q: "v" } },
  },
  // Every key shape the encoder bracket-escapes, plus the members a JSON
  // encoder would drop or null — the object must come back FLAT, with the
  // dropped key absent and the non-finite number null.
  {
    name: "keys",
    expected: { "1a": "one", 'q"x': "quote", "a\\": "slash", "sp ace": "space", ok: null },
  },
  // NOT a defect of this encoding: a zero-based numeric key is an INDEX in the
  // engine's data model, so the object evaluates to a list. The same object
  // decoded from JSON anywhere in the platform behaves identically — pinned
  // here so the claim in `c.obj`'s docs stays honest. A non-zero-based numeric
  // key survives as a key.
  { name: "numkey", expected: ["a"] },
  { name: "numkey2", expected: { "2": "b" } },
];

const queries = [
  query({ name: "scalar", verb: "GET", apiGroup: api, stack: [s.return(c.text("done"))] }),
  // The pre-fix bytes, spelled verbatim — `c.obj` cannot write them any more.
  query({
    name: "legacy",
    verb: "GET",
    apiGroup: api,
    stack: [s.return(rawValue({ value: '{"a":1}', tag: "const:obj" }))],
  }),
  query({ name: "fixed", verb: "GET", apiGroup: api, stack: [s.return(c.obj({ a: 1 }))] }),
  query({
    name: "keys",
    verb: "GET",
    apiGroup: api,
    stack: [
      s.return(
        c.obj({
          "1a": "one",
          'q"x': "quote",
          "a\\": "slash",
          "sp ace": "space",
          ok: NaN,
          dropped: undefined,
        } as never),
      ),
    ],
  }),
  query({ name: "numkey", verb: "GET", apiGroup: api, stack: [s.return(c.obj({ "0": "a" }))] }),
  query({ name: "numkey2", verb: "GET", apiGroup: api, stack: [s.return(c.obj({ "2": "b" }))] }),
  query({
    name: "nested",
    verb: "GET",
    apiGroup: api,
    stack: [
      s.return(
        c.obj({
          s: "x",
          n: 1.5,
          b: true,
          z: null,
          "a.b": 2,
          list: [1, { k: 2 }],
          deep: { q: "v" },
        }),
      ),
    ],
  }),
];

async function main(): Promise<void> {
  const payload = workspace("obj-return-probe")
    .registerApiGroups(defs([api]))
    .registerQueries(defs(queries))
    .export() as unknown as Record<string, unknown>;

  const tenant = await createEphemeral(auth, {
    parentWorkspaceId: PARENT,
    display: "sidestep-obj-return-probe",
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

    for (const { name, expected } of CASES) {
      const res = await fetch(`${baseUrl}/api:ret/${name}`);
      const body: unknown = await res.json();
      const ok = res.status === 200 && JSON.stringify(body) === JSON.stringify(expected);
      console.log(`  ${name.padEnd(7)} ${res.status} ${JSON.stringify(body)}`);
      if (name !== "legacy" && !ok) console.log(`    !! expected ${JSON.stringify(expected)}`);
    }
  } finally {
    await deleteEphemeral(auth, { parentWorkspaceId: PARENT, name: tenant.name }).catch(() => {});
  }
}

await main();
