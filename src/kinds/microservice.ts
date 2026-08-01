/**
 * Microservice (`microservice`) — a container workload deployed alongside the
 * workspace, addressed from a stack by `s.api.microservice`.
 *
 * Two mutually exclusive shapes, selected by {@link MicroserviceDef.kind}:
 *
 *  - **`builtin`** — declarative: `configs`, `volumes`, a `deployment` of one or
 *    more containers, and `ingresses`. This is the default.
 *  - **`helm`** — bring-your-own chart: a `chart` reference and its values. A
 *    helm microservice carries no deployment blocks, and a builtin one carries
 *    no chart; the engine serializes them as mutually exclusive groups.
 *
 * **EARLY, AND EXPECTED TO CHANGE.** This models a young platform surface: two
 * of the blocks the engine declares (`config` and `volume`) currently fail to
 * author at all — a create carrying either returns a fatal — so their shapes are
 * modelled from the engine's schema rather than from stored bytes, which is
 * weaker evidence than the rest of this SDK holds itself to. They are typed and
 * carried, and they round-trip, but nothing has confirmed what the engine writes
 * for a populated one.
 *
 * ### Two fields carry secrets, and codegen carries them
 *
 * `registryAuth.dockerconfigjson` is a docker registry credential, and
 * `chart.values` is Helm values documented upstream as possibly holding
 * secrets. A live capture confirmed both ride the workspace export, so
 * `sidestep codegen` writes both into the generated tree VERBATIM.
 *
 * That is deliberate: dropping them would mean a pulled microservice could not
 * be redeployed, which is worse than the alternative for the thing this surface
 * exists to do. But it means **a generated tree holding a private-registry
 * microservice contains a live credential** — treat that tree as secret
 * material, or supply the credential from the environment and leave
 * `registryAuth.dockerconfigjson` unset. The decoder reports every non-empty one
 * it carries, so it can never happen quietly.
 */
import { registerKind, type ObjectKind } from "./kind.js";

/** A container port mapping. Both sides are TEXT, as the engine stores them. */
export interface ContainerPort {
  /** The port the service exposes. */
  servicePort: string;
  /** The port inside the container. Defaults to `servicePort` when omitted. */
  containerPort?: string;
}

/** A container's CPU/RAM request, in Kubernetes units (`"50m"`, `"256Mi"`). */
export interface ContainerResources {
  cpu?: string;
  ram?: string;
}

/** One `name=value` pair in a container's environment. */
export interface ContainerEnv {
  name: string;
  value?: string;
}

/** A volume mounted into a container. */
export interface ContainerVolume {
  name: string;
  type?: string;
  persistent?: Record<string, unknown>;
  emptyDir?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

/** One container in a {@link MicroserviceDeployment}. */
export interface MicroserviceContainer {
  name: string;
  image?: string;
  /** Names a `registryAuth` pull secret when the image is private. */
  pullSecret?: string;
  type?: string;
  /** Entrypoint, one element per argv token. */
  command?: string[];
  /** Arguments to the entrypoint, one element per argv token. */
  args?: string[];
  env?: ContainerEnv[];
  ports?: ContainerPort[];
  resources?: ContainerResources;
  volumes?: ContainerVolume[];
}

/** The `builtin` workload: how many replicas of which containers. */
export interface MicroserviceDeployment {
  /** Defaults to 1. */
  replicas?: number;
  /** Defaults to `"Recreate"`. */
  strategy?: string;
  docker?: string;
  containers?: MicroserviceContainer[];
}

/** One route into the microservice. */
export interface MicroserviceIngress {
  name: string;
  domain?: string;
  /** Path → container-service mappings. */
  paths?: Array<{ service?: string; path?: string }>;
}

/** A named config value attached to the microservice. */
export interface MicroserviceConfig {
  name: string;
  type?: string;
  value?: string;
}

/** A persistent volume claim owned by the microservice. */
export interface MicroserviceVolume {
  name: string;
  size?: string;
  class?: string;
}

/** A bring-your-own Helm chart (`kind: "helm"`). */
export interface MicroserviceChart {
  /** e.g. `oci://registry/repo/chart`, a `.tgz` URL, or `repo/chart`. */
  ref?: string;
  version?: string;
  /** Chart values, as YAML. Carried into a generated tree VERBATIM. */
  values?: string;
}

/** Private-registry pull credentials. See the note on {@link MicroserviceDef}. */
export interface MicroserviceRegistryAuth {
  /** Registry host, e.g. `index.docker.io`. */
  server?: string;
  /** The credential flow that assembled the pull secret. */
  type?: "userpass" | "gcp_sa" | "aws_ecr" | "";
  /**
   * The assembled docker credential. Carried into a generated tree VERBATIM and
   * reported when it is — see the note on {@link MicroserviceDef}.
   */
  dockerconfigjson?: string;
}

export interface MicroserviceDef {
  name: string;
  /**
   * Pin identity explicitly. Omitted, the guid is derived from the name — set it
   * to adopt an object that already exists in a workspace, or to survive a
   * rename. `sidestep codegen` always emits the engine's own guid, because
   * re-deriving one would be a silent identity rewrite.
   */
  guid?: string;
  description?: string;
  /**
   * `builtin` (declarative containers) or `helm` (bring-your-own chart).
   * Defaults to `builtin`.
   */
  kind?: "builtin" | "helm";
  /**
   * Whether tenant releases deploy this automatically. `manual` still ships with
   * the release but is not auto-deployed there. Defaults to `auto`.
   */
  tenantDeploy?: "auto" | "manual";
  /** `builtin` only. */
  deployment?: MicroserviceDeployment;
  /** `builtin` only. */
  ingresses?: MicroserviceIngress[];
  /** `builtin` only. See the early-surface note on {@link MicroserviceDef}. */
  configs?: MicroserviceConfig[];
  /** `builtin` only. See the early-surface note on {@link MicroserviceDef}. */
  volumes?: MicroserviceVolume[];
  /** `helm` only. */
  chart?: MicroserviceChart;
  registryAuth?: MicroserviceRegistryAuth;
}

/** The persisted envelope, exactly as the engine stores it. */
export interface MicroserviceXdo {
  name: string;
  description: string;
  kind: string;
  tenant_deploy: string;
  configs: unknown[];
  volumes: unknown[];
  ingresses: unknown[];
  deployment: Record<string, unknown>;
  chart: Record<string, unknown>;
  registry_auth: Record<string, unknown>;
}

/**
 * An argv list as the engine stores it: a list of `{name}` objects, not strings.
 *
 * The authoring surface takes strings because that is what a command line IS;
 * the `{name}` wrapper is a serialization detail of the engine's schema
 * (`!static:objects { name }`) and confirmed by a live capture.
 */
function argvEntries(argv: readonly string[] | undefined): Array<{ name: string }> {
  return (argv ?? []).map((name) => ({ name }));
}

function encodeContainer(c: MicroserviceContainer): Record<string, unknown> {
  if (!c.name) throw new Error("microservice: every container needs a `name`.");
  return {
    name: c.name,
    type: c.type ?? "standard",
    image: c.image ?? "",
    // `containerPort` defaults to `servicePort`, which is what the engine's own
    // scaffold does when a port omits it.
    ports: (c.ports ?? []).map((p) => ({
      servicePort: p.servicePort,
      containerPort: p.containerPort ?? p.servicePort,
    })),
    resources: { cpu: c.resources?.cpu ?? "", ram: c.resources?.ram ?? "" },
    command: argvEntries(c.command),
    args: argvEntries(c.args),
    envs: (c.env ?? []).map((e) => ({ name: e.name, value: e.value ?? "" })),
    volumes: (c.volumes ?? []).map((v) => ({ ...v })),
    ...(c.pullSecret !== undefined ? { pull_secret: c.pullSecret } : {}),
  };
}

export function encodeMicroservice(def: MicroserviceDef): MicroserviceXdo {
  if (!def.name) throw new Error("microservice: `name` is required.");
  const kind = def.kind ?? "builtin";

  // The two shapes are mutually exclusive in the engine's serialization: a helm
  // row stores empty deployment blocks and a builtin row an empty chart. Reject
  // the contradiction here rather than writing bytes whose meaning depends on
  // which half the engine happens to read.
  if (kind === "helm" && (def.deployment || def.ingresses?.length || def.configs?.length || def.volumes?.length)) {
    throw new Error(
      "microservice: `kind: \"helm\"` takes a `chart` and no deployment blocks — " +
        "`deployment`/`ingresses`/`configs`/`volumes` belong to `kind: \"builtin\"`.",
    );
  }
  if (kind !== "helm" && def.chart) {
    throw new Error(
      "microservice: `chart` belongs to `kind: \"helm\"`. A builtin microservice declares containers instead.",
    );
  }

  const deployment = def.deployment ?? {};
  return {
    name: def.name,
    description: def.description ?? "",
    kind,
    tenant_deploy: def.tenantDeploy ?? "auto",
    configs: (def.configs ?? []).map((c) => ({
      name: c.name,
      type: c.type ?? "",
      value: c.value ?? "",
    })),
    volumes: (def.volumes ?? []).map((v) => ({
      name: v.name,
      size: v.size ?? "",
      class: v.class ?? "",
    })),
    ingresses: (def.ingresses ?? []).map((i) => ({
      name: i.name,
      domain: i.domain ?? "",
      paths: (i.paths ?? []).map((p) => ({ service: p.service ?? "", path: p.path ?? "" })),
    })),
    deployment: {
      docker: deployment.docker ?? "",
      replicas: deployment.replicas ?? 1,
      strategy: deployment.strategy ?? "Recreate",
      containers: (deployment.containers ?? []).map(encodeContainer),
    },
    chart: {
      ref: def.chart?.ref ?? "",
      values: def.chart?.values ?? "",
      version: def.chart?.version ?? "",
    },
    registry_auth: {
      type: def.registryAuth?.type ?? "",
      server: def.registryAuth?.server ?? "",
      dockerconfigjson: def.registryAuth?.dockerconfigjson ?? "",
    },
  };
}

/** Author a microservice. See the module docstring for the two shapes. */
export function microservice(def: MicroserviceDef): MicroserviceDef {
  encodeMicroservice(def); // validate eagerly, at the authoring site
  return def;
}

export const microserviceKind: ObjectKind<MicroserviceDef, MicroserviceXdo> = {
  name: "microservice",
  payloadKey: "microservice",
  encode: encodeMicroservice,
};
registerKind(microserviceKind);
