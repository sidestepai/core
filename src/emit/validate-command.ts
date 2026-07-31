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
import type { MetaClient as MetaClientType } from "../validate/meta-client.js";
import { loadBundleText } from "./bundle-input.js";
import { step, success, warn, info, detail, blank } from "./ui.js";

/** Exit code when validation runs but a check fails (distinct from a usage/transport error). */
const EXIT_VALIDATION_FAILED = 2;

export async function runValidateCommand(args: ParsedArgs): Promise<void> {
  const { resolveValidateConfig, verifyToken } = await import("../validate/config.js");
  const { MetaClient } = await import("../validate/meta-client.js");
  // No workspace override from the CLI: `validate` deploys into a disposable
  // ephemeral environment. $XANO_VALIDATE_WORKSPACE_ID names the PARENT workspace
  // that env is created under; reads target the env, whose internal id is always 1.
  const config = resolveValidateConfig({ instance: args.instance });
  const who = await verifyToken(config);
  const host = new URL(config.instance).host;
  step(`Validating against ${host}${who.name ? ` (as ${who.name})` : ""}`);

  const { bundle } = await loadBundleText(args, `Missing input. Usage: sidestep validate <file> | --bundle <path>.`);
  const client = new MetaClient(config);
  // The client creates a fresh ephemeral environment per run, so the round-trip
  // reads back exactly what this bundle produced and never an object a prior run
  // left behind. The `finally` tears it down on every path, including a rejected
  // import and a thrown transport error.
  try {
    await validateWithClient(args, client, bundle);
  } finally {
    const teardown = await client.dispose();
    // A leaked env is a real cost (it holds a URL and a database), so say so —
    // but never fail the run over it: the env carries its own expiry.
    if (teardown.error !== undefined) {
      warn("Could not delete the validation environment; it will expire on its own:");
      detail(teardown.error);
    }
  }
}

/** The validation body proper — everything that needs the imported environment. */
async function validateWithClient(args: ParsedArgs, client: MetaClientType, bundle: string): Promise<void> {
  const { runValidateLoop, runnableFunctionNames } = await import("../validate/loop.js");
  const result = await runValidateLoop(client, bundle);

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
      success(`round-trip ✓ ${entry.kind} ${entry.name}`);
    } else if (entry.status === "missing") {
      warn(`round-trip ? ${entry.kind} ${entry.name} — not found in the imported workspace`);
      failed = true;
    } else if (entry.status === "ambiguous") {
      warn(`round-trip ? ${entry.kind} ${entry.name} — multiple imported objects share its identity`);
      failed = true;
    } else {
      warn(`round-trip ✗ ${entry.kind} ${entry.name} — ${entry.diffs.length} field diff(s)`);
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
    // Run only functions that actually imported (status match/diff). Other kinds
    // (tables, queries, …) aren't invocable via the function/run route — the
    // helper gates to function-kind entries so a table name is never run.
    const names = runnableFunctionNames(result.roundTrip);
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
    if (written.length === 0) warn("nothing to capture (no objects round-tripped)");
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
