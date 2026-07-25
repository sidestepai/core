/**
 * Test fixture: a workspace entry whose table carries `seed` rows, used to prove
 * the deploy/compile path resolves seed content into `content/` archive entries.
 */
import { workspace, table, f } from "../../../src/index.js";

const products = table({
  name: "products",
  schema: {
    name: f.text({ required: true }),
    price: f.decimal(),
  },
  seed: [
    { name: "Widget", price: 9.99 },
    { name: "Gadget", price: 19.99 },
  ],
});

export default workspace("seed-example").registerTables([products]);
