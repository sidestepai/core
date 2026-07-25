/**
 * Minimal deployable workspace used only by the ephemeral-CLI end-to-end script
 * (scripts/e2e-ephemeral.sh). Kept tiny on purpose: one table + one API query so
 * the import is trivially valid and can't fail for corpus-specific reasons. Not
 * part of the example set and not imported by index.ts.
 */
import { workspace, apiGroup, table, f, query, s, c, ref, input, inp } from "@sidestep/core";

const api = apiGroup({ name: "e2e", canonical: "e2e" });

const widgets = table({
  name: "widgets",
  schema: {
    label: f.text({ required: true }),
    qty: f.int({ default: "0" }),
  },
});

const ping = query({
  name: "ping",
  verb: "GET",
  apiGroup: api,
  input: { n: input.int({ required: true }) },
  stack: [
    s.set_var("doubled", inp("n")),
    s.math.mul({ name: "doubled", value: c.int(2) }),
  ],
  response: ref("doubled"),
});

const defs = (xs: unknown[]) => xs as never[];

export default workspace("sidestep-e2e")
  .registerApiGroups(defs([api]))
  .registerTables(defs([widgets]))
  .registerQueries(defs([ping]));
