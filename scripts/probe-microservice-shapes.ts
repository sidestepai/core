/**
 * Probe — what does a microservice actually STORE?
 *
 * Deciding whether SideStep should model `payload.microservice` needs the shape
 * of four sections the frontend's own interface types as `any[]`/`any`
 * (`configs`, `volumes`, `ingresses`, `deployment`), and an answer on two
 * secret-bearing fields. A single captured sample had all four empty, which is
 * exactly the situation the fixture rules warn about: modelling from that would
 * be inventing an API.
 *
 * The engine DECLARES every one of these shapes in its own schema catalog, so
 * this probe is not discovery, it is CONFIRMATION: author each declared block
 * through the real meta API, export the workspace, and read the JSON the engine
 * persisted.
 *
 * Creating a microservice ROW does not deploy a container — the create writes
 * the row and deployment is a separate action — so this costs an ephemeral
 * tenant and no compute.
 *
 * The two questions that decide the design:
 *
 *   1. `chart.values` — the transform says it "round-trips in plaintext here
 *      (privileged push/pull) but stays masked on the API read-back path". If
 *      the workspace EXPORT carries it, a modelled microservice would write Helm
 *      values (documented as possibly holding secrets) into a committed tree.
 *   2. `registry_auth.dockerconfigjson` — a docker credential, never part of
 *      XanoScript, but on the row and not stripped on export. Same question,
 *      higher stakes.
 *
 * Run: npx tsx scripts/probe-microservice-shapes.ts   (reads .env like the other probes)
 */
import { readFileSync, writeFileSync } from "node:fs";
import "../src/index.js";
import { workspace } from "../src/workspace/xano.js";
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

/**
 * One microservice to author, as XanoScript.
 *
 * Between them these exercise every block the schemas declare, because a shape
 * only counts as confirmed if something actually stored it.
 */
const CASES: ReadonlyArray<{ label: string; script: string; extra?: Record<string, unknown> }> = [
  {
    label: "config block",
    script: `microservice probe_config {
  config probe_cfg {
    type = "env"
    value = "hello"
  }
  deployment {
    container c {
      image = "hashicorp/http-echo"
      ports = [{containerPort: "80", servicePort: "80"}]
      resources = {cpu: "50m", ram: "256Mi"}
    }
  }
}`,
  },
  {
    label: "volume block",
    script: `microservice probe_volume {
  volume probe_vol {
    size = "1Gi"
    class = "standard"
  }
  deployment {
    container c {
      image = "hashicorp/http-echo"
      ports = [{containerPort: "80", servicePort: "80"}]
      resources = {cpu: "50m", ram: "256Mi"}
    }
  }
}`,
  },
  {
    label: "ingress block",
    script: `microservice probe_ingress {
  deployment {
    container c {
      image = "hashicorp/http-echo"
      ports = [{containerPort: "80", servicePort: "80"}]
      resources = {cpu: "50m", ram: "256Mi"}
    }
  }
  ingress probe_ing {
    domain = "probe.example.com"
    path = [{service: "c", path: "/"}]
  }
}`,
  },
  {
    label: "container extras — command/arg/env/type, replicas/strategy",
    script: `microservice probe_container {
  deployment {
    replicas = 2
    strategy = "RollingUpdate"
    container probe_c {
      image = "ealen/echo-server:latest"
      type = "standard"
      command = [{name: "/bin/sh"}]
      arg = [{name: "-c"}, {name: "echo hi"}]
      env = [{name: "MODE", value: "probe"}]
      ports = [{containerPort: "80", servicePort: "8080"}]
      resources = {cpu: "50m", ram: "256Mi"}
    }
  }
}`,
  },
  {
    label: "minimal — which defaults the engine fills",
    script: `microservice probe_min {
  deployment {
    container probe_c {
      image = "hashicorp/http-echo"
      ports = [{containerPort: "5678", servicePort: "5678"}]
      resources = {cpu: "50m", ram: "256Mi"}
    }
  }
}`,
  },
  {
    label: "helm — chart with VALUES, the plaintext-round-trip question",
    extra: { kind: "helm" },
    script: `microservice probe_helm {
  kind = "helm"
  chart {
    ref = "oci://registry-1.docker.io/bitnamicharts/nginx"
    version = "18.1.0"
    values = "PROBE_SENTINEL_VALUES: not-a-real-secret"
  }
}`,
  },
  {
    // registry_auth is never part of XanoScript — it is patched onto the row out
    // of band, so it rides as a sibling input on the same create call.
    label: "builtin + registry_auth — the credential question",
    script: `microservice probe_auth {
  deployment {
    container probe_c {
      image = "private.example.com/app:1"
      ports = [{containerPort: "80", servicePort: "80"}]
      resources = {cpu: "50m", ram: "256Mi"}
    }
  }
}`,
    extra: {
      registry_auth: {
        server: "private.example.com",
        type: "userpass",
        dockerconfigjson: "PROBE_SENTINEL_DOCKERCONFIG",
      },
    },
  },
];

async function createMicroservice(
  base: string,
  workspaceId: number,
  cs: (typeof CASES)[number],
): Promise<void> {
  const res = await fetch(`${base}/api:meta/workspace/${workspaceId}/microservice`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, xanoscript: cs.script, ...cs.extra }),
  });
  const text = await res.text();
  console.log(`  ${res.ok ? "created" : `FAILED ${res.status}`}: ${cs.label}`);
  if (!res.ok) console.log(`      ${text.slice(0, 300)}`);
}

/** Does a sentinel we planted survive into the exported bundle? */
function findsSentinel(bundle: unknown, sentinel: string): boolean {
  return JSON.stringify(bundle).includes(sentinel);
}

async function main(): Promise<void> {
  const tenant = await createEphemeral(auth, {
    parentWorkspaceId: PARENT,
    display: "sidestep-microservice-shapes",
    expiresHours: 1,
  });
  console.log(`ephemeral: ${tenant.name}`);
  try {
    const ready = await waitUntilReady(auth, { parentWorkspaceId: PARENT, name: tenant.name });
    const baseUrl = ready.url ?? tenant.url;
    if (!baseUrl) throw new Error("ephemeral has no base URL");

    // A workspace has to exist before the meta API can hang a microservice off it.
    await importWorkspaceArchive(auth, {
      baseUrl,
      archive: encodeWorkspaceArchive(
        JSON.stringify(workspace("microservice-probe").export() as unknown as object),
      ),
    });

    console.log("\nauthoring:");
    for (const cs of CASES) await createMicroservice(baseUrl, 1, cs);

    const exported = (await exportWorkspaceBundle(auth, {
      base: baseUrl,
      workspaceId: 1,
      label: "microservice-probe",
    })) as { payload?: { microservice?: unknown[] } };

    writeFileSync("/tmp/microservice-probe.json", JSON.stringify(exported, null, 1));
    console.log("\nraw export written to /tmp/microservice-probe.json");
    const stored = exported.payload?.microservice ?? [];
    console.log(`\n=== ${stored.length} microservice object(s) as the engine PERSISTED them\n`);
    for (const m of stored) console.log(JSON.stringify(m, null, 1), "\n");

    console.log("=== the two questions that decide the design");
    for (const [what, sentinel] of [
      ["chart.values", "PROBE_SENTINEL_VALUES"],
      ["registry_auth.dockerconfigjson", "PROBE_SENTINEL_DOCKERCONFIG"],
    ] as const) {
      const present = findsSentinel(exported, sentinel);
      console.log(
        `  ${what.padEnd(32)} ${present ? "CARRIED IN THE EXPORT — a secret would land in the tree" : "absent from the export — safe to model"}`,
      );
    }
  } finally {
    await deleteEphemeral(auth, { parentWorkspaceId: PARENT, name: tenant.name }).catch(() => {});
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
