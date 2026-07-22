/**
 * `trigger.{table,realtime,mcpServer,agent,workspace,error}(...)` — the six
 * trigger types (payload key `trigger`). A trigger's `stack` is a CALLBACK
 * `(t) => [...]`; inputs are implied by type and exposed on `t`.
 *
 * PARAM GATE: the trigger type (`obj_type`).
 */
import { trigger, s, c } from "@sidestep/core";
import { users } from "../_shared.js";

/** Gate 1 — database table trigger. `t.new`/`t.old` are typed to the row. */
export const onUserInsert = trigger.table({
  name: "ex_kind_trigger_on_user_insert",
  table: users,
  actions: { insert: true },
  stack: (t) => [s.debug.log({ value: t.new("email") })],
});

/** Gate 2 — realtime channel trigger (response-bearing; defaults to echoing the payload). */
export const onMessage = trigger.realtime({
  name: "ex_kind_trigger_on_message",
  actions: { message: true },
  response: (t) => t.payload,
});

/** Gate 3 — workspace lifecycle trigger. */
export const onBranchLive = trigger.workspace({
  name: "ex_kind_trigger_on_branch_live",
  actions: { branch_live: true },
  stack: () => [s.debug.log({ value: c.text("branch went live") })],
});
