/**
 * `@sidestep/core/node` — the Node entry.
 *
 * Re-exports the entire browser-safe authoring surface (`@sidestep/core`) plus the
 * `node:fs`-backed helpers that don't belong in a frontend bundle: artifact/
 * bundle writers, lock-file read/write, and the programmatic CLI (`run`,
 * `parseArgs`, `loadDefault`). Build scripts, the `sidestep` bin, and tooling
 * import from here; workspace defs consumed by a frontend import from
 * `@sidestep/core`.
 */
export * from "./index.js";

// node:fs artifact + bundle writers
export { writeArtifact, writeBundle } from "./emit/write.js";

// node:fs lock-file I/O
export { readLockFile, writeLockFile } from "./lock/io.js";

// Programmatic CLI surface
export { run, parseArgs, loadDefault, exportBundleJson } from "./emit/cli.js";
