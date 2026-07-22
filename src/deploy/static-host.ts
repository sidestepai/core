/**
 * Node-only static-host deploy: archive a local directory and POST it to the
 * static-host build endpoint, which ingests the build AND deploys it to the `dev`
 * environment in one call.
 *
 * TARGET — the caller's own (parent) workspace, NOT the sandbox tenant. The
 * sandbox tenant does not serve static hosting (its impersonated `mvp-admin`
 * build publishes but the host answers `503`), so the frontend lives on the
 * caller's real workspace instead. The `workspaceId` is resolved from the OAuth
 * token's scoped workspace (see `./workspace.js`), and requests carry the
 * caller's ordinary OAuth bearer — no impersonation, no `X-Tenant` routing.
 *
 * The `api:meta` build route keys the host by NAME and auto-creates a `default`
 * host when the workspace has none, so a single call suffices — no lookup step:
 *
 *   `POST /api:meta/workspace/{id}/static_host/default/build`  (multipart) -> URLs
 *
 * Unlike the `mvp-admin` build route, the meta route auto-deploys to `dev` and
 * returns the live URL (`default_url`/`custom_url`). Matches the reference
 * `xano static_host build push` CLI.
 *
 * Archive format: a gzipped USTAR tarball, built dependency-free (the SDK stays
 * lean). The build endpoint dispatches on the uploaded filename's extension and
 * accepts `.tar.gz` (verified against the Xano engine's static-hosting build);
 * we upload as `build.tar.gz`.
 *
 * Node-only (`node:fs`/`node:zlib`) and lazily imported so the browser-safe
 * authoring bundle never pulls it in.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

const STATIC_TIMEOUT_MS = 120_000;
/** Client-side archive cap — the static upload is a second attacker-influenced payload path. */
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

interface ArchiveEntry {
  /** POSIX-separated path relative to the archived directory root. */
  path: string;
  data: Buffer;
}

/** Recursively collect regular files under `dir` with POSIX-relative paths. */
function collectFiles(dir: string): ArchiveEntry[] {
  const out: ArchiveEntry[] = [];
  const walk = (cur: string): void => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) out.push({ path: relative(dir, full).split(sep).join("/"), data: readFileSync(full) });
    }
  };
  walk(dir);
  return out;
}

/** Build one 512-byte USTAR header with a correct checksum (mtime pinned to 0 for determinism). */
function tarHeader(name: string, size: number): Buffer {
  if (Buffer.byteLength(name, "utf8") > 100) {
    throw new Error(`static-host: path "${name}" exceeds the 100-byte tar name limit; shorten it or nest less deeply.`);
  }
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, "utf8"); // name (100)
  h.write("0000644\0", 100, "ascii"); // mode 0644 (8)
  h.write("0000000\0", 108, "ascii"); // uid (8)
  h.write("0000000\0", 116, "ascii"); // gid (8)
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii"); // size (12)
  h.write("00000000000\0", 136, "ascii"); // mtime 0 (12)
  h.write("        ", 148, "ascii"); // checksum placeholder: 8 spaces
  h.write("0", 156, "ascii"); // typeflag: regular file
  h.write("ustar\0", 257, "ascii"); // magic (6)
  h.write("00", 263, "ascii"); // version (2)
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i]!;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii"); // "NNNNNN\0 " (8)
  return h;
}

/** Assemble a gzipped USTAR tarball from the collected files. Exported for tests. */
export function tarGz(files: ArchiveEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    blocks.push(tarHeader(f.path, f.data.length));
    blocks.push(f.data);
    const pad = (512 - (f.data.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0)); // two trailing zero blocks
  return gzipSync(Buffer.concat(blocks));
}

export interface StaticHostRequest {
  /** Local directory to archive and deploy. */
  dir: string;
  /** Numeric id of the caller's (parent) workspace — resolved from the token (see `./workspace.js`). */
  workspaceId: number;
  /** Instance origin to resolve the meta-API path against. */
  baseUrl: string;
  /** The caller's OAuth bearer token. */
  accessToken: string;
  /** Static-host NAME, used verbatim in the build path. The meta build route
   *  auto-creates it only when it is `default`. Defaults to `default`. */
  host?: string;
  /**
   * Public config baked into the archive's root `index.html` as `window.<KEY>`
   * globals, evaluated before the app bundle runs. The deploy layer seeds
   * `XANO_HOST` with the sandbox backend URL and merges any `--static-env`.
   *
   * A static host has no server runtime: every value here is served to the
   * browser verbatim, so it is **public** — base URLs and publishable keys only,
   * never secrets. When there is no root `index.html` to anchor to, injection is
   * skipped and `envInjected` is false.
   */
  env?: Record<string, string>;
}

export interface StaticHostResult {
  /** The deployed build's live URL, if the endpoint reports one. */
  url: string | undefined;
  /** True when `env` was non-empty AND a root `index.html` received the config script. */
  envInjected: boolean;
  raw: string;
}

/**
 * Pick the live URL out of the meta build response. The engine
 * emits `default_url`/`custom_url` (built as `https://{env.host|custom}`); older
 * shapes nested them under `dev` or exposed a bare `host`. Prefer a custom domain,
 * then the default URL, and prefix a bare host with https as a last resort.
 */
function pickUrl(parsed: Record<string, unknown>): string | undefined {
  const dev = parsed.dev as
    | { host?: unknown; custom?: unknown; url?: unknown; default_url?: unknown; custom_url?: unknown }
    | undefined;
  const direct = [parsed.custom_url, parsed.default_url, parsed.url, dev?.custom_url, dev?.default_url, dev?.url].find(
    (c): c is string => typeof c === "string" && c !== "",
  );
  if (direct !== undefined) return /^https?:\/\//.test(direct) ? direct : `https://${direct}`;
  const host = [dev?.custom, dev?.host].find((c): c is string => typeof c === "string" && c !== "");
  return host !== undefined ? `https://${host}` : undefined;
}

/**
 * Build the inline bootstrap `<script>` that assigns each env entry to a window
 * global. Bracket-notation assignment tolerates any key (including ones that
 * aren't valid identifiers), and `<`-escaping the whole payload keeps a
 * value that contains `</script>` from closing the element early.
 */
function envScript(env: Record<string, string>): string {
  const body = Object.entries(env)
    .map(([k, v]) => `window[${JSON.stringify(k)}]=${JSON.stringify(v)};`)
    .join("")
    .replace(/</g, "\\u003c");
  return `<script>${body}</script>`;
}

/**
 * Inject the bootstrap script at the very top of `<head>` so it runs before any
 * app bundle. Returns the rewritten HTML, or `undefined` when there is no `<head>`
 * to anchor to (the caller then treats config as not injected).
 */
function injectEnv(html: string, script: string): string | undefined {
  const head = /<head[^>]*>/i.exec(html);
  if (!head) return undefined;
  const at = head.index + head[0].length;
  return html.slice(0, at) + script + html.slice(at);
}

/**
 * Archive `dir` and POST it to the meta static-host build endpoint for the given
 * (parent) workspace. The route auto-creates the `default` host and auto-deploys
 * to `dev`, returning the live URL — a single call, no lookup or publish step.
 */
export async function deployStaticHost(req: StaticHostRequest): Promise<StaticHostResult> {
  if (!existsSync(req.dir)) {
    throw new Error(`--static ${req.dir}: directory not found.`);
  }
  const files = collectFiles(req.dir);
  if (files.length === 0) {
    throw new Error(`--static ${req.dir}: no files to deploy (directory is empty).`);
  }

  // Bake public config into the root index.html as window.<KEY> globals. Skipped
  // (envInjected stays false) when there is no config or no index.html to anchor to.
  let envInjected = false;
  const env = req.env ?? {};
  if (Object.keys(env).length > 0) {
    const index = files.find((f) => f.path === "index.html");
    const rewritten = index && injectEnv(index.data.toString("utf8"), envScript(env));
    if (index && rewritten !== undefined) {
      index.data = Buffer.from(rewritten, "utf8");
      envInjected = true;
    }
  }

  const archive = tarGz(files);
  if (archive.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`--static ${req.dir}: archive is ${archive.length} bytes, over the ${MAX_ARCHIVE_BYTES}-byte cap.`);
  }

  const host = req.host ?? "default";
  const url = new URL(
    `/api:meta/workspace/${req.workspaceId}/static_host/${encodeURIComponent(host)}/build`,
    req.baseUrl,
  );
  const form = new FormData();
  form.append("name", "sidestep-deploy");
  form.append("file", new Blob([archive], { type: "application/gzip" }), "build.tar.gz");

  const res = await fetch(url.href, {
    method: "POST",
    headers: { Authorization: `Bearer ${req.accessToken}` },
    body: form,
    signal: AbortSignal.timeout(STATIC_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Static-host build failed (${res.status} ${res.statusText}):\n${text}`);
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON — surface verbatim, url stays undefined */
  }
  return { url: pickUrl(parsed), envInjected, raw: text };
}
