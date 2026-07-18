/**
 * Emit artifacts as strings: a single compiled function (U8) or the aggregate
 * workspace bundle from a `Xano` registry (U12). These are pure and browser-safe
 * — the `node:fs` writers live in `./write.js` so importing a def graph never
 * pulls in `fs`.
 */
import { compile } from "../function/compile.js";
import type { FunctionDef } from "../function/define.js";
import type { Xano } from "../workspace/xano.js";
import type { Bundle } from "../workspace/export.js";

/** Compile a function and return its pretty-printed JSON string. */
export function emit(fn: FunctionDef, opts: { indent?: number } = {}): string {
  return JSON.stringify(compile(fn), null, opts.indent ?? 2);
}

/** Pretty-print an already-built bundle (the CLI's lock path builds it itself). */
export function serializeBundle(bundle: Bundle, opts: { indent?: number } = {}): string {
  return JSON.stringify(bundle, null, opts.indent ?? 2);
}

/** Pretty-print the aggregate `packageExport` bundle from a `Xano` registry. */
export function emitBundle(xano: Xano, opts: { indent?: number } = {}): string {
  return serializeBundle(xano.export(), opts);
}
