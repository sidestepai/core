/**
 * `--capture`: write each round-tripped function's fetched persisted JSON to a
 * file. That JSON is the shape the golden corpus mirrors, so a captured file is
 * a candidate an SDK maintainer can promote into `test/fixtures/` (a reviewed,
 * manual step — capture only produces candidates).
 *
 * Node-only; lazily reached through the command.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import type { RoundTripEntry } from "./loop.js";

/** A file written by capture. */
export interface CapturedFile {
  name: string;
  path: string;
}

/**
 * Write the fetched JSON for each entry that has one. `outDir` defaults to
 * `./validate-out`. Returns what was written (entries without a `fetched` body —
 * e.g. `missing` — are skipped).
 */
export function captureFixtures(entries: RoundTripEntry[], outDir = "validate-out"): CapturedFile[] {
  const written: CapturedFile[] = [];
  for (const entry of entries) {
    if (entry.fetched === undefined) continue;
    const path = resolvePath(outDir, `${safeName(entry.name)}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(entry.fetched, null, 2) + "\n", "utf8");
    written.push({ name: entry.name, path });
  }
  return written;
}

/** Keep a filename filesystem-safe without losing readability. */
function safeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned === "" ? "fixture" : cleaned;
}
