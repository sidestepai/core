/**
 * Loopback redirect handling for the CLI's authorization-code flow. Binds a
 * short-lived `127.0.0.1` HTTP server to catch the browser's `?code=…&state=…`
 * redirect, and opens the user's browser to the authorize URL.
 *
 * Node-only (`node:http`, `node:child_process`). Never reachable from the
 * browser-safe `index.ts` surface — imported only by the `login` command.
 *
 * Testability: the server is driven directly by `fetch`ing the callback URL (no
 * real browser needed), and `openBrowser` is a no-op when `XANO_NO_BROWSER` is
 * set, so tests never spawn a browser.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";

/** How long to wait for the browser redirect before giving up (ms). */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** The redirect the browser lands on once the user authorizes. */
export interface CallbackResult {
  /** The authorization `code` (already state-validated). */
  code: string;
  /**
   * The full callback URL (`redirectUri` + the AS's query string), preserving
   * `state`/`iss` alongside `code`. openid-client's `authorizationCodeGrant`
   * derives the token-request `redirect_uri` from this URL's origin+path, so it
   * is reconstructed against `redirectUri` exactly — never the ephemeral socket.
   */
  callbackUrl: string;
}

/** A listening loopback callback server awaiting one authorization redirect. */
export interface CallbackListener {
  /** The exact `redirect_uri` to send in the authorize request (with bound port). */
  redirectUri: string;
  /** Resolves with the callback once the browser redirects back. */
  waitForCallback: Promise<CallbackResult>;
  /** Tear the server down (safe to call more than once). */
  close(): void;
}

export interface CallbackOptions {
  /** Path the redirect lands on (e.g. `/oauth/callback`). */
  callbackPath: string;
  /** The `state` value that must be echoed back, else the flow is rejected. */
  expectedState: string;
  /** Fixed port to bind; omit/0 for an OS-assigned ephemeral port. */
  port?: number;
  /** Override the redirect timeout (ms). */
  timeoutMs?: number;
}

const CLOSE_TAB_HTML =
  "<!doctype html><meta charset=utf-8><title>sidestep</title>" +
  "<body style=\"font-family:system-ui;padding:3rem;text-align:center\">" +
  "<h1>Authentication complete</h1><p>You can close this tab and return to the terminal.</p></body>";

/**
 * Start the loopback server and begin listening. Resolves once the socket is
 * bound (so `redirectUri` carries the real port) — the `waitForCallback`
 * promise resolves later, when the browser redirect arrives.
 */
export function startCallbackServer(opts: CallbackOptions): Promise<CallbackListener> {
  const { callbackPath, expectedState, port, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  return new Promise<CallbackListener>((resolveListener, rejectListener) => {
    let resolveResult!: (result: CallbackResult) => void;
    let rejectResult!: (err: Error) => void;
    const waitForCallback = new Promise<CallbackResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });
    // Set once the socket is bound; the callback URL is rebuilt against this so
    // its origin+path matches the registered redirect_uri exactly.
    let redirectUri = "";

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== callbackPath) {
        res.writeHead(404).end("Not found");
        return;
      }
      // Validate state FIRST and do NOT settle the one-shot server on a
      // mismatch: any local process could otherwise hit the callback with a
      // wrong/absent state and tear the server down before the real redirect
      // arrives (a login DoS). A spoofed request is answered 400 and ignored;
      // only a correct-state callback can complete or fail the flow.
      const state = url.searchParams.get("state");
      if (state !== expectedState) {
        respond(res, 400, "Unexpected or missing state — ignoring this request.");
        return;
      }
      // Never reflect the server-supplied `error` value into the HTML response
      // (reflected-injection footgun); keep the raw value in the thrown Error /
      // stderr only.
      const error = url.searchParams.get("error");
      if (error) {
        respond(res, 400, "Authorization failed. Check the terminal for details.");
        // Carry the raw code on `.error` (openid-client's convention) so callers
        // can recover from an authorize-time `invalid_client` the same way they
        // recover from one at the token endpoint.
        const authError: Error & { error?: string } = new Error(
          `Authorization server returned error: ${error}`,
        );
        authError.error = error;
        finish(authError);
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        respond(res, 400, "Missing authorization code.");
        finish(new Error("Callback carried no authorization code."));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }).end(CLOSE_TAB_HTML);
      // Rebuild the callback URL against the registered redirect_uri (not the raw
      // socket address) so its origin+path matches exactly, preserving every AS
      // query param (code, state, iss) for openid-client to validate.
      finish(undefined, { code, callbackUrl: `${redirectUri}?${url.searchParams.toString()}` });
    });

    // One-shot: after the first (in)valid callback, resolve/reject and close.
    const timer = setTimeout(() => {
      finish(new Error(`Timed out after ${timeoutMs}ms waiting for the browser redirect.`));
    }, timeoutMs);
    timer.unref?.();

    let settled = false;
    function finish(err?: Error, result?: CallbackResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (err) rejectResult(err);
      else resolveResult(result!);
    }

    server.on("error", (err) => {
      if (!settled) rejectListener(err);
    });
    // A one-shot server that closes right after responding can leave a socket
    // mid-flight; swallow those resets so they don't surface as unhandled errors.
    server.on("connection", (socket) => socket.on("error", () => {}));

    server.listen(port ?? 0, "127.0.0.1", () => {
      // NOTE: an ephemeral port produces a *ported* redirect_uri
      // (http://127.0.0.1:<port>/…). The seeded xano-cli client registers the
      // port-less form, so this relies on the auth server normalizing loopback
      // ports per RFC 8252 §7.3. If it does exact-match instead, pass a fixed
      // --port matching the registration. See the plan's loopback-redirect risk.
      const boundPort = (server.address() as AddressInfo).port;
      redirectUri = `http://127.0.0.1:${boundPort}${callbackPath}`;
      resolveListener({
        redirectUri,
        waitForCallback,
        close: () => finish(new Error("Login cancelled.")),
      });
    });
  });
}

function respond(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/html" }).end(
    `<!doctype html><meta charset=utf-8><body style="font-family:system-ui;padding:3rem;text-align:center">${message}</body>`,
  );
}

/** Resolve the platform browser-open command. Pure, for per-platform testing. */
export function browserCommand(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  switch (platform) {
    case "darwin":
      return { cmd: "open", args: [url] };
    case "win32":
      // `cmd /c start` treats `&` as a command separator, which mangles the
      // multi-param authorize URL; caret-escape it so the whole URL opens.
      return { cmd: "cmd", args: ["/c", "start", "", url.replace(/&/g, "^&")] };
    default:
      return { cmd: "xdg-open", args: [url] };
  }
}

/**
 * Best-effort browser launch. A no-op when `XANO_NO_BROWSER` is set (CI/tests),
 * where the caller prints the URL to stderr for the user to open manually.
 */
export function openBrowser(url: string): void {
  if (process.env.XANO_NO_BROWSER) return;
  const { cmd, args } = browserCommand(process.platform, url);
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* opener missing — the caller already printed the URL as a fallback. */
    });
    child.unref();
  } catch {
    /* best-effort — never fail login because the browser couldn't be spawned. */
  }
}
