/**
 * Test fixture for `sidestep paths`: an api group with NO in-code canonical and
 * no adjacent lock, so `paths` cannot resolve the URL token and must error.
 */
import { Xano, apiGroup, table, f, query, s, ref } from "../../../src/index.js";

const grp = apiGroup({ name: "internal" });
const links = table({ name: "links", schema: { title: f.text() } });

const list = query({
  name: "links_list",
  verb: "GET",
  apiGroup: grp,
  stack: [s.db.query({ table: links, as: "rows" })],
  response: ref("rows"),
});

export default new Xano().registerApiGroups([grp]).registerTables([links]).registerQueries([list]);
