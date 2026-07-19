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

const SANDBOX_DEPLOY_PATH = "/api:meta/sandbox/bundle";

/** Exit code for a post-commit static failure (the backend deploy itself succeeded). */
const EXIT_STATIC_FAILED = 3;

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
async function deployParentStatic(dir: string, auth: ResolvedAuth): Promise<void> {
  const { resolveScopedWorkspaceId } = await import("../deploy/workspace.js");
  const { deployStaticHost } = await import("../deploy/static-host.js");

  const workspaceId = await resolveScopedWorkspaceId(auth);
  const sh = await deployStaticHost({
    dir,
    workspaceId,
    baseUrl: auth.instance,
    accessToken: auth.access_token,
  });
  if (sh.url) process.stderr.write(`Static host deployed: ${sh.url}\n`);
  process.stdout.write(sh.raw + "\n");
}

export async function runDeployCommand(args: ParsedArgs): Promise<void> {
  const { bundle, source } = await loadBundle(args);

  process.stderr.write(
    args.reset
      ? `Deploying ${source} -> sandbox; --reset REPLACES the sandbox workspace (clears it first).\n`
      : `Deploying ${source} -> sandbox (merges into the sandbox workspace).\n`,
  );

  const query: Record<string, string> = {};
  if (args.reset) query.reset = "true";

  const auth = await getAccessToken(args);
  const resp = await postDeploy({ bundle, endpointPath: SANDBOX_DEPLOY_PATH, auth, query });

  if (resp.baseUrl) process.stderr.write(`Deployed: ${resp.baseUrl}\n`);
  process.stdout.write(resp.raw + "\n");

  if (args.static === undefined) return;

  try {
    await deployParentStatic(args.static, auth);
  } catch (err) {
    process.stderr.write(
      `Backend deployed, but the static-host upload failed:\n  ${err instanceof Error ? err.message : String(err)}\n` +
        `Re-run \`sidestep sandbox deploy --static ${args.static}\` to retry only the static step.\n`,
    );
    process.exitCode = EXIT_STATIC_FAILED;
  }
}
