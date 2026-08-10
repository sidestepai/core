/**
 * Test fixture: the `seedFile()` form — a seed named by PATH rather than by a
 * dynamic `import()`, so no bundler can follow it into a frontend build.
 *
 * The table lives in a NESTED module on purpose: `rows.json` sits beside this
 * file, not beside the workspace entry, which is what `import.meta.url` resolves
 * against.
 */
import { workspace } from "../../../src/index.js";
import { products } from "./tables/products.js";

export default workspace("seed-file-example").registerTables([products]);

