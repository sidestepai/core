/**
 * Conformance harness (KTD-4). Loads vendored cloud-client golden fixtures and
 * normalizes both sides for deep-equal. Every kind/statement test plugs into
 * this; U11 wires the full corpus through it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalize } from "../helpers/normalize.js";

export { normalize };

/** Load and parse a vendored fixture, path relative to `test/fixtures/`. */
export function loadFixture<T = unknown>(relPathFromFixtures: string): T {
  const url = new URL(`../fixtures/${relPathFromFixtures}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as T;
}

/** Normalize an encoded value and its fixture for deep-equal comparison. */
export function normalizedPair(
  encoded: unknown,
  fixture: unknown,
): { actual: unknown; expected: unknown } {
  return { actual: normalize(encoded), expected: normalize(fixture) };
}
