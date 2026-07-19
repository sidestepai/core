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
 * `--static <dir>` reaches static hosting through the impersonation hop in
 * `../deploy/impersonate.js`, because the sandbox has no static-host route of its
 * own — see that module for why the returned `X-Tenant` header is load-bearing.
 * The workspace id the static path needs is the one `sandbox/bundle` returns, so
 * the backend deploy always runs first.
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
 * Upload `dir` to the sandbox's static host. Runs the impersonation hop first so
 * the upload is routed into the sandbox tenant rather than the caller's own
 * workspace.
 */
async function deploySandboxStatic(dir: string, workspaceId: number, auth: ResolvedAuth): Promise<void> {
  const { impersonateSandbox } = await import("../deploy/impersonate.js");
  const { deployStaticHost } = await import("../deploy/static-host.js");

  const creds = await impersonateSandbox(auth);
  const sh = await deployStaticHost({
    dir,
    workspaceId,
    baseUrl: creds.baseUrl,
    accessToken: creds.accessToken,
    headers: creds.headers,
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

  // The static host lives in the sandbox's OWN workspace, whose id only the
  // deploy response carries — there is no client-side way to derive it.
  const workspaceId = resp.workspace?.id;
  if (typeof workspaceId !== "number") {
    process.stderr.write(
      `Backend deployed, but the response carried no workspace id, so the static upload was skipped.\n` +
        `Re-run \`sidestep sandbox deploy --static ${args.static}\` once the endpoint returns \`workspace.id\`.\n`,
    );
    process.exitCode = EXIT_STATIC_FAILED;
    return;
  }

  try {
    await deploySandboxStatic(args.static, workspaceId, auth);
  } catch (err) {
    process.stderr.write(
      `Backend deployed, but the static-host upload failed:\n  ${err instanceof Error ? err.message : String(err)}\n` +
        `Re-run \`sidestep sandbox deploy --static ${args.static}\` to retry only the static step.\n`,
    );
    process.exitCode = EXIT_STATIC_FAILED;
  }
}
