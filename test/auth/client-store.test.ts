import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrRegisterClient } from "../../src/auth/client-store.js";

describe("client store (DCR cache)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidestep-clients-"));
    process.env.XANO_CLIENT_FILE = join(dir, "clients.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.XANO_CLIENT_FILE;
  });

  const args = {
    authHost: "https://app.xano.com",
    redirectUri: "http://127.0.0.1:47100/oauth/callback",
    registrationEndpoint: "https://app.xano.com/api:master/oauth/register",
    scope: "offline_access workspace:write",
  };

  it("registers once, caches the client_id, and reuses it on the next call", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ client_id: "dcr-1" }), { status: 200 }));

    const first = await getOrRegisterClient(args);
    expect(first).toBe("dcr-1");
    expect(existsSync(join(dir, "clients.json"))).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    // Second call for the same (authHost, redirectUri) hits the cache, no fetch.
    const second = await getOrRegisterClient(args);
    expect(second).toBe("dcr-1");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("registers a distinct client per redirect URI (different port)", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ client_id: "dcr-a" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ client_id: "dcr-b" }), { status: 200 }));

    const a = await getOrRegisterClient(args);
    const b = await getOrRegisterClient({ ...args, redirectUri: "http://127.0.0.1:8000/oauth/callback" });
    expect(a).toBe("dcr-a");
    expect(b).toBe("dcr-b");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
