/**
 * `compile()` — façade over the `function` object kind (KTD-2). The envelope
 * encoding now lives in `src/kinds/function.ts`; this keeps the MVP's public
 * `compile`/`encodeResponse` surface stable.
 */
import type { FunctionXdo } from "../types/xdo.js";
import { encodeFunction, functionKind } from "../kinds/function.js";
import type { FunctionDef } from "./define.js";

// Ensure the function kind is registered when compile() is imported.
void functionKind;

/** Compile a `FunctionDef` into the flattened importable function `xdo`. */
export function compile(fn: FunctionDef): FunctionXdo {
  return encodeFunction(fn);
}

export { encodeResponse } from "../responses/response.js";
