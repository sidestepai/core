/**
 * `sidestep sandbox deploy` — compile-or-load a bundle, POST it to the sandbox,
 * and optionally upload a static frontend alongside it.
 *
 * The sandbox is the only deploy target. It is a throwaway dev loop against the
 * caller's singleton sandbox tenant, so nothing the SERVER returns is ever written
 * back into `xano.lock` — the sandbox is a different, ephemeral workspace and
 * reconciling its identities would pollute the lock. Guid reconciliation stays a
 * separate, explicit step (`sidestep lock adopt`) driven off an exported bundle.
 *
 * Note this is narrower than "never touches the lock": deploying an ENTRY FILE
 * goes through `exportBundleJson`, the same compile pipeline as `sidestep export`,
 * which does maintain the local lock as a side effect (when one exists or `--lock`
 * is passed). That write is local-identity bookkeeping, unrelated to the deploy.
 * `--bundle <path>` skips compiling entirely and so never touches the lock.
 *
 * `--static <dir>` deploys the frontend to the caller's OWN (parent) workspace,
 * NOT the sandbox — the sandbox tenant does not serve static hosting (see
 * `../deploy/static-host.js`). The target workspace id is resolved from the OAuth
 * token (`../deploy/workspace.js`) and the upload uses the caller's ordinary
 * bearer, so the static step is independent of the backend deploy.
 *
 * Both steps are independently idempotent: a static failure after a committed
 * backend deploy exits with a distinct code and a resumable message rather than
 * rolling anything back.
 *
 * Node-only and lazily imported so the browser-safe authoring bundle stays clean.
 */
import { existsSync, readFileSync } from "node:fs";
import { exportBundleJson, type ParsedArgs } from "./cli.js";
import { getAccessToken, type ResolvedAuth } from "../auth/token.js";
import { postDeploy } from "../deploy/client.js";
import { step, success, warn, detail } from "./ui.js";

const SANDBOX_DEPLOY_PATH = "/api:meta/sandbox/bundle";

/** Exit code for a post-commit static failure (the backend deploy itself succeeded). */
const EXIT_STATIC_FAILED = 3;

/**
 * The projected, safe-to-print deploy result written to stdout as JSON. Mirrors
 * `sandbox details` / `profile me`: only the stable, useful fields — never the
 * raw workspace blob, which carries per-tenant secrets (crypto keys, salts,
 * documentation tokens) that must not land in shell history or CI logs.
 */
interface DeploySummary {
  baseUrl: string | undefined;
  workspace: { id: number | undefined; name: string | undefined } | undefined;
  static?: { url: string | undefined };
}

/** Produce the bundle: from `--bundle <path>` or by compiling an entry `<file>` (mutually exclusive). */
async function loadBundle(args: ParsedArgs): Promise<{ bundle: string; source: string }> {
  if (args.bundle !== undefined) {
    if (args.file !== undefined) {
      throw new Error(`Pass either an entry <file> or --bundle <path>, not both.`);
    }
    if (!existsSync(args.bundle)) {
      throw new Error(`${args.bundle} not found. Run \`sidestep export --out ${args.bundle}\` first.`);
    }
    return { bundle: readFileSync(args.bundle, "utf8"), source: args.bundle };
  }
  if (args.file !== undefined) {
    return { bundle: await exportBundleJson(args), source: args.file };
  }
  throw new Error(`Missing input. Usage: sidestep sandbox deploy <file> | --bundle <path>.`);
}

/**
 * Upload `dir` to the caller's (parent) workspace static host. Resolves the
 * target workspace id from the OAuth token, then uploads with the caller's own
 * bearer — the sandbox tenant does not serve static hosting, so the frontend
 * lives on the real workspace.
 */
/**
 * Build the static-host config globals: the backend URL is seeded as `XANO_HOST`,
 * then the caller's `--static-env` pairs override/extend it (an explicit
 * `XANO_HOST=` wins over the seed). Exported for tests.
 */
export function buildStaticEnv(
  baseUrl: string | undefined,
  staticEnv: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (baseUrl) env.XANO_HOST = baseUrl;
  Object.assign(env, staticEnv);
  return env;
}

async function deployParentStatic(
  dir: string,
  auth: ResolvedAuth,
  env: Record<string, string>,
  explicit: boolean,
  host?: string,
): Promise<DeploySummary["static"]> {
  const { resolveScopedWorkspaceId } = await import("../deploy/workspace.js");
  const { deployStaticHost } = await import("../deploy/static-host.js");

  step(`Deploying static frontend ${dir}${host ? ` (host: ${host})` : ""}`);
  const workspaceId = await resolveScopedWorkspaceId(auth);
  const sh = await deployStaticHost({
    host,
    dir,
    workspaceId,
    baseUrl: auth.instance,
    accessToken: auth.access_token,
    env,
  });
  success("Static host deployed");
  if (sh.url) detail(sh.url);
  const globals = Object.keys(env).map((k) => `window.${k}`);
  if (globals.length === 0) return { url: sh.url };
  if (sh.envInjected) {
    detail(`Config injected into index.html: ${globals.join(", ")}`);
  } else if (explicit) {
    // The caller asked for config via --static-env and it could not be delivered — warn loudly.
    warn(`Config not injected — no <head> in a root index.html to anchor to. ${globals.join(", ")} unset.`);
  } else {
    // Only the auto-seeded XANO_HOST was in play; a static host with no root index.html is a fine, quiet outcome.
    detail(`No root index.html to inject window.XANO_HOST into — skipped.`);
  }
  return { url: sh.url };
}

export async function runDeployCommand(args: ParsedArgs): Promise<void> {
  const { bundle, source } = await loadBundle(args);

  step(
    args.reset
      ? `Deploying ${source} → sandbox (reset: clears the workspace, then imports)`
      : `Deploying ${source} → sandbox (merge)`,
  );

  const query: Record<string, string> = {};
  if (args.reset) query.reset = "true";

  const auth = await getAccessToken(args);
  const resp = await postDeploy({ bundle, endpointPath: SANDBOX_DEPLOY_PATH, auth, query });

  success("Backend deployed");
  if (resp.baseUrl) detail(resp.baseUrl);

  const summary: DeploySummary = {
    baseUrl: resp.baseUrl,
    workspace: resp.workspace ? { id: resp.workspace.id, name: resp.workspace.name } : undefined,
  };

  if (args.static !== undefined) {
    // Seed the backend URL as window.XANO_HOST, then let --static-env override/extend it.
    const env = buildStaticEnv(resp.baseUrl, args.staticEnv);
    const explicit = Object.keys(args.staticEnv).length > 0;
    try {
      summary.static = await deployParentStatic(args.static, auth, env, explicit, args.staticHost);
    } catch (err) {
      warn("Backend deployed, but the static-host upload failed:");
      detail(err instanceof Error ? err.message : String(err));
      detail(
        `Retry just the static step: sidestep sandbox deploy --static ${args.static}` +
          (args.staticHost ? ` --static-host ${args.staticHost}` : ""),
      );
      process.exitCode = EXIT_STATIC_FAILED;
    }
  }

  // stdout is the machine-readable data channel: emit the projected, secret-free
  // summary as JSON when it's piped or redirected (`… deploy | jq`, CI logs). When
  // stdout is an interactive terminal, a raw JSON dump under the formatted progress
  // is just noise — the URLs are already shown, so add only the workspace line.
  if (process.stdout.isTTY) {
    if (summary.workspace?.name) {
      const { id, name } = summary.workspace;
      detail(`workspace: ${name}${id !== undefined ? ` (#${id})` : ""}`);
    }
  } else {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  }
}
