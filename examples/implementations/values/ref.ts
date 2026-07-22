/**
 * `ref(name, opts?)` — reference a stack variable (the `as:` output of an
 * earlier statement). `ref` ≠ `f.tableRef` (a foreign key).
 *
 * PARAM GATE: `{ safe: true }` makes a *dotted* path null-safe — it compiles
 * through the `get` filter so `owner.user_id` resolves to null instead of 500ing
 * when `owner` is null (issue #47). No effect on a bare, dot-free name.
 */
import { defineFunction, s, c, ref } from "@sidestep/core";
import { posts } from "../_shared.js";

/** Gate 1 — a plain reference to a stack variable. */
export const refPlain = defineFunction({
  name: "ex_ref_plain",
  stack: [s.set_var("greeting", c.text("hello"))],
  response: ref("greeting"),
});

/** Gate 2 — null-safe nested access on a row that may not exist. */
export const refSafe = defineFunction({
  name: "ex_ref_safe",
  stack: [s.db.get({ table: posts, fieldValue: c.int(1), as: "owner" })],
  // `owner` may be null (no matching row) — `{ safe: true }` yields null, not a 500.
  response: ref("owner.author_id", { safe: true }),
});
