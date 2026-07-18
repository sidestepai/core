import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  generatePkce,
  randomState,
  discover,
  buildAuthorizeUrl,
  exchangeCode,
  refresh,
  registerClient,
  decodeAudience,
} from "../../src/auth/oauth.js";

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

describe("oauth core", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("generatePkce", () => {
    it("produces a challenge equal to base64url(sha256(verifier))", () => {
      const { verifier, challenge } = generatePkce();
      const expected = createHash("sha256").update(verifier).digest().toString("base64url");
      expect(challenge).toBe(expected);
    });

    it("uses a verifier within RFC 7636 length bounds and varies per call", () => {
      const a = generatePkce();
      const b = generatePkce();
      expect(a.verifier.length).toBeGreaterThanOrEqual(43);
      expect(a.verifier.length).toBeLessThanOrEqual(128);
      expect(a.verifier).not.toBe(b.verifier);
    });

    it("randomState varies per call", () => {
      expect(randomState()).not.toBe(randomState());
    });
  });

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

  describe("buildAuthorizeUrl", () => {
    it("includes all required params and the passed client_id", () => {
      const href = buildAuthorizeUrl({
        authorizationEndpoint: "https://app.xano.com/oauth2/authorize",
        clientId: "dcr-client-123",
        redirectUri: "http://127.0.0.1:47100/oauth/callback",
        instance: "https://x8ki.xano.io",
        scope: "offline_access workspace:write",
        state: "st",
        codeChallenge: "chal",
      });
      const u = new URL(href);
      expect(u.searchParams.get("client_id")).toBe("dcr-client-123");
      expect(u.searchParams.get("response_type")).toBe("code");
      expect(u.searchParams.get("code_challenge_method")).toBe("S256");
      expect(u.searchParams.get("code_challenge")).toBe("chal");
      expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:47100/oauth/callback");
      expect(u.searchParams.get("resource")).toBe("https://x8ki.xano.io");
      expect(u.searchParams.get("scope")).toBe("offline_access workspace:write");
      expect(u.searchParams.get("state")).toBe("st");
    });

    it("omits `resource` when no instance is pre-selected", () => {
      const href = buildAuthorizeUrl({
        authorizationEndpoint: "https://app.xano.com/oauth2/authorize",
        clientId: "c",
        redirectUri: "http://127.0.0.1:47100/oauth/callback",
        scope: "offline_access",
        state: "st",
        codeChallenge: "chal",
      });
      expect(new URL(href).searchParams.has("resource")).toBe(false);
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

  describe("exchangeCode", () => {
    it("posts the authorization_code grant and stamps expires_at", async () => {
      const now = Date.now();
      const spy = stubFetch(json({ access_token: "acc", refresh_token: "ref", expires_in: 600, scope: "openid" }));
      const set = await exchangeCode({
        tokenEndpoint: "https://app.xano.com/api:master/oauth/token",
        clientId: "dcr-abc",
        code: "the-code",
        codeVerifier: "the-verifier",
        redirectUri: "http://127.0.0.1:47100/oauth/callback",
        instance: "https://x8ki.xano.io",
      });
      expect(set.access_token).toBe("acc");
      expect(set.refresh_token).toBe("ref");
      expect(set.expires_at).toBeGreaterThanOrEqual(now + 600 * 1000);

      const body = new URLSearchParams(spy.mock.calls[0]![1]!.body as string);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_id")).toBe("dcr-abc");
      expect(body.get("code")).toBe("the-code");
      expect(body.get("code_verifier")).toBe("the-verifier");
      expect(body.get("resource")).toBe("https://x8ki.xano.io");
    });

    it("throws including the server error body on invalid_grant", async () => {
      stubFetch(json({ error: "invalid_grant", error_description: "bad code" }, { status: 400, statusText: "Bad Request" }));
      await expect(
        exchangeCode({
          tokenEndpoint: "https://app.xano.com/api:master/oauth/token",
          clientId: "c",
          code: "x",
          codeVerifier: "y",
          redirectUri: "http://127.0.0.1:47100/oauth/callback",
          instance: "https://x8ki.xano.io",
        }),
      ).rejects.toThrow(/invalid_grant: bad code/);
    });
  });

  describe("refresh", () => {
    it("posts the refresh_token grant with the client_id and surfaces the rotated token", async () => {
      const spy = stubFetch(json({ access_token: "acc2", refresh_token: "rotated", expires_in: 600 }));
      const set = await refresh({
        tokenEndpoint: "https://app.xano.com/api:master/oauth/token",
        clientId: "dcr-abc",
        refreshToken: "old-refresh",
        instance: "https://x8ki.xano.io",
      });
      expect(set.access_token).toBe("acc2");
      expect(set.refresh_token).toBe("rotated");

      const body = new URLSearchParams(spy.mock.calls[0]![1]!.body as string);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("client_id")).toBe("dcr-abc");
      expect(body.get("refresh_token")).toBe("old-refresh");
      expect(body.get("resource")).toBe("https://x8ki.xano.io");
    });
  });
});
