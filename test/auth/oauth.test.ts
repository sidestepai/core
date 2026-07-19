import { describe, it, expect, afterEach, vi } from "vitest";
import { discover, registerClient, decodeAudience, oauthErrorCode } from "../../src/auth/oauth.js";

/**
 * Only the pure/HTTP-only helpers are unit-tested here. PKCE, the authorize
 * URL, the code exchange, refresh, and revocation are delegated to
 * `openid-client` (see `OpenIdProvider`) and exercised at the flow level, the
 * same way the sidestep dashboard tests its provider — not by stubbing fetch.
 */

/** Build a minimal unsigned JWT carrying the given claims payload. */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "at+jwt" })}.${b64(payload)}.sig`;
}

function stubFetch(...responses: Response[]) {
  const spy = vi.spyOn(globalThis, "fetch");
  for (const r of responses) spy.mockResolvedValueOnce(r);
  return spy;
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, statusText: "OK", ...init });
}

describe("oauth helpers", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("discover", () => {
    it("returns the endpoints (incl. registration) from the well-known document", async () => {
      stubFetch(
        json({
          authorization_endpoint: "https://app.xano.com/oauth2/authorize",
          token_endpoint: "https://app.xano.com/api:master/oauth/token",
          registration_endpoint: "https://app.xano.com/api:master/oauth/register",
        }),
      );
      const eps = await discover("https://app.xano.com");
      expect(eps.token_endpoint).toBe("https://app.xano.com/api:master/oauth/token");
      expect(eps.registration_endpoint).toBe("https://app.xano.com/api:master/oauth/register");
    });

    it("throws a clear error on a 404", async () => {
      stubFetch(new Response("nope", { status: 404, statusText: "Not Found" }));
      await expect(discover("https://bad.example.com")).rejects.toThrow(/discovery failed \(404/);
    });

    it("throws when the doc is missing endpoints", async () => {
      stubFetch(json({ authorization_endpoint: "x" }));
      await expect(discover("https://app.xano.com")).rejects.toThrow(/missing authorization\/token/);
    });
  });

  describe("registerClient (DCR)", () => {
    it("registers with the exact redirect_uri and a scopes ARRAY, accepting 200", async () => {
      const spy = stubFetch(json({ client_id: "dcr-abc" })); // Xano answers 200, not 201
      const { client_id } = await registerClient({
        registrationEndpoint: "https://app.xano.com/api:master/oauth/register",
        redirectUri: "http://127.0.0.1:47100/oauth/callback",
        scope: "offline_access workspace:write",
      });
      expect(client_id).toBe("dcr-abc");
      const body = JSON.parse(spy.mock.calls[0]![1]!.body as string);
      expect(body.redirect_uris).toEqual(["http://127.0.0.1:47100/oauth/callback"]);
      expect(body.token_endpoint_auth_method).toBe("none");
      expect(body.scopes).toEqual(["offline_access", "workspace:write"]); // array, not string
      expect(body.scope).toBeUndefined();
    });

    it("throws on a non-2xx registration", async () => {
      stubFetch(new Response("nope", { status: 429, statusText: "Too Many Requests" }));
      await expect(
        registerClient({ registrationEndpoint: "https://x/reg", redirectUri: "http://127.0.0.1:1/cb", scope: "s" }),
      ).rejects.toThrow(/registration failed \(429/);
    });
  });

  describe("decodeAudience", () => {
    it("reads the aud claim from an at+jwt", () => {
      expect(decodeAudience(fakeJwt({ aud: "https://x8ki.xano.io" }))).toBe("https://x8ki.xano.io");
    });

    it("returns the first entry when aud is an array", () => {
      expect(decodeAudience(fakeJwt({ aud: ["https://a.xano.io", "https://b"] }))).toBe("https://a.xano.io");
    });

    it("returns undefined for a non-JWT or missing aud", () => {
      expect(decodeAudience("not-a-jwt")).toBeUndefined();
      expect(decodeAudience(fakeJwt({ sub: "u1" }))).toBeUndefined();
    });
  });

  describe("oauthErrorCode", () => {
    it("reads the OAuth `error` code off an error-like object", () => {
      expect(oauthErrorCode({ error: "invalid_grant" })).toBe("invalid_grant");
      expect(oauthErrorCode(Object.assign(new Error("x"), { error: "invalid_client" }))).toBe("invalid_client");
    });

    it("returns undefined when there is no string `error`", () => {
      expect(oauthErrorCode(new Error("boom"))).toBeUndefined();
      expect(oauthErrorCode({ error: 42 })).toBeUndefined();
      expect(oauthErrorCode(null)).toBeUndefined();
    });
  });
});
