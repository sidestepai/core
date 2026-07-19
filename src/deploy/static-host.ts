/**
 * Node-only static-host deploy: archive a local directory and POST it to the
 * existing static-host build endpoint
 * (`/api:meta/workspace/{workspace_id}/static_host/{host}/build`), which ingests
 * the build and deploys it to the `dev` environment.
 *
 * There is no sandbox-specific static-host route, so this targets the ordinary
 * meta endpoint using the credentials from the sandbox impersonation hop
 * (`impersonateSandbox`). The caller passes `baseUrl`, `accessToken` and the
 * tenant-routing `headers` explicitly; the `workspace_id` is the sandbox's own
 * workspace id, which `sandbox/bundle` returns in its response.
 *
 * The build route's `{static_host_id}` path segment is a NUMERIC id, not a name.
 * The sandbox may have no static host yet, so we first `POST .../static_host/search`
 * (empty body) — that endpoint auto-creates a `default` host when the workspace has
 * none and returns the list — and use the resolved host's numeric id in the build URL.
 *
 * Archive format: a gzipped USTAR tarball, built dependency-free (the SDK stays
 * lean). The build endpoint dispatches on the uploaded filename's extension and
 * accepts `.tar.gz` (verified against `StaticHosting::uncompress` in cloud-client);
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
  /** Numeric workspace id — the sandbox's own, as returned by `sandbox/bundle`. */
  workspaceId: number;
  /** Origin to resolve the meta-API path against. */
  baseUrl: string;
  /** Bearer token to send. */
  accessToken: string;
  /**
   * Tenant-routing headers from the impersonation hop (`X-Tenant`). Sent verbatim;
   * without them the upload lands on the caller's real workspace, not the sandbox.
   */
  headers: Record<string, string>;
  /** Static-host name to deploy into. Resolved to a numeric id via search (which
   *  auto-creates it when the workspace has none). Defaults to `default`. */
  host?: string;
}

/**
 * Resolve the sandbox's static host to a numeric id. The build route wants a
 * numeric `{static_host_id}`, and the sandbox may have no host yet — the search
 * endpoint auto-creates a `default` host when the workspace has none, so an empty
 * search reliably returns at least that one.
 */
async function resolveStaticHostId(req: StaticHostRequest): Promise<number> {
  const name = req.host ?? "default";
  const url = new URL(`/api:meta/workspace/${req.workspaceId}/static_host/search`, req.baseUrl);
  const res = await fetch(url.href, {
    method: "POST",
    headers: { ...req.headers, "Content-Type": "application/json", Authorization: `Bearer ${req.accessToken}` },
    body: "{}",
    signal: AbortSignal.timeout(STATIC_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Static-host lookup failed (${res.status} ${res.statusText}):\n${text}`);
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON — fall through to the empty-list error below */
  }
  const items = Array.isArray(parsed.items) ? (parsed.items as Array<Record<string, unknown>>) : [];
  const match = items.find((h) => h.name === name) ?? items[0];
  const id = match?.id;
  if (typeof id !== "number") {
    throw new Error(
      `Static-host lookup: the sandbox workspace has no static host to deploy into ` +
        `(expected \`static_host/search\` to auto-create "default").`,
    );
  }
  return id;
}

export interface StaticHostResult {
  /** The deployed build's live URL, if the endpoint reports one. */
  url: string | undefined;
  raw: string;
}

/** Archive `dir` and POST it to the static-host build endpoint for the given workspace. */
export async function deployStaticHost(req: StaticHostRequest): Promise<StaticHostResult> {
  if (!existsSync(req.dir)) {
    throw new Error(`--static ${req.dir}: directory not found.`);
  }
  const files = collectFiles(req.dir);
  if (files.length === 0) {
    throw new Error(`--static ${req.dir}: no files to deploy (directory is empty).`);
  }
  const archive = tarGz(files);
  if (archive.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`--static ${req.dir}: archive is ${archive.length} bytes, over the ${MAX_ARCHIVE_BYTES}-byte cap.`);
  }

  const staticHostId = await resolveStaticHostId(req);
  const url = new URL(`/api:meta/workspace/${req.workspaceId}/static_host/${staticHostId}/build`, req.baseUrl);
  const form = new FormData();
  form.append("name", "sidestep-deploy");
  form.append("file", new Blob([archive], { type: "application/gzip" }), "build.tar.gz");

  const res = await fetch(url.href, {
    method: "POST",
    headers: { ...req.headers, Authorization: `Bearer ${req.accessToken}` },
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
    /* non-JSON — surface verbatim */
  }
  const dev = (parsed.dev as { url?: unknown } | undefined)?.url;
  const built = typeof parsed.url === "string" ? parsed.url : typeof dev === "string" ? dev : undefined;
  return { url: built, raw: text };
}
