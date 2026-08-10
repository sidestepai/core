import { table, f, seedFile } from "../../../../src/index.js";

export const products = table({
  name: "products",
  schema: { name: f.text({ required: true }), price: f.decimal() },
  // Relative to THIS module, not the entry — the file is one directory up.
  seed: seedFile("../rows.json", import.meta.url),
});
