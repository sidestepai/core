/**
 * `sidestep workspace deploy` / `sidestep sandbox deploy` — the shared deploy core.
 *
 * Both commands compile-or-load a bundle, gzip+POST it, and stream the response;
 * they differ only in endpoint and in the real-workspace safety wrapper:
 *   • workspace deploy → `/api:meta/workspace/deploy`, with a pre-flight that
 *     resolves and DISPLAYS the token-scoped target workspace before the POST,
 *     a typed confirmation for `--reset` (a from-scratch rebuild), lock
 *     reconciliation from the server's authoritative response, and optional
 *     static-host upload.
 *   • sandbox deploy → `/api:meta/sandbox/bundle` (replaces the old `push`), a
 *     throwaway dev loop. It does NOT write the committed `xano.lock`: the sandbox
 *     is a different, ephemeral workspace, so reconciling its identities would
 *     pollute the lock and trip the workspace-mismatch guard on every run.
 *
 * Lock reconciliation runs STRICTLY BEFORE any static step, so a later static
 * failure never loses the reconciled lock. Both steps are independently
 * idempotent — a static failure after a committed backend deploy exits with a
 * distinct code and a resumable message rather than rolling anything back.
 *
 * Node-only and lazily imported so the browser-safe authoring bundle stays clean.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { exportBundleJson, type ParsedArgs } from "./cli.js";
import { getAccessToken } from "../auth/token.js";
import { postDeploy } from "../deploy/client.js";
import { reconcileServerLock } from "../lock/reconcile.js";
import { emptyLock } from "../lock/lock.js";
import { readLockFile, writeLockFile } from "../lock/io.js";
import { resolveTargetWorkspace } from "./profile-command.js";

const WORKSPACE_DEPLOY_PATH = "/api:meta/workspace/deploy";
const SANDBOX_DEPLOY_PATH = "/api:meta/sandbox/bundle";

/** Exit codes for post-commit issues (the deploy itself succeeded). */
const EXIT_RECONCILE_SKIPPED = 2;
const EXIT_STATIC_FAILED = 3;

export type DeployTarget = "workspace" | "sandbox";

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
  throw new Error(`Missing input. Usage: sidestep <workspace|sandbox> deploy <file> | --bundle <path>.`);
}

/** The lock path a deploy reconciles into: `--lock=<path>`, else beside the entry, else cwd. */
function resolveDeployLockPath(args: ParsedArgs): string {
  if (args.lockPath !== undefined) return resolve(args.lockPath);
  if (args.file !== undefined) return join(dirname(resolve(args.file)), "xano.lock");
  return resolve("xano.lock");
}

/** Confirm a `--reset` rebuild by naming the resolved workspace (interactive typed name or `--confirm-workspace`). */
async function confirmReset(resolvedName: string, args: ParsedArgs): Promise<void> {
  if (args.confirmWorkspace !== undefined) {
    if (args.confirmWorkspace !== resolvedName) {
      throw new Error(
        `--confirm-workspace "${args.confirmWorkspace}" does not match the target workspace "${resolvedName}". Aborting --reset.`,
      );
    }
    return;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      `--reset needs confirmation. Re-run with --confirm-workspace="${resolvedName}" for a non-interactive/CI context, or run in a terminal to confirm interactively.`,
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((res) =>
    rl.question(`Type the workspace name "${resolvedName}" to confirm a full --reset rebuild: `, (a) => {
      rl.close();
      res(a.trim());
    }),
  );
  if (answer !== resolvedName) {
    throw new Error(`Confirmation "${answer}" did not match "${resolvedName}". Aborting --reset.`);
  }
}

/** Reconcile the server's authoritative lock into the local one (workspace deploy only). */
function reconcileAndWriteLock(args: ParsedArgs, serverLock: unknown): void {
  if (serverLock === undefined) return; // older endpoint returned no lock — nothing to reconcile
  const lockPath = resolveDeployLockPath(args);
  const localExists = existsSync(lockPath);
  const local = localExists ? readLockFile(lockPath) : emptyLock();
  const outcome = reconcileServerLock(local, serverLock, {
    reset: args.reset,
    adoptWorkspace: args.adoptWorkspace,
  });
  if (outcome.status === "ok") {
    if (!localExists) {
      process.stderr.write(`No local xano.lock — writing one from the server's authoritative identities at ${lockPath}.\n`);
    }
    writeLockFile(lockPath, outcome.lock);
    return;
  }
  if (outcome.status === "workspace-mismatch") {
    process.stderr.write(
      `WARNING: local xano.lock "${outcome.key}" canonical (${outcome.local}) differs from the server's (${outcome.server}). ` +
        `The project may be pointed at a different workspace; the lock was NOT updated. ` +
        `Re-run with --adopt-workspace to rebind if this re-point is intentional.\n`,
    );
    process.exitCode = EXIT_RECONCILE_SKIPPED;
    return;
  }
  // status === "skip"
  process.stderr.write(
    `WARNING: could not reconcile xano.lock from the server response (${outcome.reason}). ` +
      `The deploy committed; the lock was not updated.\n`,
  );
  process.exitCode = EXIT_RECONCILE_SKIPPED;
}

export async function runDeployCommand(args: ParsedArgs, target: DeployTarget): Promise<void> {
  if (target === "sandbox") {
    if (args.static !== undefined) {
      throw new Error(`--static applies only to \`workspace deploy\` (sandboxes have no static host in this flow).`);
    }
    if (args.prune) {
      throw new Error(`--prune applies only to \`workspace deploy\`.`);
    }
  }

  const { bundle, source } = await loadBundle(args);
  const endpointPath = target === "workspace" ? WORKSPACE_DEPLOY_PATH : SANDBOX_DEPLOY_PATH;

  let staticWorkspaceId: number | undefined;
  if (target === "workspace") {
    // Pre-flight: resolve and DISPLAY the target workspace before mutating it.
    const resolved = await resolveTargetWorkspace(args);
    process.stderr.write(
      `Deploying ${source} -> workspace "${resolved.workspaceName}" (id ${resolved.workspaceId}) at ${resolved.instance}\n`,
    );
    if (args.reset) {
      await confirmReset(resolved.workspaceName, args);
      process.stderr.write(`--reset REBUILDS "${resolved.workspaceName}" from scratch (clears all objects + records first).\n`);
    } else if (args.prune) {
      process.stderr.write(`--prune removes objects absent from the bundle (table records kept).\n`);
    }
    staticWorkspaceId = resolved.workspaceId;
  } else {
    process.stderr.write(
      args.reset
        ? `Deploying ${source} -> sandbox; --reset REPLACES the sandbox workspace (clears it first).\n`
        : `Deploying ${source} -> sandbox (merges into the sandbox workspace).\n`,
    );
  }

  const auth = await getAccessToken(args);
  const resp = await postDeploy({ bundle, endpointPath, auth, reset: args.reset, prune: args.prune });

  // Reconcile the lock BEFORE any static step (workspace deploy only).
  if (target === "workspace") {
    reconcileAndWriteLock(args, resp.lock);
  }

  if (Array.isArray(resp.canonicalChanges) && resp.canonicalChanges.length > 0) {
    process.stderr.write(
      `WARNING: ${resp.canonicalChanges.length} public URL(s) changed on the server (${resp.canonicalChanges.join(", ")}).\n`,
    );
  }
  if (resp.baseUrl) process.stderr.write(`Deployed: ${resp.baseUrl}\n`);
  process.stdout.write(resp.raw + "\n");

  if (target === "workspace" && args.static !== undefined && staticWorkspaceId !== undefined) {
    try {
      const { deployStaticHost } = await import("../deploy/static-host.js");
      const sh = await deployStaticHost({ dir: args.static, workspaceId: staticWorkspaceId, auth });
      if (sh.url) process.stderr.write(`Static host deployed: ${sh.url}\n`);
      process.stdout.write(sh.raw + "\n");
    } catch (err) {
      process.stderr.write(
        `Backend deployed and lock reconciled, but the static-host upload failed:\n  ${err instanceof Error ? err.message : String(err)}\n` +
          `Re-run \`sidestep workspace deploy --static ${args.static}\` to retry only the static step.\n`,
      );
      process.exitCode = EXIT_STATIC_FAILED;
    }
  }
}
