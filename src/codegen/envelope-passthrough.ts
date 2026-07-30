/**
 * Envelope members no statement factory takes, carried through both proof arms.
 *
 * A statement's envelope holds two members that are authored in the editor but
 * are not arguments to any `s.*` factory: its `description`, and its `disabled`
 * flag — the engine's way of leaving a step in the stack while the run engine
 * skips it, i.e. commenting it out. Both are part of `Statement`, and
 * `encodeStatement` writes both, so neither is a modelling gap. But a decoder
 * that rebuilds a statement purely by calling its factory cannot reproduce
 * either, and the proof it must pass is byte equality — so every annotated or
 * disabled statement in a pulled workspace degraded to `raw()`.
 *
 * Overriding them on the factory's result is exact, and the source spreads the
 * same override so the generated file re-encodes identically. The comparison in
 * each arm still has to agree, so getting this wrong costs readability rather
 * than fidelity.
 *
 * Both arms share this module rather than each special-casing the members, so a
 * third envelope member of the same kind is added once.
 */
import type { StackItemXdo } from "../types/xdo.js";
import type { Statement } from "../statements/statement.js";
import { lit, type Expr } from "./print.js";

/** What a stored statement carries that no factory accepts. */
export interface EnvelopePassthrough {
  /** Members to override on the built statement before encoding. Empty when none apply. */
  readonly overrides: Partial<Statement>;
  /** The same members as source entries, to spread over the emitted call. */
  readonly entries: ReadonlyArray<readonly [string, Expr]>;
}

/**
 * Read the passthrough members off a stored statement.
 *
 * Each is included only when it departs from its envelope default (`""` for a
 * description, `false` for disabled) — at the default it is already implicit, and
 * emitting it would add noise the normalizer would then have to elide.
 */
export function envelopePassthrough(stored: StackItemXdo): EnvelopePassthrough {
  const overrides: Partial<Statement> = {};
  const entries: Array<readonly [string, Expr]> = [];

  const description = (stored as { description?: unknown }).description;
  if (typeof description === "string" && description !== "") {
    overrides.description = description;
    entries.push(["description", lit(description)]);
  }

  const disabled = (stored as { disabled?: unknown }).disabled;
  if (disabled === true) {
    overrides.disabled = true;
    entries.push(["disabled", lit(true)]);
  }

  return { overrides, entries };
}
