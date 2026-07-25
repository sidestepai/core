import { describe, it, expect, vi } from "vitest";
import { buildStaticEnv, deriveDisplay, resolveParentWorkspaceId } from "../../src/emit/deploy-command.js";
import type { ResolvedAuth } from "../../src/auth/token.js";

const auth: ResolvedAuth = { instance: "https://inst.xano.io", access_token: "tok" } as ResolvedAuth;

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
