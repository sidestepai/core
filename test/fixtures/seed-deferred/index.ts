/**
 * Fixture for #209 part 2: a DEFERRED seed whose rows are invalid.
 *
 * `export` used never to call the seed source, so a defect like this surfaced
 * only at `deploy` — after an environment had been provisioned. Both commands
 * now resolve through the same function, so both reject it.
 */
import { Xano, table, f, seedFile } from "../../../src/index.js";

const rows = table({
  name: "probe_seed",
  schema: {
    name: f.enum(["a", "b"], { required: true }),
    count: f.int({ required: true }),
  },
  // rows.json carries "c", which is not a declared member.
  seed: seedFile("./rows.json", import.meta.url),
});

export default new Xano().registerWorkspace({ name: "seed_deferred" }).registerTables([rows]);
