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
import { run, readVersion } from "./cli.js";
import { reportFailure } from "./errors.js";
import { maybeNotifyUpdate } from "./update-check.js";

run(process.argv.slice(2))
  // After a successful command, nudge if a newer @sidestep/core is on npm.
  // Best-effort and swallowed internally — it can never fail the run.
  .then(() => maybeNotifyUpdate())
  .catch((err) => {
    // Deliberately no update nudge here: an "a newer version is available"
    // banner under a failed command is noise at the exact moment the user is
    // trying to read what went wrong.
    reportFailure(err, readVersion());
    process.exit(1);
  });
