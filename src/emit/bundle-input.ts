/**
 * Shared bundle-input resolution for the commands that accept an entry `<file>`
 * OR a pre-exported `--bundle <path>` (`sandbox deploy`, `sandbox export --format
 * json`, `validate`). Compiling an entry runs the full `exportBundleJson`
 * pipeline (lock seed → export → lock write); `--bundle` reads the file verbatim.
 * The two are mutually exclusive.
 *
 * Callers differ only in the "no input at all" message, so that is the one knob
 * this helper takes. It always returns the bundle text plus a `source` label
 * (the file/bundle path) for progress output — callers that don't need `source`
 * just ignore it.
 *
 * Node-only (reads the filesystem); imported by the Node-only command modules.
 */
import { existsSync, readFileSync } from "node:fs";
import { exportBundleJson, type ParsedArgs } from "./cli.js";

/** The resolved bundle text plus the input it came from (an entry file or a `--bundle` path). */
export interface LoadedBundle {
  bundle: string;
  source: string;
}

/**
 * Resolve the bundle text from `--bundle <path>` or an entry `<file>`.
 * Throws on: both supplied, a missing `--bundle` file, or neither supplied
 * (the last using the caller-supplied {@link missingMessage}).
 */
export async function loadBundleText(args: ParsedArgs, missingMessage: string): Promise<LoadedBundle> {
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
  throw new Error(missingMessage);
}
