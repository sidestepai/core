/**
 * `sidestep release` — promote your compiled workspace to your MAIN Xano instance
 * workspace (the production target), as opposed to `sidestep deploy`, which ships
 * to a disposable ephemeral/sandbox.
 *
 * Status: fully plumbed but GATED OFF. The whole path — compile/load the bundle,
 * resolve the token's workspace, encode the archive, and the guarded import — is
 * in place, but `RELEASE_ENABLED` is `false` so the command prints a "coming
 * soon" message and takes NO destructive action. It flips on once Xano exposes a
 * record-preserving import: today's `/workspace/{id}/import` runs the restore
 * path (clears objects AND records before importing), which is correct for a
 * throwaway env but must never wipe a production workspace's table data.
 *
 * The release target workspace comes strictly from the OAuth token's scoped
 * workspace — there is no `--workspace` override, so a release can only ever
 * touch the workspace the caller's token is bound to.
 *
 * Node-only and lazily imported so the browser-safe authoring bundle stays clean.
 */
import type { ParsedArgs } from "./cli.js";
import { loadBundleText } from "./bundle-input.js";
import { getAccessToken } from "../auth/token.js";
import { resolveScopedWorkspaceId } from "../deploy/workspace.js";
import { encodeWorkspaceArchive } from "../validate/archive.js";
import { importWorkspaceArchive } from "../deploy/import.js";
import { step, success, warn, detail, info, link } from "./ui.js";
import { createInterface } from "node:readline";

/**
 * Master switch. Flip to `true` ONLY once a record-preserving import is available
 * for a real instance workspace (see module header). Until then `release` refuses
 * to run the destructive full-replace import against production.
 */
const RELEASE_ENABLED: boolean = false;

export async function runReleaseCommand(args: ParsedArgs): Promise<void> {
  // Fully plumbed: compile-or-load, authenticate, resolve the token's workspace,
  // and encode the archive — everything a live release needs, computed up front.
  const { bundle, source } = await loadBundleText(
    args,
    `Missing input. Usage: sidestep release <file> | --bundle <path>.`,
  );
  const auth = await getAccessToken(args);
  // The workspace is the token's scoped workspace — no override. A release can
  // only ever touch the workspace your OAuth token is bound to.
  const workspaceId = await resolveScopedWorkspaceId(auth);
  const archive = encodeWorkspaceArchive(bundle);

  if (!RELEASE_ENABLED) {
    warn("`sidestep release` is coming soon.");
    detail(
      `It will promote your compiled workspace to your main Xano instance ` +
        `(workspace #${workspaceId}) once record-preserving import lands — a ` +
        `release must not wipe your production table data the way a full replace would.`,
    );
    detail(`For now, ship to a disposable environment: \`sidestep deploy\` (ephemeral) or \`sidestep deploy --dest sandbox\`.`);
    return;
  }

  // ── Ready to flip on ──────────────────────────────────────────────────────
  // Everything below is the live release path, gated by RELEASE_ENABLED above.
  step(`Releasing ${source} → instance workspace #${workspaceId}`);

  if (!args.yes && !args.force) {
    const ok = await confirm(`Release will REPLACE workspace #${workspaceId} on your instance. Continue?`);
    if (!ok) {
      info("Release cancelled.");
      return;
    }
  }

  // When enabled, this targets the record-preserving import for the real
  // workspace id on the caller's own instance (auth.instance), not an env base.
  await importWorkspaceArchive(auth, { baseUrl: auth.instance, archive, workspaceId });

  success(`Released to instance workspace #${workspaceId}`);
  link(auth.instance);

  // With release, the static frontend goes to the SAME instance workspace.
  const summary: { released: boolean; workspaceId: number; instance: string; static?: { url: string | undefined; verified?: boolean } } = {
    released: true,
    workspaceId,
    instance: auth.instance,
  };
  if (args.static !== undefined) {
    const { buildStaticEnv, deployStaticTo } = await import("./deploy-command.js");
    const env = buildStaticEnv(auth.instance, args.staticEnv);
    const explicit = Object.keys(args.staticEnv).length > 0;
    summary.static = await deployStaticTo(
      args.static,
      auth,
      { baseUrl: auth.instance, workspaceId, label: undefined },
      env,
      explicit,
      args.staticHost,
      args.noVerify,
    );
  }

  if (!process.stdout.isTTY) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  }
}

/** Yes/no prompt on the tty, mirroring the ephemeral-delete confirm. */
async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((res) => rl.question(`? ${message} (y/N) `, res));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
