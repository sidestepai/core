/**
 * Microservice kind — byte-shape against ENGINE-CAPTURED goldens.
 *
 * Both fixtures were authored through the real meta API on a disposable tenant
 * and read back out of a workspace export, so they are the engine's own bytes
 * rather than a restatement of this encoder
 * (`scripts/probe-microservice-shapes.ts` reproduces them). That matters more
 * than usual here: this surface is young enough that a hand-written fixture
 * would mostly prove the encoder agrees with itself.
 *
 * Two of the blocks the engine declares — `config` and `volume` — could not be
 * captured because authoring either returns a fatal upstream. They are typed and
 * carried, and the round trip below covers them structurally, but nothing has
 * confirmed what a populated one persists as.
 */
import { describe, it, expect } from "vitest";
import "../../src/index.js";
import { microservice, encodeMicroservice, declaredServicePorts } from "../../src/kinds/microservice.js";
import { normalize, loadFixture } from "../conformance/harness.js";

describe("microservice — engine-captured byte shape", () => {
  it("matches the builtin golden, containers and all", () => {
    const built = encodeMicroservice({
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
    const golden = loadFixture("microservice/ex_kind_echo_service.json") as Record<string, unknown>;
    delete golden["guid"]; // the engine mints one; identity is not what this pins
    expect(normalize(built)).toEqual(normalize(golden));
  });

  it("matches the helm golden, chart values included", () => {
    const built = encodeMicroservice({
      name: "ex_kind_helm_service",
      kind: "helm",
      tenantDeploy: "manual",
      chart: {
        ref: "oci://registry-1.docker.io/bitnamicharts/nginx",
        version: "18.1.0",
        values: "PROBE_SENTINEL_VALUES: not-a-real-secret",
      },
    });
    const golden = loadFixture("microservice/ex_kind_helm_service.json") as Record<string, unknown>;
    delete golden["guid"];
    expect(normalize(built)).toEqual(normalize(golden));
  });
});

describe("microservice — the authoring surface", () => {
  it("stores an argv list as the `{name}` objects the engine expects", () => {
    // The authoring surface takes strings because that is what a command line
    // IS; the wrapper is the engine's serialization, confirmed by capture.
    const built = encodeMicroservice({
      name: "m",
      deployment: { containers: [{ name: "c", command: ["/bin/sh"], args: ["-c", "x"] }] },
    }) as unknown as { deployment: { containers: Array<Record<string, unknown>> } };
    expect(built.deployment.containers[0]!["command"]).toEqual([{ name: "/bin/sh" }]);
    expect(built.deployment.containers[0]!["args"]).toEqual([{ name: "-c" }, { name: "x" }]);
  });

  it("defaults containerPort to servicePort, as the engine's scaffold does", () => {
    const built = encodeMicroservice({
      name: "m",
      deployment: { containers: [{ name: "c", ports: [{ servicePort: "8080" }] }] },
    }) as unknown as { deployment: { containers: Array<{ ports: unknown[] }> } };
    expect(built.deployment.containers[0]!.ports).toEqual([
      { servicePort: "8080", containerPort: "8080" },
    ]);
  });

  it("fills the engine's deployment defaults", () => {
    const built = encodeMicroservice({ name: "m" }) as unknown as {
      deployment: Record<string, unknown>;
      kind: string;
      tenant_deploy: string;
    };
    expect(built.deployment["replicas"]).toBe(1);
    expect(built.deployment["strategy"]).toBe("Recreate");
    expect(built.kind).toBe("builtin");
    expect(built.tenant_deploy).toBe("auto");
  });

  it("refuses to mix the two shapes", () => {
    // The engine serializes builtin and helm as mutually exclusive groups, so a
    // def carrying both would write bytes whose meaning depends on which half
    // the engine reads. Caught at the authoring site, not at deploy.
    expect(() =>
      microservice({
        name: "m",
        kind: "helm",
        chart: { ref: "r" },
        deployment: { containers: [{ name: "c" }] },
      }),
    ).toThrow(/helm/);
    expect(() => microservice({ name: "m", chart: { ref: "r" } })).toThrow(/chart/);
  });

  it("requires a name, on the microservice and on every container", () => {
    expect(() => microservice({ name: "" })).toThrow(/name/);
    expect(() =>
      microservice({ name: "m", deployment: { containers: [{ name: "" }] } }),
    ).toThrow(/container/);
  });

  describe("declaredServicePorts", () => {
    // This is the list `s.microservice.request` validates a `port` against, and the
    // same flattening the dashboard does to build its host dropdown.
    it("flattens every container's ports in declaration order", () => {
      const def = microservice({
        name: "m",
        deployment: {
          containers: [
            { name: "a", ports: [{ servicePort: "8080" }, { servicePort: "8443" }] },
            { name: "b", ports: [{ servicePort: "9090" }] },
          ],
        },
      });
      expect(declaredServicePorts(def)).toEqual(["8080", "8443", "9090"]);
    });

    it("de-duplicates a port two containers both expose", () => {
      // Two containers on the same servicePort is one addressable port, not an
      // ambiguous choice — so the statement must not demand the caller pick.
      const def = microservice({
        name: "m",
        deployment: {
          containers: [
            { name: "a", ports: [{ servicePort: "8080" }] },
            { name: "b", ports: [{ servicePort: "8080" }] },
          ],
        },
      });
      expect(declaredServicePorts(def)).toEqual(["8080"]);
    });

    it("returns nothing for shapes that declare no ports", () => {
      expect(declaredServicePorts(microservice({ name: "m" }))).toEqual([]);
      expect(declaredServicePorts(microservice({ name: "m", deployment: {} }))).toEqual([]);
      expect(
        declaredServicePorts(microservice({ name: "m", deployment: { containers: [{ name: "c" }] } })),
      ).toEqual([]);
      expect(
        declaredServicePorts(microservice({ name: "m", kind: "helm", chart: { ref: "r" } })),
      ).toEqual([]);
    });
  });
});
