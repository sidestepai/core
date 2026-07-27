import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildStaticEnv, deriveDisplay, deployStaticTo, resolveParentWorkspaceId } from "../../src/emit/deploy-command.js";
import type { StaticTarget } from "../../src/emit/deploy-command.js";
import type { ResolvedAuth } from "../../src/auth/token.js";
import type { StaticHostResult } from "../../src/deploy/static-host.js";

const auth: ResolvedAuth = { instance: "https://inst.xano.io", access_token: "tok" } as ResolvedAuth;

const deployStaticHost = vi.hoisted(() => vi.fn());
const verifyRollout = vi.hoisted(() => vi.fn());
vi.mock("../../src/deploy/static-host.js", () => ({ deployStaticHost }));
vi.mock("../../src/deploy/verify-rollout.js", () => ({ verifyRollout }));

describe("resolveParentWorkspaceId", () => {
  it("prefers an explicit --workspace without touching the token", async () => {
    const resolve = vi.fn(async () => 9);
    expect(await resolveParentWorkspaceId(200, auth, resolve)).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("falls back to the token's scoped workspace when --workspace is omitted", async () => {
    const resolve = vi.fn(async () => 9);
    expect(await resolveParentWorkspaceId(undefined, auth, resolve)).toBe(9);
    expect(resolve).toHaveBeenCalledWith(auth);
  });

  it("never falls back to a hard-coded id 1", async () => {
    const resolve = vi.fn(async () => 42);
    expect(await resolveParentWorkspaceId(undefined, auth, resolve)).toBe(42);
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
