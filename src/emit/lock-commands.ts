/**
 * `sidestep lock <rename|prune|adopt>` — xano.lock maintenance (U5).
 *
 * First-class fix-up flows so lock surgery never REQUIRES hand-editing (though
 * hand-editing the JSON stays supported):
 *
 *   rename <kind> <old> <new>  — move an entry keeping its identity, so the
 *                                next export renames the engine object in place
 *   prune <entry-file> [keys…] — drop orphaned entries (all, or just the named
 *                                ones); requires --yes since a pruned
 *                                canonical's URL is unrecoverable
 *   adopt <bundle.json>        — seed/update the lock from a live engine
 *                                packageExport, so an existing workspace can be
 *                                taken over by code without a delete+create sync
 *
 * `rename` and `adopt` default the lock path to `xano.lock` in the current
 * directory; `prune` defaults it beside the entry file (matching `export`).
 * `--lock=<path>` overrides all three. Results print to stdout (no bundle ever
 * streams from these commands); warnings still go to stderr.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadDefault, type ParsedArgs } from "./cli.js";
import { Xano } from "../workspace/xano.js";
import {
  adoptFromBundle,
  createLockContext,
  emptyLock,
  renameLockEntry,
  resolvePayloadKey,
  type LockEntry,
  type LockFile,
} from "../lock/lock.js";
import { readLockFile, writeLockFile } from "../lock/io.js";
import { resetLockOverrides, seedLockOverrides } from "../lock/store.js";

const LOCK_USAGE =
  "Usage: sidestep lock rename <kind> <old> <new> [--lock=<path>] | " +
  "sidestep lock prune <entry-file> [keys…] --yes [--lock=<path>] | " +
  "sidestep lock adopt <bundle.json> [--yes] [--lock=<path>]";

export async function runLockCommand(args: ParsedArgs): Promise<void> {
  const [sub] = args.positionals;
  switch (sub) {
    case "rename":
      return lockRename(args);
    case "prune":
      return lockPrune(args);
    case "adopt":
      return lockAdopt(args);
    default:
      throw new Error(`Unknown lock subcommand "${sub ?? ""}". ${LOCK_USAGE}`);
  }
}

function describeEntry(entry: LockEntry): string {
  const parts: string[] = [];
  if (entry.guid !== undefined) parts.push(`guid ${entry.guid}`);
  if (entry.canonical !== undefined) parts.push(`canonical ${entry.canonical}`);
  return parts.join(", ");
}

function lockRename(args: ParsedArgs): void {
  const [, kind, oldName, newName] = args.positionals;
  if (!kind || !oldName || !newName) {
    throw new Error(`lock rename needs <kind> <old> <new>. ${LOCK_USAGE}`);
  }
  const lockPath = args.lockPath !== undefined ? resolve(args.lockPath) : resolve("xano.lock");
  const lock = readLockFile(lockPath);
  const payloadKey = resolvePayloadKey(kind);
  const { lock: renamed, discardedNewcomer } = renameLockEntry(lock, payloadKey, oldName, newName);
  writeLockFile(lockPath, renamed);
  process.stdout.write(
    `Renamed lock entry "${payloadKey}:${oldName}" → "${payloadKey}:${newName}" ` +
      `(${describeEntry(renamed.objects[`${payloadKey}:${newName}`]!)}).\n`,
  );
  if (discardedNewcomer) {
    process.stdout.write(
      `Replaced the fresh entry the last export appended for "${payloadKey}:${newName}"` +
        (discardedNewcomer.canonical !== undefined
          ? ` — its minted canonical ${discardedNewcomer.canonical} is discarded (that URL was ` +
            `never the object's real identity)`
          : "") +
        `.\n`,
    );
  }
  process.stdout.write(`Re-run \`sidestep export\` to emit the original guid under the new name.\n`);
}

async function lockPrune(args: ParsedArgs): Promise<void> {
  const [, entryFile, ...keys] = args.positionals;
  if (!entryFile) {
    throw new Error(
      `lock prune needs the workspace entry file (to know which objects still exist). ${LOCK_USAGE}`,
    );
  }
  const lockPath =
    args.lockPath !== undefined
      ? resolve(args.lockPath)
      : join(dirname(resolve(entryFile)), "xano.lock");
  const lock = readLockFile(lockPath);
  // Same sequence as a locked export: seed BEFORE the module loads, then
  // export in-memory to learn which lock keys are still live. Nothing is
  // written except the pruned lock.
  resetLockOverrides();
  seedLockOverrides(lock);
  const def = await loadDefault(entryFile);
  if (!Xano.isXano(def)) {
    throw new Error(`Module "${entryFile}" must default-export a Xano registry for \`lock prune\`.`);
  }
  const ctx = createLockContext(lock);
  def.export({ lock: ctx });

  const orphans = Object.keys(lock.objects).filter((key) => !(key in ctx.observed));
  let targets: string[];
  if (keys.length > 0) {
    for (const key of keys) {
      if (!(key in lock.objects)) {
        throw new Error(`No lock entry "${key}" to prune.`);
      }
      if (!orphans.includes(key)) {
        throw new Error(`Lock entry "${key}" still matches an exported object — not pruning it.`);
      }
    }
    targets = keys;
  } else {
    targets = orphans;
  }
  if (targets.length === 0) {
    process.stdout.write("Nothing to prune — every lock entry matches an exported object.\n");
    return;
  }

  const lines = targets
    .sort()
    .map((key) => `  ${key} (${describeEntry(lock.objects[key]!)})`)
    .join("\n");
  const discarded = targets.filter((key) => lock.objects[key]!.canonical !== undefined);
  const canonicalNote =
    discarded.length > 0
      ? `Discards ${discarded.length} canonical(s) — a pruned canonical's public URL is unrecoverable.\n`
      : "";
  if (!args.yes) {
    process.stdout.write(`Would prune ${targets.length} lock entr(y/ies):\n${lines}\n${canonicalNote}`);
    throw new Error("lock prune is destructive — re-run with --yes to apply.");
  }
  const objects = { ...lock.objects };
  for (const key of targets) delete objects[key];
  writeLockFile(lockPath, { version: lock.version, objects });
  process.stdout.write(`Pruned ${targets.length} lock entr(y/ies):\n${lines}\n${canonicalNote}`);
}

function lockAdopt(args: ParsedArgs): void {
  const [, bundlePath] = args.positionals;
  if (!bundlePath) {
    throw new Error(`lock adopt needs a packageExport bundle file. ${LOCK_USAGE}`);
  }
  const lockPath = args.lockPath !== undefined ? resolve(args.lockPath) : resolve("xano.lock");
  const lock: LockFile = existsSync(lockPath) ? readLockFile(lockPath) : emptyLock();
  let bundle: unknown;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  } catch (err) {
    throw new Error(
      `Cannot read ${bundlePath} as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const { lock: adopted, added, changed, canonicalsSeen, vaultCount } = adoptFromBundle(
    lock,
    bundle,
    bundlePath,
  );

  if (changed.length > 0 && !args.yes) {
    const lines = changed
      .map((c) => `  ${c.key}: ${describeEntry(c.before)} → ${describeEntry(c.after)}`)
      .join("\n");
    process.stdout.write(`Adoption would overwrite ${changed.length} existing lock entr(y/ies):\n${lines}\n`);
    throw new Error("lock adopt overwrites pinned identities — re-run with --yes to apply.");
  }

  if (vaultCount > 0) {
    process.stderr.write(
      `sidestep: WARNING — ${bundlePath} contains ${vaultCount} vault entr(y/ies) (secrets). ` +
        `Do NOT commit the bundle file; delete it once adoption is done.\n`,
    );
  }
  if (!canonicalsSeen) {
    process.stderr.write(
      `sidestep: no canonicals found in ${bundlePath} — the engine's standard partial export strips ` +
        `them, so only guids were adopted. Existing public URLs are safe (the engine keeps the ` +
        `server-side canonical on guid-matched updates), but fresh imports elsewhere will mint ` +
        `new ones at the next locked export.\n`,
    );
  }

  writeLockFile(lockPath, adopted);
  process.stdout.write(
    `Adopted ${bundlePath} into ${lockPath}: ${added.length} added, ${changed.length} updated.\n`,
  );
}
