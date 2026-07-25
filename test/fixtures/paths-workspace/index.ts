/**
 * Test fixture for `sidestep paths`: an api group with an in-code canonical (so
 * paths resolve with no lock) and two queries with distinct verbs.
 */
import { Xano, apiGroup, table, f, query, s, ref } from "../../../src/index.js";

const pub = apiGroup({ name: "public", canonical: "abc12345" });
const links = table({ name: "links", schema: { title: f.text() } });

const list = query({
  name: "links.list",
  verb: "GET",
  apiGroup: pub,
  stack: [s.db.query({ table: links, as: "rows" })],
  response: ref("rows"),
});

// Leading slash on the name is stripped in the emitted path (matches getPath()).
const create = query({
  name: "/links.create",
  verb: "POST",
  apiGroup: pub,
  stack: [s.db.add({ table: links, row: { title: ref("title") }, as: "r" })],
  response: ref("r"),
});

export default new Xano()
  .registerApiGroups([pub])
  .registerTables([links])
  .registerQueries([list, create]);
