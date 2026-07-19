import { describe, it, expect, afterEach, vi } from "vitest";
import { postDeploy } from "../../src/deploy/client.js";

const AUTH = { access_token: "acc-1", instance: "https://inst.example.com" };

function stubFetch(body: string, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(body, { status, statusText: status === 200 ? "OK" : "ERR" }),
  );
}

describe("postDeploy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs the raw bundle to the endpoint with a bearer token and no Content-Encoding", async () => {
    const fetchMock = stubFetch('{"base_url":"https://inst.example.com/x","workspace":{"id":7},"lock":{"version":1,"objects":{}}}');

    await postDeploy({ bundle: '{"app":"xano"}', endpointPath: "/api:meta/workspace/deploy", auth: AUTH });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://inst.example.com/api:meta/workspace/deploy");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer acc-1");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Content-Encoding"]).toBeUndefined();
    // Body is the raw bundle JSON, uncompressed.
    expect((init as RequestInit).body).toBe('{"app":"xano"}');
  });

  it("parses base_url and workspace (with the numeric id the static path needs)", async () => {
    stubFetch('{"base_url":"https://inst.example.com/w","workspace":{"id":42,"name":"app"}}');
    const out = await postDeploy({ bundle: "{}", endpointPath: "/api:meta/sandbox/bundle", auth: AUTH });
    expect(out.baseUrl).toBe("https://inst.example.com/w");
    expect(out.workspace).toEqual({ id: 42, name: "app" });
  });

  it("falls back to `url` when the endpoint returns no `base_url`, and tolerates a missing workspace", async () => {
    stubFetch('{"url":"https://inst.example.com/legacy"}');
    const out = await postDeploy({ bundle: "{}", endpointPath: "/api:meta/sandbox/bundle", auth: AUTH });
    expect(out.baseUrl).toBe("https://inst.example.com/legacy");
    expect(out.workspace).toBeUndefined();
  });

  it("appends the caller's query params to the endpoint URL", async () => {
    const sandboxMock = stubFetch("{}");
    await postDeploy({ bundle: "{}", endpointPath: "/api:meta/sandbox/bundle", auth: AUTH, query: { reset: "true" } });
    expect(sandboxMock.mock.calls[0]![0]).toBe("https://inst.example.com/api:meta/sandbox/bundle?reset=true");
  });

  it("throws an actionable error on a non-2xx response, including status and body", async () => {
    stubFetch("boom", 422);
    await expect(
      postDeploy({ bundle: "{}", endpointPath: "/api:meta/sandbox/bundle", auth: AUTH }),
    ).rejects.toThrow(/Deploy to \/api:meta\/sandbox\/bundle failed \(422.*boom/s);
  });

  it("surfaces the raw response body verbatim", async () => {
    stubFetch('{"base_url":"https://x","extra":true}');
    const out = await postDeploy({ bundle: "{}", endpointPath: "/api:meta/workspace/deploy", auth: AUTH });
    expect(out.raw).toBe('{"base_url":"https://x","extra":true}');
  });
});
