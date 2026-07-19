import { describe, it, expect, afterEach, vi } from "vitest";
import { impersonateSandbox } from "../../src/deploy/impersonate.js";

const AUTH = { access_token: "acc-1", instance: "https://inst.example.com" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, statusText: status === 200 ? "OK" : "ERR" });
}

describe("impersonateSandbox", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exchanges the one-time ticket and returns the tenant-routing creds", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ _ti: "ott-1" }))
      .mockResolvedValueOnce(
        jsonResponse({ name: "sbx-1", _authToken: "imp-tok", baseUrl: "https://inst.example.com/", headers: { "X-Tenant": "sbx-1" } }),
      );

    const creds = await impersonateSandbox(AUTH);

    expect(fetchMock.mock.calls[0]![0]).toBe("https://inst.example.com/api:meta/sandbox/impersonate");
    const [exchangeUrl, exchangeInit] = fetchMock.mock.calls[1]!;
    expect(exchangeUrl).toBe("https://inst.example.com/api:meta/tenant/token/exchange");
    expect(JSON.parse((exchangeInit as RequestInit).body as string)).toEqual({ token: "ott-1" });

    expect(creds).toEqual({
      accessToken: "imp-tok",
      baseUrl: "https://inst.example.com/",
      headers: { "X-Tenant": "sbx-1" },
      name: "sbx-1",
    });
  });

  it("falls back to the caller's instance when the exchange omits baseUrl", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ _ti: "ott-1" }))
      .mockResolvedValueOnce(jsonResponse({ _authToken: "imp-tok", headers: { "X-Tenant": "sbx-1" } }));
    const creds = await impersonateSandbox(AUTH);
    expect(creds.baseUrl).toBe("https://inst.example.com");
  });

  it("refuses to continue when the exchange returns no tenant-routing headers", async () => {
    // Without X-Tenant every downstream call silently hits the caller's REAL
    // workspace, so this must fail loudly rather than deploy to the wrong place.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ _ti: "ott-1" }))
      .mockResolvedValueOnce(jsonResponse({ _authToken: "imp-tok", baseUrl: "https://inst.example.com/" }));
    await expect(impersonateSandbox(AUTH)).rejects.toThrow(/no tenant-routing headers/i);
  });

  it("errors when the impersonate leg returns no ticket", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({}));
    await expect(impersonateSandbox(AUTH)).rejects.toThrow(/no `_ti` one-time token/i);
  });

  it("errors when the exchange returns no auth token", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ _ti: "ott-1" }))
      .mockResolvedValueOnce(jsonResponse({ headers: { "X-Tenant": "sbx-1" } }));
    await expect(impersonateSandbox(AUTH)).rejects.toThrow(/no `_authToken`/i);
  });

  it("surfaces a non-2xx impersonate response with status and body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("nope", { status: 403, statusText: "ERR" }));
    await expect(impersonateSandbox(AUTH)).rejects.toThrow(/sandbox impersonate failed \(403.*nope/s);
  });
});
