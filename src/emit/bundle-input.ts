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
import { compileBundle, type ParsedArgs } from "./cli.js";
import type { NonPublicSeedValue, SeedContentFile } from "../workspace/seed.js";

/** The resolved bundle text plus the input it came from (an entry file or a `--bundle` path). */
export interface LoadedBundle {
  bundle: string;
  source: string;
  /**
   * Seed `content/` archive entries — populated only when `opts.withSeed` is set
   * AND the input is an entry `<file>` (a pre-exported `--bundle` carries schema
   * only; there is no live registry to resolve seed rows from).
   */
  content: SeedContentFile[];
  /**
   * Seed values from columns the schema declares non-public, for the `--static`
   * publication guard. Same population rule as {@link content}.
   */
  nonPublicSeedValues: NonPublicSeedValue[];
}

/**
 * Resolve the bundle text from `--bundle <path>` or an entry `<file>`.
 * Throws on: both supplied, a missing `--bundle` file, or neither supplied
 * (the last using the caller-supplied {@link missingMessage}).
 *
 * With `opts.withSeed`, an entry-file compile also resolves the tables' seed rows
 * into signed `content/` entries (the deploy path asks for this). A `--bundle`
 * path cannot — it's already-serialized text with no registry — so `content` is
 * empty there.
 */
export async function loadBundleText(
  args: ParsedArgs,
  missingMessage: string,
  opts: { withSeed?: boolean } = {},
): Promise<LoadedBundle> {
  if (args.bundle !== undefined) {
    if (args.file !== undefined) {
      throw new Error(`Pass either an entry <file> or --bundle <path>, not both.`);
    }
    if (!existsSync(args.bundle)) {
      throw new Error(`${args.bundle} not found. Run \`sidestep export --out ${args.bundle}\` first.`);
    }
    return { bundle: readFileSync(args.bundle, "utf8"), source: args.bundle, content: [], nonPublicSeedValues: [] };
  }
  if (args.file !== undefined) {
    const { bundle, content, nonPublicSeedValues } = await compileBundle(args, { seed: opts.withSeed });
    return { bundle, source: args.file, content, nonPublicSeedValues };
  }
  throw new Error(missingMessage);
}
