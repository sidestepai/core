/**
 * `@sidestep/core/codegen` — the surface generated code imports.
 *
 * Kept separate from `@sidestep/core` on purpose: `raw()` is a verbatim
 * passthrough that bypasses the typed statement catalog, so it must not appear
 * under `s.` where tab-completion would present it as a peer of real statements.
 * A generated file declares its own provenance by importing from this specifier.
 *
 * Browser-safe and tiny (a statement factory only) — the decode *tooling* that
 * produces those files is Node-only and lives on `@sidestep/core/node`.
 */
export { raw } from "./statements/special/raw.js";
export type { RawEnvelope } from "./statements/special/raw.js";
export { rawValue } from "./values/raw-value.js";
export type { RawValueInput } from "./values/raw-value.js";
export { rawField } from "./fields/raw-field.js";
export type { RawFieldEnvelope } from "./fields/raw-field.js";
export { rawResponse } from "./responses/raw-response.js";
export type { RawResponseEnvelope } from "./responses/raw-response.js";
