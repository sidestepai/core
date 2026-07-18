#!/usr/bin/env node
/**
 * Executable entry for the `sidestep` bin.
 *
 * Deliberately tiny and separate from `cli.ts` (the library surface that exports
 * `run`/`parseArgs`/`loadDefault`): the CLI is driven by an *unconditional*
 * `run()` call, never by `import.meta.url` self-detection. Self-detection breaks
 * the moment the bundler code-splits the guard into a shared chunk — then
 * `import.meta.url` is the chunk, not the bin, the guard is always false, and the
 * CLI exits silently. An always-run bin can't regress that way.
 */
import { run } from "./cli.js";

run(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
