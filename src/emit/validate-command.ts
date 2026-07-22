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
import { existsSync, readFileSync } from "node:fs";
import { exportBundleJson, type ParsedArgs } from "./cli.js";
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

  const bundle = await loadBundle(args);
  const client = new MetaClient(config);
  const result = await runValidateLoop(client, bundle, { reset: args.reset ?? true });

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
    const names = functionNames(bundle);
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

/** Produce the bundle text: compile a `<file>` entry or read a pre-exported `--bundle <path>`. */
async function loadBundle(args: ParsedArgs): Promise<string> {
  if (args.bundle !== undefined) {
    if (args.file !== undefined) throw new Error(`Pass either an entry <file> or --bundle <path>, not both.`);
    if (!existsSync(args.bundle)) {
      throw new Error(`${args.bundle} not found. Run \`sidestep export --out ${args.bundle}\` first.`);
    }
    return readFileSync(args.bundle, "utf8");
  }
  if (args.file !== undefined) return exportBundleJson(args);
  throw new Error(`Missing input. Usage: sidestep validate <file> | --bundle <path>.`);
}

/** Extract authored function names from a serialized bundle (for runtime smoke). */
function functionNames(bundleText: string): string[] {
  try {
    const bundle = JSON.parse(bundleText) as { payload?: { function?: unknown } };
    const fns = bundle.payload?.function;
    if (!Array.isArray(fns)) return [];
    return fns.map((f) => (f !== null && typeof f === "object" ? (f as { name?: unknown }).name : undefined)).filter(
      (n): n is string => typeof n === "string",
    );
  } catch {
    return [];
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
