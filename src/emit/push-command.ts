/**
 * `sidestep push <file>` / `sidestep push --bundle <path>` — upload a compiled
 * workspace bundle to the cloud-client SANDBOX import endpoint
 * (`POST /api:meta/sandbox/bundle`), authenticating with an OAuth access token.
 *
 * Auth (see `src/auth/`): `push` never reads static credentials. It resolves an
 * access token from either
 *   • `XANO_REFRESH_TOKEN` (CI): exchanged for a fresh access token via the
 *     refresh grant — no browser, no token file; requires --instance/$XANO_INSTANCE, or
 *   • the project-local token cache written by `sidestep login`, silently
 *     refreshing (and persisting the rotated refresh token) when the cached
 *     access token has expired.
 * Run `sidestep login --instance <origin>` once to populate the cache.
 *
 * IMPORTANT — this is destructive and non-permanent:
 *   • The sandbox import RESETS the target sandbox and then loads the bundle, so
 *     any existing sandbox state is discarded. It is a transient dev workflow,
 *     not a production deploy.
 *   • It writes to the caller's live instance. An automated agent must get
 *     explicit user confirmation before running `sidestep push` — never unattended.
 *
 * `push <file>` compiles the workspace in-process (identical to `export`,
 * including xano.lock seeding/merge) and uploads the result — no bundle file is
 * written. `push --bundle <path>` uploads a bundle produced by an earlier
 * `export`, for CI where the two steps are separate.
 *
 * The upload itself never mints or mutates identity, so no lock guard applies to
 * it (the `export` half of `push <file>` still honors the lock as usual).
 */
import { existsSync, readFileSync } from "node:fs";
import { exportBundleJson, type ParsedArgs } from "./cli.js";
import { getAccessToken } from "../auth/token.js";

/** Meta-API route that resets the sandbox and imports the posted bundle. */
const SANDBOX_IMPORT_PATH = "/api:meta/sandbox/bundle";

/** Bound the upload so a stalled endpoint can't hang the CLI/CI forever (larger than
 *  the OAuth timeout — a bundle import is a bigger request). */
const UPLOAD_TIMEOUT_MS = 120_000;

export async function runPushCommand(args: ParsedArgs): Promise<void> {
  // Produce the bundle: from an existing file (--bundle) or by compiling an
  // entry in-process. The two are mutually exclusive — refuse an ambiguous mix
  // rather than silently preferring one.
  let bundle: string;
  let source: string;
  if (args.bundle !== undefined) {
    if (args.file !== undefined) {
      throw new Error(`Pass either an entry <file> or --bundle <path>, not both.`);
    }
    if (!existsSync(args.bundle)) {
      throw new Error(`${args.bundle} not found. Run \`sidestep export --out ${args.bundle}\` first.`);
    }
    bundle = readFileSync(args.bundle, "utf8");
    source = args.bundle;
  } else if (args.file !== undefined) {
    bundle = await exportBundleJson(args);
    source = args.file;
  } else {
    throw new Error(`Missing input. Usage: sidestep push <file> | sidestep push --bundle <path>.`);
  }

  const { access_token, instance } = await getAccessToken(args);
  const url = new URL(SANDBOX_IMPORT_PATH, instance).href;

  // Progress goes to stderr so stdout carries only the endpoint's response body.
  process.stderr.write(`Pushing ${source} -> ${url}; this RESETS the sandbox.\n`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${access_token}`,
    },
    body: bundle,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Sandbox import failed (${res.status} ${res.statusText}):\n${text}`);
  }
  process.stdout.write(`${text}\n`);
}
