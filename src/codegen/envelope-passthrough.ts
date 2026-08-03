/**
 * A stored statement's `disabled` / `description`, recovered as factory arguments.
 *
 * Both annotate the stack item rather than argue the statement — `disabled` is the
 * engine's way of leaving a step in place while the run engine skips it, and
 * `description` is the note beside it. Every `s.*` factory now accepts them, so a
 * pulled statement carrying either is rebuilt by CALLING its factory with them:
 *
 *   s.set_var("payload", c.expression("…"), { disabled: true })
 *   s.db.add({ table: users, data: [...], description: "why" })
 *
 * They used to be overridden on the factory's result and spread over the emitted
 * call (`{...s.set_var(…), disabled: true}`). That was exact, and it round-tripped,
 * but it put an object spread in front of every reader of a generated workspace to
 * express what is now an ordinary argument.
 *
 * Which call shape absorbs them is not assumed — {@link annotationCandidates}
 * offers the object-arg form and the trailing-options form, and the caller keeps
 * whichever REPRODUCES THE STORED BYTES. A wrong guess cannot emit wrong source; it
 * fails the same comparison every other decode decision goes through.
 */
import type { StackItemXdo } from "../types/xdo.js";
import type { Statement } from "../statements/statement.js";
import { hasUnreadableInput } from "../validate/normalize.js";
import { lit, obj, type Expr } from "./print.js";

/** What a stored statement carries beyond its factory's declared arguments. */
export interface EnvelopePassthrough {
  /** `{disabled?, description?}` as a factory argument — empty when both are at their default. */
  readonly annotations: Record<string, unknown>;
  /** The same members as source entries, for whichever call shape wins. */
  readonly entries: ReadonlyArray<readonly [string, Expr]>;
  /**
   * Stored `input[]` entries for a statement whose schema declares none.
   *
   * Applied by the caller ONLY when the factory itself produced no input, so it
   * can never mask a real disagreement about entries the statement does declare.
   * `create_image` is the case that motivates it: 26 real statements store an
   * auth binding its declared context schema has no slot for, and a live round
   * trip confirms the engine persists it verbatim — so dropping it would discard
   * a stored binding, which is the one thing this decoder must never do. It has
   * no authoring surface at all, so unlike the annotations it still rides a spread.
   */
  readonly undeclaredInput: readonly unknown[] | undefined;
}

/**
 * Read the annotations off a stored statement.
 *
 * Each is included only when it departs from its envelope default (`""` for a
 * description, `false` for disabled) — at the default it is already implicit, and
 * emitting it would add noise the normalizer would then have to elide.
 */
export function envelopePassthrough(stored: StackItemXdo): EnvelopePassthrough {
  const annotations: Record<string, unknown> = {};
  const entries: Array<readonly [string, Expr]> = [];

  const description = (stored as { description?: unknown }).description;
  if (typeof description === "string" && description !== "") {
    annotations.description = description;
    entries.push(["description", lit(description)]);
  }

  const disabled = (stored as { disabled?: unknown }).disabled;
  if (disabled === true) {
    annotations.disabled = true;
    entries.push(["disabled", lit(true)]);
  }

  // An `input[]` the engine cannot reach is dropped rather than carried: the
  // normalizer elides it on both sides of the round trip, so spreading it here
  // would put an envelope literal in the generated source to preserve bytes the
  // comparison no longer looks at. Keyed on the normalizer's own list.
  const input = (stored as { input?: unknown }).input;
  const undeclaredInput =
    Array.isArray(input) && input.length > 0 && !hasUnreadableInput(stored.name)
      ? input
      : undefined;

  return { annotations, entries, undeclaredInput };
}

/** One way of passing the annotations: the arguments to call, and the source to emit. */
export interface AnnotationCandidate {
  readonly runtime: readonly unknown[];
  readonly source: readonly Expr[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The call shapes that could carry `annotations`, most idiomatic first.
 *
 * An object-arg factory takes them as two more members of the object it already
 * receives; a positional one takes a trailing options object. Both are offered
 * whenever the shapes allow, because the discriminator is not knowable from here:
 * a positional factory's last argument is often a plain object too (a `Value` is
 * one), so "the last argument is an object" does not mean "merge into it". The
 * byte comparison decides.
 */
export function annotationCandidates(
  runtime: readonly unknown[],
  sourceArgs: readonly Expr[],
  annotations: Record<string, unknown>,
  entries: ReadonlyArray<readonly [string, Expr]>,
): AnnotationCandidate[] {
  if (entries.length === 0) return [{ runtime, source: sourceArgs }];
  const out: AnnotationCandidate[] = [];

  const lastRuntime = runtime[runtime.length - 1];
  const lastSource = sourceArgs[sourceArgs.length - 1];
  if (
    runtime.length === sourceArgs.length &&
    isPlainObject(lastRuntime) &&
    lastSource?.kind === "object"
  ) {
    // A decoder that already emitted one of these (a `description` a special
    // reads off the same stored key) would otherwise print it twice — legal
    // JavaScript, invisible to the round trip, since the runtime merge below
    // collapses the duplicate. Drop the earlier cell, matching that precedence.
    const annotated = new Set(entries.map(([field]) => field));
    out.push({
      runtime: [...runtime.slice(0, -1), { ...lastRuntime, ...annotations }],
      source: [
        ...sourceArgs.slice(0, -1),
        obj([...lastSource.entries.filter(([field]) => !annotated.has(field)), ...entries]),
      ],
    });
  }

  out.push({ runtime: [...runtime, annotations], source: [...sourceArgs, obj(entries)] });
  return out;
}

/**
 * Add the stored `input[]` to a built statement, but only when the factory
 * produced none of its own.
 *
 * Returns the statement to encode plus the source entries that still have to be
 * spread — today only `input`, which no factory accepts.
 */
export function applyUndeclaredInput(
  built: Statement,
  passthrough: EnvelopePassthrough,
): { statement: Statement; entries: ReadonlyArray<readonly [string, Expr]> } {
  const ownInput = (built as { input?: unknown }).input;
  if (passthrough.undeclaredInput && !(Array.isArray(ownInput) && ownInput.length > 0)) {
    const statement = { ...built, input: [...passthrough.undeclaredInput] };
    return { statement, entries: [["input", lit(passthrough.undeclaredInput)] as const] };
  }
  return { statement: built, entries: [] };
}
