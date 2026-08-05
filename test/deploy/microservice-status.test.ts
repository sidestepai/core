import { describe, it, expect } from "vitest";
import {
  classify,
  isAwaited,
  listMicroservices,
  waitForMicroservices,
  type MicroserviceSummary,
} from "../../src/deploy/microservice-status.js";
import type { ResolvedAuth } from "../../src/auth/token.js";

const AUTH = {
  access_token: "tok",
  instance: "https://inst.xano.io",
  workspaceId: 1,
} as unknown as ResolvedAuth;

const TARGET = { baseUrl: "https://inst.xano.io/tenant/e36v-0gqx-3484", workspaceId: 1 };

/** One row as the meta list route serializes it. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    name: "probe_echo",
    kind: "builtin",
    tenant_deploy: "auto",
    status: "pending",
    status_detail: "",
    deployed_at: null,
    registry_auth: { server: "", type: "", expires_at: null },
    chart: { ref: "", version: "" },
    ...over,
  };
}

/** A fetch stub returning each body in order (last one repeats), recording URLs. */
function fetchReturning(...bodies: unknown[]): { fn: typeof fetch; calls: () => number; urls: string[] } {
  let i = 0;
  const urls: string[] = [];
  const fn = (async (url: string) => {
    urls.push(url);
    const b = bodies[Math.min(i, bodies.length - 1)];
    i++;
    if (b instanceof Error) throw b;
    if (typeof b === "number") return new Response("boom", { status: b, statusText: "Server Error" });
    if (typeof b === "string") return new Response(b, { status: 200 });
    return new Response(JSON.stringify(b), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls: () => i, urls };
}

/** A monotonic fake clock: `now()` advances by exactly each `sleep(ms)`. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

const paged = (items: Record<string, unknown>[], nextPage: number | null = null) => ({
  curPage: 1,
  nextPage,
  prevPage: null,
  items,
});

describe("classify", () => {
  it("reports a ready microservice", () => {
    expect(classify({ status: "ok" })).toBe("ready");
  });

  it("reports a broken one as failed", () => {
    expect(classify({ status: "error" })).toBe("failed");
  });

  it("treats both pre-serving states as in flight", () => {
    expect(classify({ status: "pending" })).toBe("inFlight");
    expect(classify({ status: "deploying" })).toBe("inFlight");
  });

  it("never awaits a manual row, whatever its status says", () => {
    expect(classify({ status: "pending", tenantDeploy: "manual" })).toBe("manual");
    expect(classify({ status: "deploying", tenantDeploy: "manual" })).toBe("manual");
    expect(classify({ status: "ok", tenantDeploy: "manual" })).toBe("manual");
  });

  it("checks disabled before tenant_deploy, so a disabled manual row reads disabled", () => {
    expect(classify({ status: "disabled", tenantDeploy: "manual" })).toBe("disabled");
  });

  it("defaults a missing tenant_deploy to auto rather than manual", () => {
    expect(classify({ status: "pending" })).toBe("inFlight");
  });

  it("resolves an unmodelled status to unknown, so it is never awaited", () => {
    expect(classify({ status: "quiesced" })).toBe("unknown");
    expect(isAwaited({ disposition: "unknown" } as MicroserviceSummary)).toBe(false);
  });

  it("awaits only in-flight rows", () => {
    const dispositions = ["ready", "inFlight", "failed", "manual", "disabled", "unknown"] as const;
    const awaited = dispositions.filter((d) => isAwaited({ disposition: d } as MicroserviceSummary));
    expect(awaited).toEqual(["inFlight"]);
  });
});

describe("listMicroservices", () => {
  it("projects a row to the safe summary", async () => {
    const { fn } = fetchReturning(paged([row({ status: "ok", status_detail: "3/3 ready", deployed_at: "2026-08-05 21:05:46+0000" })]));
    const [m] = await listMicroservices(AUTH, TARGET, { fetchFn: fn });
    expect(m).toEqual({
      id: 1,
      name: "probe_echo",
      kind: "builtin",
      tenantDeploy: "auto",
      status: "ok",
      statusDetail: "3/3 ready",
      deployedAt: "2026-08-05 21:05:46+0000",
      disposition: "ready",
    });
  });

  it("carries no secret-bearing field out of the raw row", async () => {
    const { fn } = fetchReturning(
      paged([row({ registry_auth: { dockerconfigjson: "SECRET" }, chart: { values: "SECRET" } })]),
    );
    const [m] = await listMicroservices(AUTH, TARGET, { fetchFn: fn });
    expect(JSON.stringify(m)).not.toContain("SECRET");
    expect(m).not.toHaveProperty("registry_auth");
    expect(m).not.toHaveProperty("chart");
  });

  it("reads the workspace-scoped meta route under the env's own base URL", async () => {
    const { fn, urls } = fetchReturning(paged([]));
    await listMicroservices(AUTH, TARGET, { fetchFn: fn });
    expect(urls[0]).toBe(
      "https://inst.xano.io/tenant/e36v-0gqx-3484/api:meta/workspace/1/microservice?page=1",
    );
  });

  it("preserves a base URL that carries a /tenant/{name} prefix", async () => {
    const { fn, urls } = fetchReturning(paged([]));
    await listMicroservices(AUTH, TARGET, { fetchFn: fn });
    expect(urls[0]).toContain("/tenant/e36v-0gqx-3484/api:meta/");
  });

  it("reads a real workspace at the instance origin with its own workspace id", async () => {
    const { fn, urls } = fetchReturning(paged([]));
    await listMicroservices(AUTH, { baseUrl: "https://inst.xano.io", workspaceId: 7 }, { fetchFn: fn });
    expect(urls[0]).toBe("https://inst.xano.io/api:meta/workspace/7/microservice?page=1");
  });

  it("returns an empty list for a workspace with no microservices", async () => {
    const { fn } = fetchReturning(paged([]));
    await expect(listMicroservices(AUTH, TARGET, { fetchFn: fn })).resolves.toEqual([]);
  });

  it("tolerates a bare array as well as the paged envelope", async () => {
    const { fn } = fetchReturning([row()]);
    const list = await listMicroservices(AUTH, TARGET, { fetchFn: fn });
    expect(list).toHaveLength(1);
  });

  it("follows pages to the end", async () => {
    const { fn, urls } = fetchReturning(
      paged([row({ id: 1, name: "a" })], 2),
      paged([row({ id: 2, name: "b" })], null),
    );
    const list = await listMicroservices(AUTH, TARGET, { fetchFn: fn });
    expect(list.map((m) => m.name)).toEqual(["a", "b"]);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("page=2");
  });

  it("stops rather than looping when nextPage does not advance", async () => {
    const { fn, calls } = fetchReturning(paged([row()], 1));
    await listMicroservices(AUTH, TARGET, { fetchFn: fn });
    expect(calls()).toBe(1);
  });

  it("throws with the status, statusText and body on a non-2xx", async () => {
    const { fn } = fetchReturning(500);
    await expect(listMicroservices(AUTH, TARGET, { fetchFn: fn })).rejects.toThrow(
      /list microservices failed \(500 Server Error\):\nboom/,
    );
  });

  it("throws a parse error naming the body on a non-JSON 200", async () => {
    const { fn } = fetchReturning("<html>nope</html>");
    await expect(listMicroservices(AUTH, TARGET, { fetchFn: fn })).rejects.toThrow(
      /could not parse the response as JSON:\n<html>nope<\/html>/,
    );
  });
});

describe("waitForMicroservices", () => {
  it("returns after a single read when there are no microservices", async () => {
    const clock = fakeClock();
    const { fn, calls } = fetchReturning(paged([]));
    const res = await waitForMicroservices(AUTH, TARGET, { fetchFn: fn, ...clock });
    expect(res).toEqual({ microservices: [], timedOut: false, hadFailure: false });
    expect(calls()).toBe(1);
  });

  it("does not poll when nothing is awaited — manual and disabled rows settle immediately", async () => {
    const clock = fakeClock();
    const { fn, calls } = fetchReturning(
      paged([row({ id: 1, tenant_deploy: "manual" }), row({ id: 2, status: "disabled" })]),
    );
    const res = await waitForMicroservices(AUTH, TARGET, { fetchFn: fn, ...clock });
    expect(calls()).toBe(1);
    expect(res.timedOut).toBe(false);
    expect(res.microservices.map((m) => m.disposition)).toEqual(["manual", "disabled"]);
  });

  it("polls until an in-flight microservice becomes ready", async () => {
    const clock = fakeClock();
    const { fn, calls } = fetchReturning(
      paged([row({ status: "pending" })]),
      paged([row({ status: "deploying" })]),
      paged([row({ status: "ok" })]),
    );
    const res = await waitForMicroservices(AUTH, TARGET, { fetchFn: fn, ...clock });
    expect(calls()).toBe(3);
    expect(res.timedOut).toBe(false);
    expect(res.microservices[0]?.disposition).toBe("ready");
  });

  it("settles on failure and reports it", async () => {
    const clock = fakeClock();
    const { fn } = fetchReturning(
      paged([row({ status: "deploying" })]),
      paged([row({ status: "error", status_detail: "ImagePullBackOff" })]),
    );
    const res = await waitForMicroservices(AUTH, TARGET, { fetchFn: fn, ...clock });
    expect(res.hadFailure).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(res.microservices[0]?.statusDetail).toBe("ImagePullBackOff");
  });

  it("times out rather than hanging when a status never advances", async () => {
    const clock = fakeClock();
    const { fn } = fetchReturning(paged([row({ status: "deploying" })]));
    const res = await waitForMicroservices(AUTH, TARGET, {
      fetchFn: fn,
      ...clock,
      totalDeadlineMs: 10_000,
      pollIntervalMs: 2_000,
    });
    expect(res.timedOut).toBe(true);
    expect(res.microservices[0]?.disposition).toBe("inFlight");
  });

  it("does not spin on an unmodelled status", async () => {
    const clock = fakeClock();
    const { fn, calls } = fetchReturning(paged([row({ status: "quiesced" })]));
    const res = await waitForMicroservices(AUTH, TARGET, { fetchFn: fn, ...clock });
    expect(calls()).toBe(1);
    expect(res.timedOut).toBe(false);
    expect(res.microservices[0]?.disposition).toBe("unknown");
  });

  it("survives a transient read failure mid-poll", async () => {
    const clock = fakeClock();
    const { fn } = fetchReturning(
      paged([row({ status: "deploying" })]),
      new Error("socket hang up"),
      paged([row({ status: "ok" })]),
    );
    const res = await waitForMicroservices(AUTH, TARGET, { fetchFn: fn, ...clock });
    expect(res.timedOut).toBe(false);
    expect(res.microservices[0]?.disposition).toBe("ready");
  });

  it("surfaces a first-read failure to the caller instead of polling blind", async () => {
    const clock = fakeClock();
    const { fn } = fetchReturning(500);
    await expect(waitForMicroservices(AUTH, TARGET, { fetchFn: fn, ...clock })).rejects.toThrow(
      /list microservices failed \(500 Server Error\)/,
    );
  });

  it("waits only on the in-flight row in a mixed set, and returns them all", async () => {
    const clock = fakeClock();
    const { fn, calls } = fetchReturning(
      paged([
        row({ id: 1, status: "ok" }),
        row({ id: 2, tenant_deploy: "manual" }),
        row({ id: 3, status: "deploying" }),
      ]),
      paged([
        row({ id: 1, status: "ok" }),
        row({ id: 2, tenant_deploy: "manual" }),
        row({ id: 3, status: "ok" }),
      ]),
    );
    const res = await waitForMicroservices(AUTH, TARGET, { fetchFn: fn, ...clock });
    expect(calls()).toBe(2);
    expect(res.microservices.map((m) => m.disposition)).toEqual(["ready", "manual", "ready"]);
  });

  it("reports progress on every read", async () => {
    const clock = fakeClock();
    const seen: string[][] = [];
    const { fn } = fetchReturning(paged([row({ status: "deploying" })]), paged([row({ status: "ok" })]));
    await waitForMicroservices(AUTH, TARGET, {
      fetchFn: fn,
      ...clock,
      onPoll: (ms) => seen.push(ms.map((m) => m.disposition)),
    });
    expect(seen).toEqual([["inFlight"], ["ready"]]);
  });
});
