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
 * The rendered string form (spacing/escaping) is now golden-verified: the
 * `call_agent` object-args fixture in the conformance corpus pins the exact
 * `const:expr` string this encoder emits for `obj({ question: inp(...) })`.
 *
 * **Supported members:** `inp()`, `ref()`, `auth()`, `col()`, `env()` /
 * `setting()` / `sys.*`, `c.now()`, `c.text/int/decimal/bool/null`, nested
 * `obj`-style records, and arrays of those — each optionally carrying a
 * **filter chain**, which renders as the expression language's own postfix pipe
 * (`$var.row|get:"address.city"`).
 *
 * The filter chain used to throw, and the rejection was wrong (#222). It
 * collided constantly, because `db.get` binds `null` on a miss — the SDK's own
 * headline gotcha — so almost every object built from a `db.get` result needs a
 * null-safe drill, which compiles through the `get` filter. One team counted
 * twenty pure-plumbing `s.set_var` statements written to work around it.
 *
 * The representation was never the obstacle: the engine's own parser stores
 * `{ …, goals: [$q.goal_1, …]|filter:$$ != null, … }` as ONE `const:expr2`
 * string, so a per-member chain is exactly what it carries. Nothing had to
 * change in the engine; the SDK was guessing that it could not.
 *
 * **On evidence.** The value of an `expr2` is an expression string the engine
 * parses — it is NOT XanoScript, and nothing validates its contents ahead of a
 * live run. So what backs this is the engine's own parser fixtures (paired
 * source → stored JSON), which show the exact string its tooling produces. A
 * rendering outside that set is not "probably fine"; it is unverified. Keep the
 * emitted grammar to shapes a fixture demonstrates.
 *
 * What still throws: a filter argument carrying its OWN chain (a trailing `|`
 * binds to the whole value, so it cannot be written without changing meaning),
 * a **disabled** filter (an expression string has nowhere to record that), and
 * the remaining exotic tags (`output`/`response`/`toolset`/`reg`). Build those
 * in a prior stack step and reference them with `ref`.
 */
import type { Value } from "./value.js";
import { isTaggedValue } from "./value.js";

/**
 * A member of an {@link obj} literal — a {@link Value}, a raw scalar literal
 * (`string`/`number`/`boolean`, coerced to the matching constant), a nested
 * record, or an array. Raw scalars let `obj({ max_age_days: 3 })` and
 * `obj({ greeting: "hi" })` *just work* without wrapping each in `c.int`/`c.text`.
 */
export type ObjMember = Value | string | number | boolean | ObjInput | ObjMember[];
/** The record shape {@link obj} accepts: keys → members. */
export interface ObjInput {
  [key: string]: ObjMember;
}

/** Bare-identifier keys only (what XanoScript object literals accept unquoted). */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Render one {@link Value}, including its filter chain, to a XanoScript
 * expression fragment.
 *
 * The chain renders as the expression language's own postfix pipe —
 * `$var.row|get:"address.city"` — which the object-literal grammar carries per
 * member. That is settled against the engine's parser fixtures, not inferred:
 * a stored `mvp:array_push` holds
 * `{ …, goals: [$q.goal_1, …]|filter:$$ != null, … }` as ONE `const:expr2`
 * string. See the module doc for why this stopped being a rejection.
 */
function serializeValue(v: Value, path: string): string {
  return serializeAtom(v, path) + serializeFilters(v, path);
}

/**
 * The filter chain as `|name:arg:arg`, or `""` when there is none.
 *
 * Two shapes stay rejected, because neither has an expression spelling that
 * means what the author wrote:
 *
 * - **A filter arg that carries its own chain.** `|add:$var.n|mul:2` parses as
 *   two filters on the OUTER value, not one filter on a computed argument, so
 *   emitting it would silently change the result.
 * - **A disabled filter.** `disabled` is a property of the structured
 *   `filters[]` array; an expression string has nowhere to put it, so the only
 *   faithful renderings are "drop it" (changes nothing visibly, loses the
 *   author's intent to re-enable) or "keep it" (runs a filter the author
 *   switched off). Refusing is the honest third option.
 */
function serializeFilters(v: Value, path: string): string {
  let out = "";
  for (const f of v.filters) {
    if (f.disabled) {
      throw new Error(
        `obj(): the value at \`${path}\` carries a DISABLED \`${f.name}\` filter. An object ` +
          `literal is stored as one expression string, which has no spelling for a disabled ` +
          `filter — drop it, or build the value in a prior step (e.g. \`s.set_var\`) and ` +
          `reference it with \`ref\`.`,
      );
    }
    const args = f.arg.map((a, i) => {
      if (a.filters.length > 0) {
        throw new Error(
          `obj(): the \`${f.name}\` filter at \`${path}\` has an argument (#${i}) that carries ` +
            `its own filter chain. In an expression a trailing \`|\` binds to the whole value, ` +
            `not to one argument, so this cannot be written without changing what it means. ` +
            `Compute the argument in a prior step and reference it with \`ref\`.`,
        );
      }
      return serializeAtom(a, `${path}|${f.name}[${i}]`);
    });
    out += `|${f.name}${args.length > 0 ? `:${args.join(":")}` : ""}`;
  }
  return out;
}

/** Render one {@link Value}'s BASE (tag + value), ignoring any filter chain. */
function serializeAtom(v: Value, path: string): string {
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
    // A workspace env var and a built-in request var are the SAME tag; the
    // built-ins just carry a `$`-prefixed name. Both spell `$env.` + the name,
    // so `sys.remoteIp()` renders `$env.$remote_ip` and `env("STRIPE_KEY")`
    // renders `$env.STRIPE_KEY`.
    case "setting":
      return `$env.${v.value}`;
    // The engine's native current-time constant. Only ever holds `"now"` — the
    // same narrowing the decoder makes — so anything else falls through to the
    // rejection rather than being rendered as a `now` it is not.
    case "const:epochms":
      if (v.value === "now") return "now";
      break;
  }
  throw new Error(
    `obj(): value tag "${v.tag}" at \`${path}\` isn't supported in a dynamic object literal yet. ` +
      `Supported: inp(), ref(), auth(), col(), env()/setting()/sys.*, c.now(), and ` +
      `c.text/int/decimal/bool/null — each optionally carrying a filter chain.`,
  );
}

/** Render any {@link ObjMember} (scalar literal, value, nested record, or array). */
function serializeMember(m: ObjMember, path: string): string {
  // Raw scalar literals coerce to the matching constant fragment — same rendering
  // as `c.text`/`c.int`/`c.decimal`/`c.bool` (see serializeValue's const cases).
  if (typeof m === "string") return JSON.stringify(m);
  if (typeof m === "number") return String(m);
  if (typeof m === "boolean") return m ? "true" : "false";
  if (isTaggedValue(m)) return serializeValue(m, path);
  if (Array.isArray(m)) {
    return `[${m.map((el, i) => serializeMember(el, `${path}[${i}]`)).join(", ")}]`;
  }
  if (m !== null && typeof m === "object") return serializeRecord(m, path);
  throw new Error(
    `obj(): \`${path}\` must be a Value (inp/ref/auth/col/c.*), a scalar literal ` +
      `(string/number/boolean), a nested object, or an array (got ${typeof m}).`,
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
