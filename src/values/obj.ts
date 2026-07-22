/**
 * `obj({...})` — a **dynamic** object value: an object literal whose members can
 * be live references (`inp`/`ref`/`auth`/`col`) or constants. This is the
 * missing sibling of `c.obj` (issue #42): `c.obj` takes plain JSON only and
 * rejects nested tagged values, so it can't express `{ id: inp("id") }`.
 *
 * Xano stores a dynamic object as a single value with `tag: "const:expr2"` whose
 * `value` is the object rendered as a **XanoScript expression string** (verified
 * against the Xano engine's stored inline-value format). So `obj`
 * serializes each member to its XanoScript form (`$input.x`, `$var.x`, `$auth`,
 * `$db.col`, quoted strings, numbers) and wraps them in `{ … }`.
 *
 * Why `const:expr2` and not a structured `const:obj`: the Xano runtime value
 * evaluator resolves `const:obj` by JSON-decoding its value — it
 * treats the value as a *static JSON string*, so dynamic members (`$input.x`)
 * would never resolve. Only `const:expr2` is run through the expression parser
 * (it normalizes to `const:expr` and evaluates), so it is the sole
 * representation that resolves live references inside an object literal. That
 * choice is therefore runtime-verified, not a preference.
 *
 * @TODO(byte-verify): the *encoding* is confirmed against the runtime evaluator;
 * what remains unproven by a golden deep-equal is the exact rendered string for
 * a given input (spacing/escaping) — no `call_agent` object-args fixture exists.
 * Lock the string form once one is available.
 *
 * **Supported members:** `inp()`, `ref()`, `auth()`, `col()`, `c.text/int/
 * decimal/bool/null`, nested `obj`-style records, and arrays of those. A value
 * carrying a **filter chain** (`withFilters`), or a less-common tag
 * (`env`/`setting`/`output`/`response`/`toolset`/`reg`), throws — its
 * XanoScript rendering is ambiguous enough that guessing risks a bad export;
 * build such a value in a prior stack step instead.
 */
import type { Value } from "./value.js";
import { isTaggedValue } from "./value.js";

/** A member of an {@link obj} literal — a {@link Value}, a nested record, or an array. */
export type ObjMember = Value | ObjInput | ObjMember[];
/** The record shape {@link obj} accepts: keys → members. */
export interface ObjInput {
  [key: string]: ObjMember;
}

/** Bare-identifier keys only (what XanoScript object literals accept unquoted). */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Render one {@link Value} to its XanoScript expression fragment. */
function serializeValue(v: Value, path: string): string {
  if (v.filters.length > 0) {
    throw new Error(
      `obj(): the value at \`${path}\` carries a filter chain, which can't be serialized into an ` +
        `object literal yet. Compute it in a prior step (e.g. \`setVar\`) and reference it with \`ref\`.`,
    );
  }
  switch (v.tag) {
    case "const":
      return JSON.stringify(v.value); // double-quoted + escaped, valid XanoScript string
    case "const:int":
    case "const:decimal":
      return v.value; // already the numeric literal (e.g. "123", "1.5")
    case "const:bool":
      return v.value === "true" ? "true" : "false";
    case "const:null":
      return "null";
    case "input":
      return `$input.${v.value}`;
    case "var":
      return `$var.${v.value}`;
    case "auth":
      return v.value ? `$auth.${v.value}` : "$auth";
    case "col":
      return `$db.${v.value}`;
    default:
      throw new Error(
        `obj(): value tag "${v.tag}" at \`${path}\` isn't supported in a dynamic object literal yet. ` +
          `Supported: inp(), ref(), auth(), col(), and c.text/int/decimal/bool/null.`,
      );
  }
}

/** Render any {@link ObjMember} (value, nested record, or array). */
function serializeMember(m: ObjMember, path: string): string {
  if (isTaggedValue(m)) return serializeValue(m, path);
  if (Array.isArray(m)) {
    return `[${m.map((el, i) => serializeMember(el, `${path}[${i}]`)).join(", ")}]`;
  }
  if (m !== null && typeof m === "object") return serializeRecord(m, path);
  throw new Error(
    `obj(): \`${path}\` must be a Value (inp/ref/auth/col/c.*), a nested object, or an array (got ${typeof m}).`,
  );
}

/** Render a record to a `{ k: v, … }` XanoScript object literal. */
function serializeRecord(rec: ObjInput, path: string): string {
  const parts = Object.entries(rec).map(([key, member]) => {
    if (!IDENT.test(key)) {
      throw new Error(
        `obj(): key "${key}"${path ? ` at \`${path}\`` : ""} must be a bare identifier ` +
          `([A-Za-z_][A-Za-z0-9_]*) — XanoScript object keys aren't quoted.`,
      );
    }
    return `${key}: ${serializeMember(member, path ? `${path}.${key}` : key)}`;
  });
  return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
}

/**
 * Build a dynamic object {@link Value} from a record of members. Members may be
 * references (`inp`/`ref`/`auth`/`col`), constants (`c.*`), nested records, or
 * arrays. Emits `tag:"const:expr2"` — the engine's dynamic-object representation.
 *
 * ```ts
 * obj({ id: inp("id"), name: c.text("Bob"), tags: [c.text("a"), ref("t")] })
 * // → { value: '{ id: $input.id, name: "Bob", tags: ["a", $var.t] }', tag: "const:expr2", filters: [] }
 * ```
 */
export function obj(fields: ObjInput): Value {
  return { value: serializeRecord(fields, ""), tag: "const:expr2", filters: [] };
}
