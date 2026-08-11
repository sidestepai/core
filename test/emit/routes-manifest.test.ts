/**
 * The generated route manifest (`sidestep routes --emit`, issue #223).
 *
 * The manifest exists so a frontend can keep the "derive paths, never hardcode"
 * contract without paying ~37 kB of core runtime for one `getPath()`. That only
 * holds if the generated interpolator agrees with `getPath()` exactly — a
 * manifest that formats a path differently, or accepts an input `getPath()`
 * rejects, silently addresses the wrong route. So the load-bearing test here is
 * equivalence against the real def, not a snapshot of the emitted text.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";
import { apiGroup } from "../../src/kinds/api-group.js";
import { query } from "../../src/kinds/query.js";
import { realtimeServer } from "../../src/kinds/realtime-server.js";
import { realtimeChannel } from "../../src/kinds/realtime-channel.js";
import { input } from "../../src/inputs/input.js";
import { c } from "../../src/values/value.js";
import {
  renderRouteManifest,
  RouteManifestError,
  type RealtimeManifest,
} from "../../src/emit/routes-manifest.js";

const app = apiGroup({ name: "app", canonical: "app" });
const blog = apiGroup({ name: "blog", canonical: "blog" });

const login = query({
  name: "auth/login",
  verb: "POST",
  apiGroup: app,
  stack: [],
  response: { ok: c.bool(true) },
});
const getPost = query({
  name: "blog/{slug}",
  verb: "GET",
  apiGroup: blog,
  input: { slug: input.text({ required: true }) },
  stack: [],
  response: { ok: c.bool(true) },
});
const review = query({
  name: "blog/{slug}/review/{review_id}",
  verb: "GET",
  apiGroup: blog,
  input: { slug: input.text({ required: true }), review_id: input.int({ required: true }) },
  stack: [],
  response: { ok: c.bool(true) },
});

const ROUTES = [
  { name: login.name, verb: login.verb, canonical: "app" },
  { name: getPost.name, verb: getPost.verb, canonical: "blog" },
  { name: review.name, verb: review.verb, canonical: "blog" },
] as const;

const chat = realtimeServer({ name: "chat", canonical: "chat-abc", enabled: true });
const lobby = realtimeChannel({ name: "lobby", server: chat });
const room = realtimeChannel({
  name: "rooms/{room_id}",
  server: chat,
  input: { room_id: input.int({ required: true }) },
});
const thread = realtimeChannel({
  name: "rooms/{room_id}/threads/{thread_id}",
  server: chat,
  input: {
    room_id: input.int({ required: true }),
    thread_id: input.text({ required: true }),
  },
});

const REALTIME: RealtimeManifest = {
  servers: [{ name: chat.name, canonical: "chat-abc" }],
  channels: [
    { name: lobby.name, server: chat.name },
    { name: room.name, server: chat.name },
    { name: thread.name, server: chat.name },
  ],
};

/** Compile the generated TypeScript and import it, so the tests run the real emitted code. */
async function loadManifest(source: string): Promise<{
  ROUTES: Record<string, { verb: string; path: string }>;
  routePath: (name: string, params?: Record<string, string | number>) => string;
  REALTIME_SERVERS: Record<string, { canonical: string }>;
  CHANNELS: Record<string, { server: string }>;
  channelPath: (name: string, params?: Record<string, string | number>) => string;
  socketPath: (server: string, opts?: { tenant?: string }) => string;
  socketUrl: (server: string, baseUrl: string, opts?: { tenant?: string }) => string;
}> {
  const { code } = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
  const dir = mkdtempSync(join(tmpdir(), "sidestep-routes-"));
  const file = join(dir, "routes.gen.mjs");
  writeFileSync(file, code);
  try {
    return (await import(pathToFileURL(file).href)) as never;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("renderRouteManifest", () => {
  it("emits no import of any kind — the whole point of the file", () => {
    for (const source of [renderRouteManifest(ROUTES), renderRouteManifest(ROUTES, REALTIME)]) {
      expect(source).not.toMatch(/^\s*import\s/m);
      expect(source).not.toContain("@sidestep/core");
      expect(source).not.toMatch(/\brequire\(/);
    }
  });

  it("interpolates channels through the routes' helper, not a second copy", () => {
    const source = renderRouteManifest(ROUTES, REALTIME);
    expect(source.match(/function fillParams\(/g)).toHaveLength(1);
  });

  it("is deterministic — a re-run produces byte-identical output", () => {
    const a = renderRouteManifest(ROUTES);
    // Same routes, different input order: the emitter sorts, so a committed
    // manifest doesn't churn when registration order changes.
    const b = renderRouteManifest([ROUTES[2], ROUTES[0], ROUTES[1]]);
    expect(b).toBe(a);

    const withRealtime = renderRouteManifest(ROUTES, REALTIME);
    expect(
      renderRouteManifest(ROUTES, {
        servers: REALTIME.servers,
        channels: [REALTIME.channels[2]!, REALTIME.channels[0]!, REALTIME.channels[1]!],
      }),
    ).toBe(withRealtime);
  });

  // The emitted file lands in a frontend's own tsconfig, so it has to compile
  // under strict on its own. Worth the runtime: the tests above run the emitted
  // code through esbuild, which STRIPS types rather than checking them, and an
  // empty ROUTES/CHANNELS (a realtime-only workspace) makes the key type `never`
  // — which compiles everywhere except where it is indexed.
  it("type-checks under tsc --strict, at every shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "sidestep-routes-tsc-"));
    const shapes: Record<string, string> = {
      "both.ts": renderRouteManifest(ROUTES, REALTIME),
      "routes-only.ts": renderRouteManifest(ROUTES),
      "realtime-only.ts": renderRouteManifest([], REALTIME),
      "no-channels.ts": renderRouteManifest(ROUTES, { servers: REALTIME.servers, channels: [] }),
    };
    try {
      for (const [file, source] of Object.entries(shapes)) {
        writeFileSync(join(dir, file), source);
      }
      const result = spawnSync(
        "npx",
        [
          "tsc",
          "--noEmit",
          "--strict",
          "--target",
          "es2022",
          "--lib",
          "es2022",
          "--module",
          "esnext",
          "--moduleResolution",
          "bundler",
          ...Object.keys(shapes).map((f) => join(dir, f)),
        ],
        { encoding: "utf8" },
      );
      expect(result.stdout + result.stderr).toBe("");
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("omits the realtime section for a workspace that has none", () => {
    const bare = renderRouteManifest(ROUTES);
    // A query-only manifest is byte-identical to what it was before #233 — no
    // churn in a committed file just because the emitter learned about sockets.
    expect(bare).not.toContain("REALTIME_SERVERS");
    expect(bare).toBe(renderRouteManifest(ROUTES, { servers: [], channels: [] }));
  });

  it("refuses two endpoints with the same name — the manifest keys on it", () => {
    expect(() =>
      renderRouteManifest([
        { name: "dup", verb: "GET", canonical: "app" },
        { name: "dup", verb: "POST", canonical: "blog" },
      ]),
    ).toThrow(RouteManifestError);
  });

  it("carries the verb for every route", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES));
    expect(m.ROUTES["auth/login"]!.verb).toBe("POST");
    expect(m.ROUTES["blog/{slug}"]!.verb).toBe("GET");
  });
});

describe("routePath ≡ getPath", () => {
  it("produces the identical path for a static route", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES));
    expect(m.routePath("auth/login")).toBe(login.getPath());
  });

  it("produces the identical path for one and for several params", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES));
    expect(m.routePath("blog/{slug}", { slug: "hello" })).toBe(
      getPost.getPath({ params: { slug: "hello" } }),
    );
    expect(m.routePath("blog/{slug}/review/{review_id}", { slug: "hello", review_id: 7 })).toBe(
      review.getPath({ params: { slug: "hello", review_id: 7 } }),
    );
  });

  it("agrees on values that need no escaping but look risky", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES));
    for (const slug of ["a-b_c", "post-1.json", "ünïcode", "10", "a b"]) {
      expect(m.routePath("blog/{slug}", { slug }), slug).toBe(
        getPost.getPath({ params: { slug } }),
      );
    }
  });

  it("rejects the same inputs getPath rejects", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES));
    const cases: { params: Record<string, string | number>; why: string }[] = [
      { params: { slug: "" }, why: "empty" },
      { params: { slug: "a/b" }, why: "contains a slash" },
      { params: { slug: Number.NaN }, why: "non-finite" },
      { params: { nope: "x" }, why: "unknown key" },
    ];
    for (const { params, why } of cases) {
      expect(() => m.routePath("blog/{slug}", params), why).toThrow();
      expect(
        // @ts-expect-error — deliberately the same bad input the manifest gets
        () => getPost.getPath({ params }),
        why,
      ).toThrow();
    }
  });

  it("rejects a missing params argument on a parameterized route", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES));
    expect(() => m.routePath("blog/{slug}")).toThrow(/path param/);
  });

  it("rejects an unknown route name at runtime as well as at compile time", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES));
    expect(() => m.routePath("not/a/route")).toThrow(/unknown route/);
  });
});

describe("channelPath ≡ getChannel", () => {
  it("produces the identical path for a static and for a parameterized channel", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES, REALTIME));
    expect(m.channelPath("lobby")).toBe(lobby.getChannel());
    expect(m.channelPath("rooms/{room_id}", { room_id: 42 })).toBe(room.getChannel({ room_id: 42 }));
    expect(
      m.channelPath("rooms/{room_id}/threads/{thread_id}", { room_id: 42, thread_id: "t-1" }),
    ).toBe(thread.getChannel({ room_id: 42, thread_id: "t-1" }));
  });

  it("agrees on values that need no escaping but look risky", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES, REALTIME));
    for (const room_id of ["a-b_c", "ünïcode", "10", "a b"]) {
      expect(m.channelPath("rooms/{room_id}", { room_id }), room_id).toBe(
        room.getChannel({ room_id }),
      );
    }
  });

  it("rejects the same inputs getChannel rejects", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES, REALTIME));
    const cases: { params: Record<string, string | number>; why: string }[] = [
      { params: { room_id: "" }, why: "empty" },
      { params: { room_id: "a/b" }, why: "contains a slash — a different channel" },
      { params: { room_id: Number.NaN }, why: "non-finite" },
      { params: { nope: "x" }, why: "unknown key" },
    ];
    for (const { params, why } of cases) {
      expect(() => m.channelPath("rooms/{room_id}", params), why).toThrow();
      expect(
        // @ts-expect-error — deliberately the same bad input the manifest gets
        () => room.getChannel(params),
        why,
      ).toThrow();
    }
    expect(() => m.channelPath("rooms/{room_id}")).toThrow(/path param/);
    expect(() => m.channelPath("not/a/channel")).toThrow(/unknown channel/);
  });

  it("names each channel's owning server", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES, REALTIME));
    expect(m.CHANNELS["rooms/{room_id}"]!.server).toBe("chat");
    expect(m.REALTIME_SERVERS["chat"]!.canonical).toBe(chat.getCanonical());
  });
});

describe("socketUrl ≡ getUrl", () => {
  // The addresses a realtime frontend would otherwise hand-build. The tenant
  // forms are the load-bearing ones: the socket glues the tenant to the
  // canonical inside one segment (`/ws/<tenant>:<canonical>`), which is not
  // derivable from the `/tenant/<name>/api:<canonical>` form of the HTTP half.
  const BASES: { base: string; opts?: { tenant?: string }; why: string }[] = [
    { base: "https://x.dev.xano.io", why: "https → wss" },
    { base: "http://x.dev.xano.io", why: "http → ws" },
    { base: "wss://x.dev.xano.io", why: "already a socket scheme" },
    { base: "x.dev.xano.io", why: "scheme-less host is assumed secure" },
    { base: "https://x.dev.xano.io/", why: "trailing slash" },
    { base: "  https://x.dev.xano.io  ", why: "surrounding whitespace" },
    { base: "https://x.dev.xano.io", opts: { tenant: "ab-cd-ef" }, why: "explicit tenant" },
    { base: "https://x.dev.xano.io/tenant/ab-cd-ef", why: "tenant lifted out of the base URL" },
    {
      base: "https://x.dev.xano.io/tenant/ab-cd-ef",
      opts: { tenant: "ab-cd-ef" },
      why: "tenant named twice, in agreement",
    },
  ];

  it("produces the identical URL for every base-URL shape", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES, REALTIME));
    for (const { base, opts, why } of BASES) {
      expect(m.socketUrl("chat", base, opts), why).toBe(chat.getUrl(base, opts));
    }
  });

  it("carries the tenant prefix — the part a frontend cannot reconstruct", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES, REALTIME));
    expect(m.socketUrl("chat", "https://x.dev.xano.io/tenant/ab-cd-ef")).toBe(
      "wss://x.dev.xano.io/ws/ab-cd-ef:chat-abc",
    );
  });

  it("produces the identical path for socketPath", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES, REALTIME));
    expect(m.socketPath("chat")).toBe(chat.getPath());
    expect(m.socketPath("chat", { tenant: "ab-cd-ef" })).toBe(
      chat.getPath({ tenant: "ab-cd-ef" }),
    );
  });

  it("rejects the same inputs getUrl rejects", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES, REALTIME));
    const cases: { base: string; opts?: { tenant?: string }; why: string }[] = [
      { base: "", why: "no base URL" },
      { base: "   ", why: "blank base URL" },
      {
        base: "https://x.dev.xano.io/tenant/ab-cd-ef",
        opts: { tenant: "other-tenant" },
        why: "two tenants that disagree",
      },
      { base: "https://x.dev.xano.io", opts: { tenant: "bad:tenant" }, why: "colon in the tenant" },
      { base: "https://x.dev.xano.io", opts: { tenant: "bad/tenant" }, why: "slash in the tenant" },
    ];
    for (const { base, opts, why } of cases) {
      expect(() => m.socketUrl("chat", base, opts), why).toThrow();
      expect(() => chat.getUrl(base, opts), why).toThrow();
    }
    expect(() => m.socketUrl("nope", "https://x.dev.xano.io")).toThrow(/unknown realtime server/);
  });
});

describe("realtime manifest input", () => {
  it("refuses two channels with the same path — the manifest keys on it", () => {
    expect(() =>
      renderRouteManifest(ROUTES, {
        servers: [
          { name: "chat", canonical: "chat-abc" },
          { name: "ops", canonical: "ops-def" },
        ],
        channels: [
          { name: "rooms", server: "chat" },
          { name: "rooms", server: "ops" },
        ],
      }),
    ).toThrow(RouteManifestError);
  });

  it("refuses a channel whose server is not in the manifest", () => {
    expect(() =>
      renderRouteManifest(ROUTES, {
        servers: [{ name: "chat", canonical: "chat-abc" }],
        channels: [{ name: "rooms", server: "ops" }],
      }),
    ).toThrow(RouteManifestError);
  });
});
