/**
 * Capture the `mvp:realtime_publish` goldens from a live engine.
 *
 * MANUALLY RUN — not part of `npm test`. The offline corpus is the deterministic
 * oracle; this is the thing that sources it.
 *
 *   npx tsx scripts/probe-realtime-publish.ts            # capture + report the diff
 *   npx tsx scripts/probe-realtime-publish.ts --write     # …and overwrite the goldens
 *
 * Reads `XANO_VALIDATE_INSTANCE` / `XANO_VALIDATE_TOKEN` from the environment (or
 * `.env`), and `PROBE_WORKSPACE_ID` for the workspace to push into (default 3).
 *
 * WHY NOT `sidestep validate --capture`: that path imports a compiled bundle into a
 * disposable sandbox tenant, and the sandbox reset needs table-ownership privileges a
 * shared dev instance may not grant (it fails with a `must be owner of table` error).
 * This probe instead pushes XanoScript through the workspace multidoc route in PARTIAL
 * mode — additive, no deletes, no table resets — and reads the result back out of the
 * workspace archive, which is the same read path `validate` uses.
 *
 * WHAT IT PINS. Two authorings, because the interesting behaviour is what the engine
 * does NOT store:
 *  - full  — every field set, so `auth.dbo_id` (a table GUID) and `realtime_server`
 *    (a plain NAME) are both exercised in one envelope.
 *  - min   — only the three required fields. The engine RENDERS this back with
 *    `auth_table = ""` filled in, but STORES no `auth` key at all. An encoder that
 *    believed the rendered script would write a key the engine never held.
 *
 * CLEAN UP AFTER YOURSELF: the probe deletes the two functions it created. It cannot
 * delete realtime objects — that CRUD lives behind a session-authenticated admin API,
 * not the instance token this script holds.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportWorkspaceBundle } from "../src/deploy/workspace-export.ts";
import { encodeStatement } from "../src/statements/statement.ts";
import { realtimePublish } from "../src/statements/special/misc.ts";
import { normalize } from "../src/validate/normalize.ts";
import { c } from "../src/values/value.ts";
import { obj } from "../src/values/obj.ts";

const FIXTURES = join(import.meta.dirname, "../test/fixtures/statements");
const WRITE = process.argv.includes("--write");

/**
 * Serialize with object keys SORTED, so the comparison is key-order-insensitive.
 * The engine writes context keys in its own order; a raw `JSON.stringify` reports
 * that as a difference and buries any real diff in the noise.
 */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val === null || typeof val !== "object" || Array.isArray(val)) return val;
    const record = val as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]]));
  });
}

/** Read a var from the environment, falling back to a `.env` at the repo root. */
function envVar(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const path = join(import.meta.dirname, "../.env");
  const text = (() => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  })();
  return text.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim() ?? "";
}

/**
 * The two probe authorings, as XanoScript.
 *
 * `data` is spelled the way `obj({ a: 1 })` renders it — the stored value is the
 * expression's SOURCE TEXT, so a difference in spacing is a difference in bytes.
 */
const PROBES = [
  {
    fixture: "realtime_publish",
    name: "ss_probe_publish",
    xs: `function ss_probe_publish {
  input {}
  stack {
    realtime.publish {
      realtime_server = "chat"
      channel = "lobby"
      message = "post"
      data = { a: 1 }
      auth_table = "user"
      auth_id = 7
    }
  }
}`,
  },
  {
    fixture: "realtime_publish-min",
    name: "ss_probe_publish_min",
    xs: `function ss_probe_publish_min {
  input {}
  stack {
    realtime.publish {
      realtime_server = "chat"
      channel = "lobby"
      data = { a: 1 }
    }
  }
}`,
  },
];

async function main(): Promise<void> {
  const base = envVar("XANO_VALIDATE_INSTANCE").replace(/\/$/, "");
  const token = envVar("XANO_VALIDATE_TOKEN");
  const workspaceId = Number(envVar("PROBE_WORKSPACE_ID") || 3);
  if (!base || !token) throw new Error("Set XANO_VALIDATE_INSTANCE and XANO_VALIDATE_TOKEN.");

  // PARTIAL push: creates/updates only what this doc names, deletes nothing.
  const query = new URLSearchParams({
    partial: "true",
    delete: "false",
    records: "false",
    transaction: "false",
    truncate: "false",
  });
  const push = await fetch(`${base}/api:meta/workspace/${workspaceId}/multidoc?${query}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/x-xanoscript",
      accept: "application/json",
    },
    body: PROBES.map((p) => p.xs).join("\n---\n"),
  });
  if (!push.ok) throw new Error(`push failed (${push.status}): ${await push.text()}`);
  console.log(`pushed ${PROBES.length} probe functions to workspace ${workspaceId}`);

  // The archive lags the write by a beat; without this the export returns the
  // pre-push state and the probe silently captures empty stacks.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const bundle = (await exportWorkspaceBundle({ access_token: token } as never, {
    base,
    workspaceId,
    label: "realtime.publish probe export",
  })) as { payload?: { function?: Array<{ name: string; run?: unknown[] }> } };
  const functions = bundle.payload?.function ?? [];

  for (const probe of PROBES) {
    const stored = functions.find((f) => f.name === probe.name)?.run?.[0];
    if (!stored) {
      console.error(`  ${probe.fixture}: NOT FOUND in the export (stack empty or push lagging)`);
      continue;
    }
    const path = join(FIXTURES, `${probe.fixture}.json`);
    if (WRITE) {
      writeFileSync(path, JSON.stringify(stored, null, 2) + "\n", "utf8");
      console.log(`  ${probe.fixture}: written`);
    } else {
      const committed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const same = stable(normalize(stored)) === stable(normalize(committed));
      console.log(`  ${probe.fixture}: ${same ? "matches the committed golden" : "DIFFERS — rerun with --write after reviewing"}`);
    }
  }

  // Sanity: the SDK encoder against what the engine just stored, before anything is
  // written. A red line here is an encoder bug, not a fixture chore.
  const encodedMin = encodeStatement(
    realtimePublish({ server: "chat", channel: c.text("lobby"), data: obj({ a: 1 }) }),
  );
  const storedMin = functions.find((f) => f.name === "ss_probe_publish_min")?.run?.[0];
  if (storedMin) {
    const same = stable(normalize(encodedMin)) === stable(normalize(storedMin));
    console.log(`  encoder vs engine (minimal): ${same ? "byte-equal" : "MISMATCH"}`);
  }

  // Clean up the functions. Realtime objects, if a probe ever creates any, cannot be
  // removed here — their CRUD is behind a session-authenticated admin API.
  const list = await fetch(`${base}/api:meta/workspace/${workspaceId}/function`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const items = ((await list.json()) as { items?: Array<{ id: number; name: string }> }).items ?? [];
  for (const item of items.filter((i) => PROBES.some((p) => p.name === i.name))) {
    await fetch(`${base}/api:meta/workspace/${workspaceId}/function/${item.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`  removed ${item.name}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
