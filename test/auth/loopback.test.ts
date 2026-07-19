import { describe, it, expect } from "vitest";
import http from "node:http";
import net from "node:net";
import { startCallbackServer, browserCommand } from "../../src/auth/loopback.js";

const CALLBACK_PATH = "/oauth/callback";

describe("loopback callback server", () => {
  it("resolves with the code and a redirect_uri-anchored callback URL on matching state", async () => {
    const listener = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: "st-1" });
    expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);

    const res = await fetch(`${listener.redirectUri}?code=abc123&state=st-1&iss=https%3A%2F%2Fapp.xano.com`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("Authentication complete");

    const result = await listener.waitForCallback;
    expect(result.code).toBe("abc123");
    // The callback URL is rebuilt against the registered redirect_uri (so its
    // origin+path match exactly) and preserves state + iss for openid-client.
    const cb = new URL(result.callbackUrl);
    expect(`${cb.origin}${cb.pathname}`).toBe(listener.redirectUri);
    expect(cb.searchParams.get("code")).toBe("abc123");
    expect(cb.searchParams.get("state")).toBe("st-1");
    expect(cb.searchParams.get("iss")).toBe("https://app.xano.com");
  });

  it("ignores a wrong-state callback (400) without tearing down the one-shot server", async () => {
    const listener = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: "st-good" });
    // A spoofed/mismatched-state hit must NOT settle the server (login-DoS guard).
    const bad = await fetch(`${listener.redirectUri}?code=abc&state=st-evil`);
    expect(bad.status).toBe(400);
    // The server is still listening: the legitimate redirect still completes.
    const good = await fetch(`${listener.redirectUri}?code=real-code&state=st-good`);
    expect(good.status).toBe(200);
    await expect(listener.waitForCallback).resolves.toMatchObject({ code: "real-code" });
  });

  it("rejects a valid-state callback that carries no code", async () => {
    const listener = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: "st" });
    const rejected = expect(listener.waitForCallback).rejects.toThrow(/no authorization code/i);
    const res = await fetch(`${listener.redirectUri}?state=st`);
    expect(res.status).toBe(400);
    await rejected;
  });

  it("does not reflect the server error value into the callback HTML, and tags the code on `.error`", async () => {
    const listener = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: "st" });
    const rejected = listener.waitForCallback.then(
      () => {
        throw new Error("expected rejection");
      },
      (err: Error & { error?: string }) => err,
    );
    const res = await fetch(`${listener.redirectUri}?error=invalid_client&state=st`);
    const body = await res.text();
    expect(res.status).toBe(400);
    // The raw error surfaces in the thrown Error/stderr, never in the page.
    expect(body).not.toContain("invalid_client");
    const err = await rejected;
    expect(err.message).toMatch(/invalid_client/);
    // The raw OAuth code rides on `.error` so login's recovery can detect it.
    expect(err.error).toBe("invalid_client");
  });

  it("closes after handling one callback (port is freed)", async () => {
    const listener = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: "st" });
    const uri = listener.redirectUri;
    await fetch(`${uri}?code=x&state=st`);
    await listener.waitForCallback;
    // The server is one-shot; a second connect should be refused.
    await expect(fetch(uri)).rejects.toThrow();
  });

  it("destroys the browser's keep-alive callback socket so the CLI can exit promptly", async () => {
    const listener = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: "st" });
    const { hostname, port } = new URL(listener.redirectUri);
    // A keep-alive agent mimics the browser: it would normally hold the callback
    // socket open for reuse. `server.close()` alone leaves such a socket alive and
    // keeps Node's event loop from draining — the CLI would hang after login. The
    // server must actively destroy the socket.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const socketClosed = new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: hostname, port: Number(port), path: `${CALLBACK_PATH}?code=x&state=st`, agent },
        (res) => res.resume(),
      );
      req.on("socket", (socket) => socket.on("close", () => resolve()));
      req.on("error", reject);
      req.end();
    });

    await listener.waitForCallback;
    // A short deadline turns a regression into a clear failure rather than a hang.
    await Promise.race([
      socketClosed,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("keep-alive callback socket was not destroyed")), 2000).unref(),
      ),
    ]);
    agent.destroy();
  });

  it("destroys idle preconnect sockets so the CLI can exit promptly after login", async () => {
    const listener = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: "st" });
    const { hostname, port } = new URL(listener.redirectUri);
    // Browsers open speculative preconnect sockets that never send a request.
    // `Connection: close` can't reap those (there is no response to close on), and
    // `server.close()` only stops NEW connections — so this idle socket would keep
    // Node's event loop alive and the CLI would hang after login. The server must
    // actively destroy it.
    const idle = net.connect(Number(port), hostname);
    await new Promise<void>((resolve, reject) => {
      idle.once("connect", () => resolve());
      idle.once("error", reject);
    });
    const idleClosed = new Promise<void>((resolve) => idle.once("close", () => resolve()));

    // Complete the real flow on a separate connection.
    await fetch(`${listener.redirectUri}?code=x&state=st`);
    await listener.waitForCallback;

    // A short deadline turns a regression into a clear failure rather than a hang.
    await Promise.race([
      idleClosed,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("idle preconnect socket was not destroyed")), 2000).unref(),
      ),
    ]);
  });

  it("binds a fixed port when one is given", async () => {
    // Ask for an ephemeral port first to find a free one, then rebind explicitly.
    const probe = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: "s" });
    const port = Number(new URL(probe.redirectUri).port);
    probe.close();
    await probe.waitForCallback.catch(() => {}); // absorb the cancel rejection

    const fixed = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: "s", port });
    expect(new URL(fixed.redirectUri).port).toBe(String(port));
    fixed.close();
    await fixed.waitForCallback.catch(() => {});
  });
});

describe("browserCommand", () => {
  it("uses `open` on macOS", () => {
    expect(browserCommand("darwin", "https://x")).toEqual({ cmd: "open", args: ["https://x"] });
  });

  it("uses `start` via cmd on Windows", () => {
    expect(browserCommand("win32", "https://x")).toEqual({ cmd: "cmd", args: ["/c", "start", "", "https://x"] });
  });

  it("falls back to xdg-open elsewhere", () => {
    expect(browserCommand("linux", "https://x")).toEqual({ cmd: "xdg-open", args: ["https://x"] });
  });

  it("caret-escapes `&` in the URL for Windows cmd", () => {
    const { args } = browserCommand("win32", "https://x/a?b=1&c=2&d=3");
    expect(args[3]).toBe("https://x/a?b=1^&c=2^&d=3");
  });
});
