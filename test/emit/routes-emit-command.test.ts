/**
 * `sidestep routes <entry> --emit` end to end (issues #223, #233).
 *
 * The renderer has its own equivalence tests; what is checked here is the half
 * the CLI owns — pulling the realtime servers and channels out of the exported
 * bundle, joining each channel to its server by guid, and resolving the server's
 * canonical the same READ-ONLY way an api group's is resolved (in-code value,
 * then the token frozen in `xano.lock`, never minted). A canonical resolved from
 * the wrong place is a manifest that compiles and dials a socket nobody is
 * listening on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../src/emit/cli.js";
import { serializeLock, LOCK_VERSION, type LockFile } from "../../src/lock/lock.js";
import { resetLockOverrides } from "../../src/lock/store.js";

const SDK = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

function spyOnWrite(stream: NodeJS.WriteStream) {
  return vi.spyOn(stream, "write").mockImplementation(() => true);
}

let dir: string;
let stdoutSpy: ReturnType<typeof spyOnWrite>;
let stderrSpy: ReturnType<typeof spyOnWrite>;
let fileSeq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sidestep-routes-emit-"));
  stdoutSpy = spyOnWrite(process.stdout);
  stderrSpy = spyOnWrite(process.stderr);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  resetLockOverrides();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A workspace with one endpoint and one realtime server owning two channels.
 * `canonical` is left off the server when `serverCanonical` is undefined, which
 * is the case the lock has to answer.
 */
function writeWorkspace(serverCanonical?: string): string {
  const path = join(dir, `ws-${process.pid}-${++fileSeq}.ts`);
  const canonical = serverCanonical ? `, canonical: ${JSON.stringify(serverCanonical)}` : "";
  writeFileSync(
    path,
    `import { Xano, apiGroup, query, realtimeServer, realtimeChannel, input, c } from ${JSON.stringify(SDK)};
const app = apiGroup({ name: "public", canonical: "app-tok" });
const chat = realtimeServer({ name: "chat", enabled: true${canonical} });
export default new Xano()
  .registerWorkspace({ name: "rt" })
  .registerApiGroups([app])
  .registerQueries([
    query({ name: "health", verb: "GET", apiGroup: app, stack: [], response: { ok: c.bool(true) } }),
  ])
  .registerRealtimeServers([chat])
  .registerRealtimeChannels([
    realtimeChannel({ name: "lobby", server: chat }),
    realtimeChannel({
      name: "rooms/{room_id}",
      server: chat,
      input: { room_id: input.int({ required: true }) },
    }),
  ]);
`,
    "utf8",
  );
  return path;
}

function writeLock(objects: LockFile["objects"]): string {
  const path = join(dir, "xano.lock");
  writeFileSync(path, serializeLock({ version: LOCK_VERSION, objects }), "utf8");
  return path;
}

function stderrText(): string {
  return stderrSpy.mock.calls.map((c) => String(c[0])).join("");
}

describe("sidestep routes --emit, realtime half", () => {
  it("carries the servers and channels the workspace registered", async () => {
    const entry = writeWorkspace("chat-tok");
    const out = join(dir, "routes.gen.ts");
    await run(["routes", entry, "--emit", out]);
    const source = readFileSync(out, "utf8");

    expect(source).toContain(`"chat": { canonical: "chat-tok" }`);
    expect(source).toContain(`"lobby": { server: "chat" }`);
    expect(source).toContain(`"rooms/{room_id}": { server: "chat" }`);
    // The channel's {param} is typed, exactly as a route's is.
    expect(source).toContain(
      `export function channelPath(name: "rooms/{room_id}", params: { "room_id": string | number }): string;`,
    );
    // Still the file's whole point.
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(stderrText()).toContain("1 route, 2 channels");
  });

  it("resolves a server's canonical from xano.lock when the def has none", async () => {
    const entry = writeWorkspace();
    const lock = writeLock({ "realtime_server:chat": { canonical: "LockedTok" } });
    const out = join(dir, "routes.gen.ts");
    await run(["routes", entry, "--emit", out, `--lock=${lock}`]);
    expect(readFileSync(out, "utf8")).toContain(`"chat": { canonical: "LockedTok" }`);
  });

  it("leaves out a server whose canonical resolves nowhere, and still emits the routes", async () => {
    const entry = writeWorkspace();
    const out = join(dir, "routes.gen.ts");
    // No in-code canonical and no lock: minting one here would bake a token that
    // differs from the one `export --lock` later freezes. But a workspace that
    // merely CONTAINS realtime must still get its HTTP half — failing the whole
    // emit would break `routes --emit` for every frontend that never opens a
    // socket. The channels go with their server, and reaching for either is a
    // compile error at the call site rather than a wrong address at runtime.
    await run(["routes", entry, "--emit", out]);
    const source = readFileSync(out, "utf8");
    expect(source).toContain(`"health": { verb: "GET", path: "/api:app-tok/health" }`);
    expect(source).not.toContain("REALTIME_SERVERS");
    expect(source).not.toContain("lobby");
    expect(stderrText()).toMatch(/leaving out 1 realtime server\(s\) — "chat"/);
    expect(stderrText()).toContain("sidestep export --lock");
  });

  it("never sees a channel whose server is unregistered — export refuses it first", async () => {
    const path = join(dir, `orphan-${++fileSeq}.ts`);
    writeFileSync(
      path,
      `import { Xano, realtimeServer, realtimeChannel } from ${JSON.stringify(SDK)};
const chat = realtimeServer({ name: "chat", enabled: true, canonical: "chat-tok" });
const ops = realtimeServer({ name: "ops", enabled: true, canonical: "ops-tok" });
export default new Xano()
  .registerWorkspace({ name: "orphan" })
  .registerRealtimeServers([chat])
  .registerRealtimeChannels([
    realtimeChannel({ name: "lobby", server: chat }),
    // \`ops\` is never registered — an unresolvable reference.
    realtimeChannel({ name: "alerts", server: ops }),
  ]);
`,
      "utf8",
    );
    // Pins WHY the emitter carries no handling for this: the registry's own
    // reference check fires during `export()`, before the manifest is built.
    await expect(
      run(["routes", path, "--emit", join(dir, "routes.gen.ts")]),
    ).rejects.toThrow(/not registered on this workspace/);
  });

  it("writes nothing when everything it could describe was left out", async () => {
    const path = join(dir, `empty-${++fileSeq}.ts`);
    writeFileSync(
      path,
      `import { Xano, realtimeServer, realtimeChannel } from ${JSON.stringify(SDK)};
const chat = realtimeServer({ name: "chat", enabled: true });
export default new Xano()
  .registerWorkspace({ name: "nothing" })
  .registerRealtimeServers([chat])
  .registerRealtimeChannels([realtimeChannel({ name: "lobby", server: chat })]);
`,
      "utf8",
    );
    const out = join(dir, "routes.gen.ts");
    await run(["routes", path, "--emit", out]);
    // A file exporting nothing is worse than no file; the warning says what to fix.
    expect(existsSync(out)).toBe(false);
    expect(stderrText()).toContain("Nothing to write");
  });

  it("emits for a realtime-only workspace, which has no routes at all", async () => {
    const path = join(dir, `rt-only-${++fileSeq}.ts`);
    writeFileSync(
      path,
      `import { Xano, realtimeServer, realtimeChannel } from ${JSON.stringify(SDK)};
const chat = realtimeServer({ name: "chat", enabled: true, canonical: "chat-tok" });
export default new Xano()
  .registerWorkspace({ name: "rtonly" })
  .registerRealtimeServers([chat])
  .registerRealtimeChannels([realtimeChannel({ name: "lobby", server: chat })]);
`,
      "utf8",
    );
    const out = join(dir, "routes.gen.ts");
    await run(["routes", path, "--emit", out]);
    const source = readFileSync(out, "utf8");
    expect(source).toContain("export const ROUTES = {} as const;");
    expect(source).toContain(`"chat": { canonical: "chat-tok" }`);
  });

  it("leaves a query-only workspace's manifest free of realtime", async () => {
    const path = join(dir, `plain-${++fileSeq}.ts`);
    writeFileSync(
      path,
      `import { Xano, apiGroup, query, c } from ${JSON.stringify(SDK)};
const app = apiGroup({ name: "public", canonical: "app-tok" });
export default new Xano()
  .registerWorkspace({ name: "plain" })
  .registerApiGroups([app])
  .registerQueries([
    query({ name: "health", verb: "GET", apiGroup: app, stack: [], response: { ok: c.bool(true) } }),
  ]);
`,
      "utf8",
    );
    const out = join(dir, "routes.gen.ts");
    await run(["routes", path, "--emit", out]);
    expect(readFileSync(out, "utf8")).not.toContain("REALTIME_SERVERS");
    expect(stderrText()).toContain("1 route)");
  });
});
