/**
 * Node-only artifact writers. Split from `emit.ts` (which stays pure/browser-
 * safe) so the `node:fs` dependency is reachable only through the
 * `@sidestep/core/node` entry and the CLI — never from a workspace def imported
 * into a frontend bundle.
 */
import { writeFileSync } from "node:fs";
import { emit, emitBundle } from "./emit.js";
import type { FunctionDef } from "../function/define.js";
import type { Xano } from "../workspace/xano.js";

/** Compile a function and write the JSON artifact to `path`. */
export function writeArtifact(fn: FunctionDef, path: string, opts: { indent?: number } = {}): void {
  writeFileSync(path, emit(fn, opts) + "\n", "utf8");
}

/** Write the aggregate bundle to `path`. */
export function writeBundle(xano: Xano, path: string, opts: { indent?: number } = {}): void {
  writeFileSync(path, emitBundle(xano, opts) + "\n", "utf8");
}
