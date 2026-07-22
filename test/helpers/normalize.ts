/**
 * The golden-fixture normalizer now lives in `src/validate/normalize.ts` so the
 * shipped `sidestep validate` command (built from `src/`) and the test corpus
 * share one source of truth — shipped code cannot import from `test/`. This
 * re-export keeps every existing `test/.../normalize.js` importer working
 * unchanged. See `src/validate/normalize.ts` for the strip-rule documentation.
 */
export { normalize } from "../../src/validate/normalize.js";
