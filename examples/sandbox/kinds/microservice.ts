/**
 * `microservice` — a container workload deployed alongside the workspace.
 *
 * The thing a stack reaches with `s.api.microservice`. Two mutually exclusive
 * shapes, chosen by `kind`:
 *
 *  - **`builtin`** (the default) — you declare the containers: image, ports,
 *    resources, env, and optional ingresses.
 *  - **`helm`** — you point at a chart and hand it values. A helm microservice
 *    declares no containers, and a builtin one declares no chart; passing both
 *    throws rather than writing bytes whose meaning depends on which half the
 *    engine reads.
 *
 * EARLY SURFACE. This models a young part of the platform and is expected to
 * change. Two blocks the engine declares — `configs` and `volumes` — are typed
 * here but could not be captured from a live instance, so treat their shapes as
 * provisional.
 *
 * SECRETS RIDE ALONG. `chart.values` and `registryAuth.dockerconfigjson` are
 * carried into a generated tree verbatim by `sidestep codegen` — they have to
 * be, or a pulled microservice could not be redeployed. A tree holding a
 * private-registry microservice therefore holds a live credential; the pull
 * reports every one it carries. Prefer leaving `dockerconfigjson` unset and
 * supplying it out of band.
 */
import { microservice } from "@sidestep/core";

/**
 * Gate 1 — a builtin container workload.
 *
 * `command`/`args` take plain strings (that is what a command line is); the
 * engine's `{name}` wrapper is applied on the way out. `containerPort` defaults
 * to `servicePort`, so a same-port mapping needs only the one value.
 *
 * `tenantDeploy` decides whether importing this row also STARTS the workload.
 * It defaults to `"auto"`, which is what you want in production. Both examples
 * here use `"manual"` instead: the row is carried by the import and started by
 * hand, so deploying this sandbox does not spin up real containers and wait on
 * them. Deploy readiness reports a manual row as `manual` rather than waiting.
 */
export const echoService = microservice({
  name: "ex_kind_echo_service",
  tenantDeploy: "manual",
  deployment: {
    replicas: 2,
    strategy: "RollingUpdate",
    containers: [
      {
        name: "probe_c",
        image: "ealen/echo-server:latest",
        ports: [{ servicePort: "8080", containerPort: "80" }],
        resources: { cpu: "50m", ram: "256Mi" },
        command: ["/bin/sh"],
        args: ["-c", "echo hi"],
        env: [{ name: "MODE", value: "probe" }],
      },
    ],
  },
});

/**
 * Gate 2 — a bring-your-own Helm chart.
 *
 * `kind: "helm"` swaps the whole shape: no containers, no ingresses, just the
 * chart reference and its values. Keep secrets out of `values` — it lands in a
 * pulled tree verbatim.
 */
export const helmService = microservice({
  name: "ex_kind_helm_service",
  kind: "helm",
  tenantDeploy: "manual",
  chart: {
    ref: "oci://registry-1.docker.io/bitnamicharts/nginx",
    version: "18.1.0",
    values: "PROBE_SENTINEL_VALUES: not-a-real-secret",
  },
});
