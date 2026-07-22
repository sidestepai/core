/**
 * `sidestep validate <file>` — compile a workspace, import it into a live Xano
 * instance, read each authored object back, and diff it against what we
 * compiled; optionally run the deployed logic and/or capture the fetched JSON.
 *
 * The target instance is a base-URL + token from the environment (`.env`), so
 * the same command runs against cloud dev or a local Docker instance — see
 * `../validate/config.js`. Everything here is JSON-only over public meta routes.
 *
 * Node-only and lazily imported by the command layer so the browser-safe
 * authoring bundle never pulls in the validate stack.
 */
import type { ParsedArgs } from "./cli.js";
import { loadBundleText } from "./bundle-input.js";
import { step, success, warn, info, detail, blank } from "./ui.js";

/** Exit code when validation runs but a check fails (distinct from a usage/transport error). */
const EXIT_VALIDATION_FAILED = 2;

export async function runValidateCommand(args: ParsedArgs): Promise<void> {
  const { resolveValidateConfig, verifyToken } = await import("../validate/config.js");
  const { MetaClient } = await import("../validate/meta-client.js");
  const { runValidateLoop } = await import("../validate/loop.js");

  const config = resolveValidateConfig({ instance: args.instance, workspaceId: args.workspace });
  const who = await verifyToken(config);
  const host = new URL(config.instance).host;
  step(`Validating against ${host}${who.name ? ` (as ${who.name})` : ""}`);

  const { bundle } = await loadBundleText(args, `Missing input. Usage: sidestep validate <file> | --bundle <path>.`);
  const client = new MetaClient(config);
  // Always a clean import: validate resets the disposable sandbox first so the
  // round-trip reads back exactly what this bundle produced, never stale objects
  // left by a prior deploy. (Not gated on --reset — a merge would corrupt the diff.)
  const result = await runValidateLoop(client, bundle, { reset: true });

  if (!result.accepted) {
    warn("Import rejected by the engine:");
    detail(result.importError ?? "(no message)");
    process.exitCode = EXIT_VALIDATION_FAILED;
    return;
  }
  success(`Import accepted (workspace #${result.workspaceId ?? "?"})`);

  let failed = false;

  for (const entry of result.roundTrip) {
    if (entry.status === "match") {
      success(`round-trip ✓ ${entry.name}`);
    } else if (entry.status === "missing") {
      warn(`round-trip ? ${entry.name} — not found in the imported workspace`);
      failed = true;
    } else {
      warn(`round-trip ✗ ${entry.name} — ${entry.diffs.length} field diff(s)`);
      const shown = args.verbose ? entry.diffs : entry.diffs.slice(0, 10);
      for (const d of shown) detail(`${d.path}: expected ${fmt(d.expected)}, got ${fmt(d.actual)}`);
      if (!args.verbose && entry.diffs.length > shown.length) {
        detail(`… ${entry.diffs.length - shown.length} more (run with --verbose)`);
      }
      failed = true;
    }
  }

  for (const u of result.unchecked) {
    info(`imported ${u.count} ${u.kind} object(s) — round-trip not checked`);
  }

  if (args.runtime && result.workspaceId !== undefined) {
    // Run only functions that actually imported (status match/diff), not authored
    // names that never landed — the loop already resolved this set.
    const names = result.roundTrip.filter((e) => e.status !== "missing").map((e) => e.name);
    if (names.length > 0) {
      const { smokeRunFunctions } = await import("../validate/runtime.js");
      blank();
      const entries = await smokeRunFunctions(client, result.workspaceId, names);
      for (const e of entries) {
        if (e.ran) {
          success(`runtime ✓ ${e.name}`);
        } else {
          warn(`runtime ✗ ${e.name} (status ${e.status})`);
          if (args.verbose) detail(fmt(e.detail));
          failed = true;
        }
      }
    }
  }

  if (args.capture) {
    const { captureFixtures } = await import("../validate/capture.js");
    const written = captureFixtures(result.roundTrip, args.out);
    if (written.length === 0) warn("nothing to capture (no functions round-tripped)");
    for (const w of written) detail(`captured ${w.name} → ${w.path}`);
  }

  if (failed) {
    process.exitCode = EXIT_VALIDATION_FAILED;
  } else {
    blank();
    success("Validation passed");
  }
}

function fmt(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === undefined) return "(absent)";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
