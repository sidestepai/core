/**
 * Test fixture: a minimal xano/ workspace entry used by the CLI export test.
 * Mirrors a real project's central Xano instance with one of each registerable
 * object (function, table, trigger) plus workspace metadata.
 */
import { Xano, defineFunction, table, trigger, input, setVar, ref, c } from "../../../src/index.js";

const getUser = defineFunction({
  // Explicit guid: identity stays fixed even if we later rename `name`.
  guid: "fn_get_user",
  name: "get_user",
  input: { id: input.int({ required: true }) },
  stack: [setVar("x1", ref("id"))],
  response: ref("x1"),
});

// No explicit guid → identity derives from `name` (the common case).
// `id` + `created_at` are auto-injected system columns; declare only your own.
const users = table({
  name: "user",
  auth: true,
  schema: [{ name: "email", type: "email", required: true, methods: ["trim", "lower"] }],
  index: [{ type: "primary", fields: [{ name: "id" }] }],
});

const onInsert = trigger.table({
  name: "user_inserted",
  objId: 1,
  actions: { insert: true },
  stack: [setVar("x1", c.text("new user"))],
});

const xano = new Xano()
  .registerWorkspace({ name: "example", description: "sidestep example workspace" })
  .registerFunctions([getUser])
  .registerTables([users])
  .registerTriggers([onInsert]);

export default xano;
