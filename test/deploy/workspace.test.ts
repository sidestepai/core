import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveScopedWorkspaceId } from "../../src/deploy/workspace.js";

const AUTH = { access_token: "acc-1", instance: "https://inst.example.com" };

/** An `auth/me` body whose membership maps the scoped guid to a numeric id. */
function meBody(opts: { scopedGuid?: string; workspaces: Array<{ guid?: string; id?: number }> }): string {
  return JSON.stringify({
    id: 9,
    extras: {
      oauth: opts.scopedGuid !== undefined ? { workspace: opts.scopedGuid } : {},
      instance: { id: 1, membership: { role: "admin", workspace: opts.workspaces } },
    },
  });
}

describe("resolveScopedWorkspaceId", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps the token's scoped workspace guid to its numeric id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(meBody({ scopedGuid: "guid-B", workspaces: [{ guid: "guid-A", id: 3 }, { guid: "guid-B", id: 9 }] }), { status: 200 }),
    );
    const id = await resolveScopedWorkspaceId(AUTH);
    expect(id).toBe(9);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://inst.example.com/api:meta/auth/me");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer acc-1");
  });

  it("falls back to the sole membership workspace when the token carries no scoped guid", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(meBody({ workspaces: [{ guid: "guid-A", id: 7 }] }), { status: 200 }));
    expect(await resolveScopedWorkspaceId(AUTH)).toBe(7);
  });

  it("errors (rather than guessing) when the scoped guid is absent and there are multiple workspaces", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(meBody({ workspaces: [{ guid: "guid-A", id: 3 }, { guid: "guid-B", id: 9 }] }), { status: 200 }),
    );
    await expect(resolveScopedWorkspaceId(AUTH)).rejects.toThrow(/Could not resolve which workspace/);
  });

  it("surfaces a non-2xx auth/me response as an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401, statusText: "Unauthorized" }));
    await expect(resolveScopedWorkspaceId(AUTH)).rejects.toThrow(/resolve workspace failed \(401/);
  });
});
