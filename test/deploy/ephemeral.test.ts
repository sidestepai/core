import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createEphemeral,
  getEphemeral,
  listEphemeral,
  listAllEphemeral,
  deleteEphemeral,
  impersonateEphemeral,
  waitUntilReady,
  isExpired,
  tenantBaseUrl,
} from "../../src/deploy/ephemeral.js";

const AUTH = { access_token: "acc-1", instance: "https://inst.example.com" };

function stub(body: unknown, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(text, { status, statusText: status === 200 ? "OK" : "ERR" }));
}
function stubSeq(...responses: Array<{ body: unknown; status?: number }>) {
  const m = vi.spyOn(globalThis, "fetch");
  for (const r of responses) {
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    m.mockResolvedValueOnce(new Response(text, { status: r.status ?? 200, statusText: "OK" }));
  }
  return m;
}

const TENANT = { id: 42, name: "e4f2-9ab1", display: "PR 1", xano_domain: "e4f2-9ab1.xano.io", state: "ok", ephemeral_expires_at: "2999-01-01 00:00:00+0000" };

afterEach(() => vi.restoreAllMocks());

describe("createEphemeral", () => {
  it("POSTs display/tag/expires to the workspace ephemeral route and projects a secret-free summary", async () => {
    const m = stub({ ...TENANT, k8s: { secret: "x" }, license: "tier1" });
    const out = await createEphemeral(AUTH, { parentWorkspaceId: 114, display: "PR 1", expiresHours: 24 });
    const [url, init] = m.mock.calls[0]!;
    expect(url).toBe("https://inst.example.com/api:meta/workspace/114/ephemeral");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers as Record<string, string>).toMatchObject({ Authorization: "Bearer acc-1" });
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ display: "PR 1", tag: [], expires_hours: 24 });
    expect(out).toEqual({
      id: 42,
      name: "e4f2-9ab1",
      display: "PR 1",
      url: "https://e4f2-9ab1.xano.io",
      state: "ok",
      expiresAt: "2999-01-01 00:00:00+0000",
      workspaceId: undefined,
    });
    // secrets never leak into the projection
    expect(JSON.stringify(out)).not.toMatch(/k8s|license|secret/);
  });
});

describe("getEphemeral", () => {
  it("returns the projected summary on 200", async () => {
    stub(TENANT);
    const out = await getEphemeral(AUTH, { parentWorkspaceId: 114, name: "e4f2-9ab1" });
    expect(out?.url).toBe("https://e4f2-9ab1.xano.io");
  });
  it("returns null on 404 (swept)", async () => {
    stub("not found", 404);
    expect(await getEphemeral(AUTH, { parentWorkspaceId: 114, name: "gone" })).toBeNull();
  });
  it("throws the conventional error on 500", async () => {
    stub("boom", 500);
    await expect(getEphemeral(AUTH, { parentWorkspaceId: 114, name: "x" })).rejects.toThrow(/get ephemeral failed \(500/);
  });
});

describe("listEphemeral", () => {
  it("handles a bare array and a { items } envelope", async () => {
    stub([TENANT]);
    expect((await listEphemeral(AUTH, { parentWorkspaceId: 114 })).length).toBe(1);
    vi.restoreAllMocks();
    stub({ items: [TENANT, TENANT] });
    expect((await listEphemeral(AUTH, { parentWorkspaceId: 114 })).length).toBe(2);
  });
  it("returns [] for an empty list", async () => {
    stub([]);
    expect(await listEphemeral(AUTH, { parentWorkspaceId: 114 })).toEqual([]);
  });
  it("listAllEphemeral hits the global route", async () => {
    const m = stub([TENANT]);
    await listAllEphemeral(AUTH);
    expect(m.mock.calls[0]![0]).toBe("https://inst.example.com/api:meta/ephemeral");
  });
});

describe("deleteEphemeral", () => {
  it("issues DELETE and reports not-gone on 2xx", async () => {
    const m = stub({}, 200);
    const out = await deleteEphemeral(AUTH, { parentWorkspaceId: 114, name: "e4f2-9ab1" });
    expect((m.mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
    expect(out.alreadyGone).toBe(false);
  });
  it("treats a 404 as already gone (idempotent)", async () => {
    stub("nope", 404);
    expect(await deleteEphemeral(AUTH, { parentWorkspaceId: 114, name: "gone" })).toEqual({ alreadyGone: true });
  });
  it("throws on a non-404 error", async () => {
    stub("boom", 500);
    await expect(deleteEphemeral(AUTH, { parentWorkspaceId: 114, name: "x" })).rejects.toThrow(/delete ephemeral failed \(500/);
  });
});

describe("impersonateEphemeral", () => {
  it("returns the one-time token, no query string by default", async () => {
    const m = stub({ _ti: "tok-123" });
    const out = await impersonateEphemeral(AUTH, { parentWorkspaceId: 114, name: "e4f2-9ab1" });
    expect(out).toEqual({ _ti: "tok-123" });
    expect(String(m.mock.calls[0]![0])).toBe("https://inst.example.com/api:meta/workspace/114/tenant/e4f2-9ab1/impersonate");
  });
  it("requests a read-only guest session", async () => {
    const m = stub({ _ti: "tok-123" });
    await impersonateEphemeral(AUTH, { parentWorkspaceId: 114, name: "e4f2-9ab1", guest: true });
    expect(String(m.mock.calls[0]![0])).toContain("guest_read_only=true");
  });
  it("percent-encodes the tenant name in the path", async () => {
    const m = stub({ _ti: "tok-123" });
    await impersonateEphemeral(AUTH, { parentWorkspaceId: 114, name: "a b/c" });
    expect(String(m.mock.calls[0]![0])).toContain("/tenant/a%20b%2Fc/impersonate");
  });
  it("throws when no token is returned", async () => {
    stub({});
    await expect(impersonateEphemeral(AUTH, { parentWorkspaceId: 114, name: "e4f2-9ab1" })).rejects.toThrow(/no one-time token/);
  });
  it("throws on a non-2xx error", async () => {
    stub("boom", 500);
    await expect(impersonateEphemeral(AUTH, { parentWorkspaceId: 114, name: "x" })).rejects.toThrow(/impersonate ephemeral failed \(500/);
  });
});

describe("waitUntilReady", () => {
  it("returns once state flips to ok", async () => {
    stubSeq({ body: { ...TENANT, state: "provisioning" } }, { body: { ...TENANT, state: "ok" } });
    const out = await waitUntilReady(AUTH, { parentWorkspaceId: 114, name: "e4f2-9ab1" }, { intervalMs: 0, sleep: async () => {} });
    expect(out.state).toBe("ok");
  });
  it("times out with a clear error if never ready", async () => {
    stub({ ...TENANT, state: "provisioning" });
    await expect(
      waitUntilReady(AUTH, { parentWorkspaceId: 114, name: "e4f2-9ab1" }, { timeoutMs: -1, sleep: async () => {} }),
    ).rejects.toThrow(/did not become ready/);
  });
});

describe("helpers", () => {
  it("isExpired reflects past vs future expiry", () => {
    expect(isExpired("2000-01-01 00:00:00+0000")).toBe(true);
    expect(isExpired("2999-01-01 00:00:00+0000")).toBe(false);
    expect(isExpired(undefined)).toBe(false);
  });
  it("tenantBaseUrl prefers xano_domain, https (http for localhost)", () => {
    expect(tenantBaseUrl({ xano_domain: "abc.xano.io" }, "https://i")).toBe("https://abc.xano.io");
    expect(tenantBaseUrl({ xano_domain: "localhost:8080" }, "https://i")).toBe("http://localhost:8080");
    expect(tenantBaseUrl({ name: "t" }, "https://inst.example.com")).toBe("https://inst.example.com/tenant/t");
  });
});
