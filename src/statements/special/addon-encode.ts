/**
 * Addon-authoring encoder — the one place that turns an authored {@link AddonSpec}
 * into the stored `addon[]` block a db statement carries (the shape the engine's
 * `Migrate::exportAddonImpls` / `importAddonImpls` walk).
 *
 * Xano addons graft related-table data onto the rows a `db.query`/`db.get` (and
 * the other row-returning db ops) return. Each attached addon references a
 * reusable addon object, maps some of its inputs, optionally restricts its
 * output columns, and lands its result on the row under a dotted destination
 * (`offset` + `as`). Addons nest recursively.
 *
 * The authoring surface mirrors XanoScript's `addon = [{ name, as, input, output,
 * addon }]`, with two deliberate divergences:
 *
 * - the reference field is named `addon` (an {@link ObjectRef}), so the nesting
 *   field is named `children` to avoid the collision — which also matches the
 *   stored/export key (KTD-3);
 * - the target is a guid-native `ObjectRef`, resolved to a guid and emitted under
 *   the stored `id` key. In a packageExport bundle the engine matches addons by
 *   guid (`importAddonId` → `guidMatch`), so emitting the guid as `id` is correct
 *   — the same precedent `s.addon.call` uses (KTD-1).
 */
import type { Value } from "../../values/value.js";
import { resolveRef } from "../../refs/guid.js";
import type { ObjectRef } from "../../refs/guid.js";
import { leanInput } from "../lean-input.js";
import type { LeanInput } from "../lean-input.js";

/**
 * One addon attached to a db statement.
 *
 * `as` is the dotted destination on the row (e.g. `"items._book"`); it splits at
 * the last dot into the stored `offset` (path prefix) + `as` (final segment).
 * `input` maps addon input names to values — bind parent-row columns with
 * {@link out} (`{ user_id: out("id") }`). `output` restricts the addon's returned
 * columns. `children` nests further addons (recursive).
 */
export interface AddonSpec {
  /** The target addon (def handle or bare name), resolved to a guid. */
  addon: ObjectRef;
  /** Dotted destination on the row, e.g. `"items._book"` (offset + alias). */
  as: string;
  /** Addon input bindings, name → value (use {@link out} for parent-row columns). */
  input?: Record<string, Value>;
  /** Restrict the addon's returned columns. */
  output?: readonly string[];
  /** Nested addons (recursive). */
  children?: AddonSpec[];
}

/** The stored/export form of one attached addon. */
interface StoredAddon {
  id: string;
  as: string;
  offset?: string;
  input: LeanInput[];
  output?: { customize: true; items: { name: string; children: [] }[] };
  children?: StoredAddon[];
}

/** Map an addon `input` object into the lean `{name,tag,value,filters}[]` form. */
function encodeInput(input?: Record<string, Value>): LeanInput[] {
  if (!input) return [];
  return Object.entries(input).map(([name, v]) => leanInput(name, v));
}

/**
 * Map an addon `output` column list into the customized-output block. Note this
 * omits the `filters:[]` key the parent statement's column-restriction envelope
 * carries — the engine's stored addon output has no `filters` (KTD-5, O1).
 */
function encodeOutput(
  cols?: readonly string[],
): StoredAddon["output"] {
  if (!cols?.length) return undefined;
  return { customize: true, items: cols.map((name) => ({ name, children: [] as [] })) };
}

/**
 * Split a dotted `as` at the last dot → `{ offset, as }` (offset omitted with no
 * dot). Rejects degenerate destinations — an empty string, a leading dot
 * (`.book`, empty offset), or a trailing dot (`book.`, empty alias) — since the
 * engine accepts them into the bundle but cannot graft the addon onto the row.
 */
function splitAs(as: string): { offset?: string; as: string } {
  if (!as) {
    throw new Error('addon: `as` must be a non-empty destination, e.g. "items._book" or "_book".');
  }
  const dot = as.lastIndexOf(".");
  if (dot === -1) return { as };
  const offset = as.slice(0, dot);
  const alias = as.slice(dot + 1);
  if (!offset || !alias) {
    throw new Error(
      `addon: \`as\` "${as}" has an empty offset or alias segment — use "offset.alias" (e.g. "items._book") or a bare alias ("_book").`,
    );
  }
  return { offset, as: alias };
}

/**
 * Encode one addon spec into its stored form (recursing into `children`). `path`
 * carries the spec objects on the current branch so a spec that (transitively)
 * lists itself under `children` throws a clear error instead of recursing until
 * the stack overflows — near-impossible in normal authoring, but cheap to reject.
 */
function encodeOne(spec: AddonSpec, path: readonly AddonSpec[]): StoredAddon {
  if (path.includes(spec)) {
    throw new Error("addon: `children` cannot reference an ancestor addon spec (cycle detected).");
  }
  const { offset, as } = splitAs(spec.as);
  const stored: StoredAddon = {
    id: resolveRef("addon", spec.addon),
    as,
    input: encodeInput(spec.input),
  };
  if (offset !== undefined) stored.offset = offset;
  const output = encodeOutput(spec.output);
  if (output !== undefined) stored.output = output;
  if (spec.children?.length) {
    const nextPath = [...path, spec];
    stored.children = spec.children.map((child) => encodeOne(child, nextPath));
  }
  return stored;
}

/**
 * Encode an authored addon list into the stored `addon[]` block. Returns `[]`
 * for an omitted/empty list, so callers pass it straight through to the
 * statement envelope (preserving the empty-`addon:[]` default byte-for-byte).
 */
export function encodeAddons(specs?: readonly AddonSpec[]): StoredAddon[] {
  if (!specs?.length) return [];
  return specs.map((spec) => encodeOne(spec, []));
}
