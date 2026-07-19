/**
 * Node-only static-host deploy: archive a local directory and POST it to the
 * existing static-host build endpoint
 * (`/api:meta/workspace/{workspace_id}/static_host/{host}/build`), which ingests
 * the build and deploys it to the `dev` environment.
 *
 * The `workspace_id` is the numeric id from the shared resolver (U9) — the
 * static-host path is NOT token-resolved, so the caller passes it explicitly.
 *
 * Archive format: a gzipped USTAR tarball, built dependency-free (the SDK stays
 * lean). NOTE(verify): confirm the build endpoint accepts tar.gz vs. zip against
 * a live instance — this is the plan's flagged execution-time unknown.
 *
 * Node-only (`node:fs`/`node:zlib`) and lazily imported so the browser-safe
 * authoring bundle never pulls it in.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import type { ResolvedAuth } from "../auth/token.js";

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
  /** Numeric workspace id (from the shared resolver). */
  workspaceId: number;
  auth: ResolvedAuth;
  /** Static-host name; the endpoint auto-creates `default` on first build. */
  host?: string;
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

  const host = req.host ?? "default";
  const url = new URL(`/api:meta/workspace/${req.workspaceId}/static_host/${host}/build`, req.auth.instance);
  const form = new FormData();
  form.append("name", "sidestep-deploy");
  form.append("file", new Blob([archive], { type: "application/gzip" }), "build.tar.gz");

  const res = await fetch(url.href, {
    method: "POST",
    headers: { Authorization: `Bearer ${req.auth.access_token}` },
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
