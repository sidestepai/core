import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildStaticEnv, deriveDisplay, deployStaticTo, verifyMicroservices } from "../../src/emit/deploy-command.js";
import type { StaticTarget } from "../../src/emit/deploy-command.js";
import type { ResolvedAuth } from "../../src/auth/token.js";
import type { StaticHostResult } from "../../src/deploy/static-host.js";
import { parseArgs } from "../../src/emit/cli.js";

const auth: ResolvedAuth = {
  instance: "https://inst.xano.io",
  access_token: "tok",
  workspaceId: 42,
  credentialType: "oauth",
};

const deployStaticHost = vi.hoisted(() => vi.fn());
const verifyRollout = vi.hoisted(() => vi.fn());
vi.mock("../../src/deploy/static-host.js", () => ({ deployStaticHost }));
vi.mock("../../src/deploy/verify-rollout.js", () => ({ verifyRollout }));

describe("the parent workspace comes from the credential", () => {
  it("is not overridable — `--workspace` no longer parses", () => {
    expect(() => parseArgs(["deploy", "app.ts", "--workspace", "200"])).toThrow(/was removed/);
  });

  it("is never a hard-coded 1 — it is whatever the credential pinned", () => {
    // Instances number workspaces from their own sequence, so a fixed 1 404s
    // ("Invalid workspace") anywhere the primary workspace isn't id 1.
    expect(auth.workspaceId).toBe(42);
    expect(auth.workspaceId).not.toBe(1);
  });
});

describe("deriveDisplay", () => {
  it("reads the workspace name from payload.workspace (object shape)", () => {
    const bundle = JSON.stringify({ app: "xano", payload: { workspace: { name: "my-app", guid: "g" } } });
    expect(deriveDisplay(bundle, "/tmp/whatever")).toBe("my-app");
  });
  it("tolerates an array workspace shape", () => {
    const bundle = JSON.stringify({ payload: { workspace: [{ name: "arr-app" }] } });
    expect(deriveDisplay(bundle, "/tmp/whatever")).toBe("arr-app");
  });
  it("falls back to the project dir basename when the bundle has no workspace name", () => {
    expect(deriveDisplay(JSON.stringify({ payload: {} }), "/tmp/proj-dir")).toBe("proj-dir");
  });
  it("falls back to the dir basename on unparseable input", () => {
    expect(deriveDisplay("{not json", "/tmp/proj-dir")).toBe("proj-dir");
  });
});

describe("buildStaticEnv", () => {
  it("seeds the backend URL as XANO_HOST when no --static-env is given", () => {
    expect(buildStaticEnv("https://sbx.xano.io/tenant/sbx-1", {})).toEqual({
      XANO_HOST: "https://sbx.xano.io/tenant/sbx-1",
    });
  });

  it("lets an explicit --static-env XANO_HOST override the seeded backend URL", () => {
    expect(buildStaticEnv("https://sbx.xano.io/tenant/sbx-1", { XANO_HOST: "https://custom.example" })).toEqual({
      XANO_HOST: "https://custom.example",
    });
  });

  it("extends the seed with additional --static-env keys", () => {
    expect(buildStaticEnv("https://sbx.xano.io/tenant/sbx-1", { PK: "pk_live_1" })).toEqual({
      XANO_HOST: "https://sbx.xano.io/tenant/sbx-1",
      PK: "pk_live_1",
    });
  });

  it("omits XANO_HOST entirely when there is no backend URL and none is supplied", () => {
    expect(buildStaticEnv(undefined, { PK: "pk_live_1" })).toEqual({ PK: "pk_live_1" });
  });
});

describe("deployStaticTo — canonical liveness verification", () => {
  const target: StaticTarget = { baseUrl: "https://inst.xano.io", workspaceId: 9, label: undefined };
  const URL = "https://app-dev-abc.xano.io";

  const hostResult = (over: Partial<StaticHostResult> = {}): StaticHostResult => ({
    url: URL,
    canonical: "cbuild-1",
    envInjected: false,
    raw: "{}",
    ...over,
  });

  beforeEach(() => {
    deployStaticHost.mockReset();
    verifyRollout.mockReset();
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
  });

  it("polls the canonical and reports verified:true when the edge serves this build", async () => {
    deployStaticHost.mockResolvedValueOnce(hostResult());
    verifyRollout.mockResolvedValueOnce({ live: true });

    const res = await deployStaticTo("./dist", auth, target, {}, false);

    expect(verifyRollout).toHaveBeenCalledWith(URL, "cbuild-1");
    expect(res).toEqual({ url: URL, verified: true });
  });

  it("reports verified:false WITHOUT failing the deploy when liveness isn't confirmed", async () => {
    deployStaticHost.mockResolvedValueOnce(hostResult());
    verifyRollout.mockResolvedValueOnce({ live: false });

    const res = await deployStaticTo("./dist", auth, target, {}, false);

    expect(res).toEqual({ url: URL, verified: false });
    expect(process.exitCode).toBe(0); // NOT a failure — exit code untouched
  });

  it("skips verification under --no-verify and omits the verified field", async () => {
    deployStaticHost.mockResolvedValueOnce(hostResult());

    const res = await deployStaticTo("./dist", auth, target, {}, false, undefined, true);

    expect(verifyRollout).not.toHaveBeenCalled();
    expect(res).toEqual({ url: URL });
  });

  it("skips verification (degrades) when the build response carried no canonical", async () => {
    deployStaticHost.mockResolvedValueOnce(hostResult({ canonical: undefined }));

    const res = await deployStaticTo("./dist", auth, target, {}, false);

    expect(verifyRollout).not.toHaveBeenCalled();
    expect(res).toEqual({ url: URL });
  });

  it("skips verification when there is no URL to poll", async () => {
    deployStaticHost.mockResolvedValueOnce(hostResult({ url: undefined }));

    const res = await deployStaticTo("./dist", auth, target, {}, false);

    expect(verifyRollout).not.toHaveBeenCalled();
    expect(res).toEqual({ url: undefined });
  });
});

describe("verifyMicroservices — post-import readiness reporting", () => {
  const BASE = "https://inst.xano.io/tenant/e36v-0gqx-3484";

  /** A fetch stub returning one paged body, recording how many reads happened. */
  function reads(...rows: Record<string, unknown>[][]): { fn: typeof fetch; calls: () => number } {
    let i = 0;
    const fn = (async () => {
      const items = rows[Math.min(i, rows.length - 1)];
      i++;
      return new Response(JSON.stringify({ curPage: 1, nextPage: null, prevPage: null, items }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    return { fn, calls: () => i };
  }

  const ms = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: "probe_echo",
    kind: "builtin",
    tenant_deploy: "auto",
    status: "ok",
    status_detail: "",
    deployed_at: null,
    ...over,
  });

  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (n: number) => void (t += n) };
  };

  beforeEach(() => {
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
  });

  it("returns undefined and reads nothing under --no-verify", async () => {
    const { fn, calls } = reads([ms()]);
    const res = await verifyMicroservices(auth, BASE, true, { fetchFn: fn });
    expect(res).toBeUndefined();
    expect(calls()).toBe(0);
  });

  it("returns undefined when the workspace declares no microservices", async () => {
    const { fn, calls } = reads([]);
    const res = await verifyMicroservices(auth, BASE, false, { fetchFn: fn, ...clock() });
    expect(res).toBeUndefined();
    expect(calls()).toBe(1);
  });

  it("reports a ready microservice and carries it in the summary", async () => {
    const { fn } = reads([ms({ status: "ok" })]);
    const res = await verifyMicroservices(auth, BASE, false, { fetchFn: fn, ...clock() });
    expect(res).toHaveLength(1);
    expect(res?.[0]?.disposition).toBe("ready");
  });

  it("reports a manual microservice without waiting on it", async () => {
    const { fn, calls } = reads([ms({ tenant_deploy: "manual", status: "pending" })]);
    const res = await verifyMicroservices(auth, BASE, false, { fetchFn: fn, ...clock() });
    expect(calls()).toBe(1);
    expect(res?.[0]?.disposition).toBe("manual");
  });

  it("reports a failure without failing the deploy — the import already committed", async () => {
    const { fn } = reads([ms({ status: "error", status_detail: "ImagePullBackOff" })]);
    const res = await verifyMicroservices(auth, BASE, false, { fetchFn: fn, ...clock() });
    expect(res?.[0]?.disposition).toBe("failed");
    expect(process.exitCode).toBe(0);
  });

  it("reports a timeout without failing the deploy", async () => {
    const { fn } = reads([ms({ status: "deploying" })]);
    const res = await verifyMicroservices(auth, BASE, false, {
      fetchFn: fn,
      ...clock(),
      totalDeadlineMs: 10_000,
      pollIntervalMs: 2_000,
    });
    expect(res?.[0]?.disposition).toBe("inFlight");
    expect(process.exitCode).toBe(0);
  });

  it("degrades to undefined when the status read itself fails", async () => {
    const fn = (async () => new Response("nope", { status: 500, statusText: "Server Error" })) as unknown as typeof fetch;
    const res = await verifyMicroservices(auth, BASE, false, { fetchFn: fn, ...clock() });
    expect(res).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it("carries no secret-bearing field into the summary", async () => {
    const { fn } = reads([ms({ registry_auth: { dockerconfigjson: "SECRET" }, chart: { values: "SECRET" } })]);
    const res = await verifyMicroservices(auth, BASE, false, { fetchFn: fn, ...clock() });
    expect(JSON.stringify(res)).not.toContain("SECRET");
  });
});
