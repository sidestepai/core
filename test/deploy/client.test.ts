import { describe, it, expect, afterEach, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { postDeploy } from "../../src/deploy/client.js";

const AUTH = { access_token: "acc-1", instance: "https://inst.example.com" };

function stubFetch(body: string, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(body, { status, statusText: status === 200 ? "OK" : "ERR" }),
  );
}

/** Recover the request body bytes from a fetch mock call. */
function postedBytes(fetchMock: ReturnType<typeof stubFetch>): Uint8Array {
  const init = fetchMock.mock.calls[0]![1] as RequestInit;
  return init.body as Uint8Array;
}

describe("postDeploy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs a gzipped bundle to the endpoint with a bearer token and no Content-Encoding", async () => {
    const fetchMock = stubFetch('{"base_url":"https://inst.example.com/x","workspace":{"id":7},"lock":{"version":1,"objects":{}}}');

    await postDeploy({ bundle: '{"app":"xano"}', endpointPath: "/api:meta/workspace/deploy", auth: AUTH });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://inst.example.com/api:meta/workspace/deploy");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer acc-1");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Content-Encoding"]).toBeUndefined();
    // Body is gzip (magic bytes) and round-trips to the bundle.
    const bytes = postedBytes(fetchMock);
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    expect(gunzipSync(bytes).toString("utf8")).toBe('{"app":"xano"}');
  });

  it("parses base_url, workspace (with numeric id), lock, and canonical_changes", async () => {
    stubFetch(
      '{"base_url":"https://inst.example.com/w","workspace":{"id":42,"name":"app"},"lock":{"version":1,"objects":{"dbo:u":{"guid":"g"}}},"canonical_changes":["app:api"]}',
    );
    const out = await postDeploy({ bundle: "{}", endpointPath: "/api:meta/workspace/deploy", auth: AUTH });
    expect(out.baseUrl).toBe("https://inst.example.com/w");
    expect(out.workspace).toEqual({ id: 42, name: "app" });
    expect(out.lock).toEqual({ version: 1, objects: { "dbo:u": { guid: "g" } } });
    expect(out.canonicalChanges).toEqual(["app:api"]);
  });

  it("falls back to `url` when the endpoint returns no `base_url`, and tolerates a missing lock", async () => {
    stubFetch('{"url":"https://inst.example.com/legacy","workspace":{"id":1}}');
    const out = await postDeploy({ bundle: "{}", endpointPath: "/api:meta/sandbox/bundle", auth: AUTH });
    expect(out.baseUrl).toBe("https://inst.example.com/legacy");
    expect(out.lock).toBeUndefined();
  });

  it("appends ?reset=true and ?prune=true", async () => {
    const resetMock = stubFetch("{}");
    await postDeploy({ bundle: "{}", endpointPath: "/api:meta/workspace/deploy", auth: AUTH, reset: true });
    expect(resetMock.mock.calls[0]![0]).toBe("https://inst.example.com/api:meta/workspace/deploy?reset=true");
    vi.restoreAllMocks();
    const pruneMock = stubFetch("{}");
    await postDeploy({ bundle: "{}", endpointPath: "/api:meta/workspace/deploy", auth: AUTH, prune: true });
    expect(pruneMock.mock.calls[0]![0]).toBe("https://inst.example.com/api:meta/workspace/deploy?prune=true");
  });

  it("throws an actionable error on a non-2xx response, including status and body", async () => {
    stubFetch("boom", 422);
    await expect(
      postDeploy({ bundle: "{}", endpointPath: "/api:meta/workspace/deploy", auth: AUTH }),
    ).rejects.toThrow(/Deploy to \/api:meta\/workspace\/deploy failed \(422.*boom/s);
  });

  it("surfaces the raw response body verbatim", async () => {
    stubFetch('{"base_url":"https://x","extra":true}');
    const out = await postDeploy({ bundle: "{}", endpointPath: "/api:meta/workspace/deploy", auth: AUTH });
    expect(out.raw).toBe('{"base_url":"https://x","extra":true}');
  });
});
