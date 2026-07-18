import { describe, it, expect } from "vitest";
import { startCallbackServer, browserCommand } from "../../src/auth/loopback.js";

const CALLBACK_PATH = "/oauth/callback";

describe("loopback callback server", () => {
  it("resolves with the code when the browser redirects with a matching state", async () => {
    const listener = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: "st-1" });
    expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);

    const res = await fetch(`${listener.redirectUri}?code=abc123&state=st-1`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("Authentication complete");

    await expect(listener.waitForCode).resolves.toBe("abc123");
  });

  it("ignores a wrong-state callback (400) without tearing down the one-shot server", async () => {
    const listener = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: "st-good" });
    // A spoofed/mismatched-state hit must NOT settle the server (login-DoS guard).
    const bad = await fetch(`${listener.redirectUri}?code=abc&state=st-evil`);
    expect(bad.status).toBe(400);
    // The server is still listening: the legitimate redirect still completes.
    const good = await fetch(`${listener.redirectUri}?code=real-code&state=st-good`);
    expect(good.status).toBe(200);
    await expect(listener.waitForCode).resolves.toBe("real-code");
  });

  it("rejects a valid-state callback that carries no code", async () => {
    const listener = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: "st" });
    const rejected = expect(listener.waitForCode).rejects.toThrow(/no authorization code/i);
    const res = await fetch(`${listener.redirectUri}?state=st`);
    expect(res.status).toBe(400);
    await rejected;
  });

  it("does not reflect the server error value into the callback HTML", async () => {
    const listener = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: "st" });
    const rejected = expect(listener.waitForCode).rejects.toThrow(/access_denied/);
    const res = await fetch(`${listener.redirectUri}?error=access_denied&state=st`);
    const body = await res.text();
    expect(res.status).toBe(400);
    // The raw error surfaces in the thrown Error/stderr, never in the page.
    expect(body).not.toContain("access_denied");
    await rejected;
  });

  it("closes after handling one callback (port is freed)", async () => {
    const listener = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: "st" });
    const uri = listener.redirectUri;
    await fetch(`${uri}?code=x&state=st`);
    await listener.waitForCode;
    // The server is one-shot; a second connect should be refused.
    await expect(fetch(uri)).rejects.toThrow();
  });

  it("binds a fixed port when one is given", async () => {
    // Ask for an ephemeral port first to find a free one, then rebind explicitly.
    const probe = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: "s" });
    const port = Number(new URL(probe.redirectUri).port);
    probe.close();
    await probe.waitForCode.catch(() => {}); // absorb the cancel rejection

    const fixed = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: "s", port });
    expect(new URL(fixed.redirectUri).port).toBe(String(port));
    fixed.close();
    await fixed.waitForCode.catch(() => {});
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
