/**
 * Shared typed-field plumbing for the hand-authored HTTP-request family
 * (`api.request`, `stream.from_request`, `webflow.request`, `microservice`).
 * Each of these has a generated bare-`Value` factory; the wrappers add ergonomic,
 * literal-friendly field types (each still accepting a dynamic {@link Value}) and
 * delegate encoding to the generated factory for byte-parity.
 *
 * Hoisted here per the rule of three once the second wrapper landed.
 */
import type { Value } from "../../values/value.js";
import { c, filter, withFilters, isTaggedValue } from "../../values/value.js";

/**
 * The HTTP verbs the engine's runtime input schema accepts. Enforced: the
 * wrapper coerces to a `Value` and delegates to the generated factory, whose
 * spec now carries the same set and rejects a constant outside it.
 */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "HEAD" | "OPTIONS" | "PATCH";

/**
 * A tagged {@link Value} — the dynamic-binding escape hatch for any typed field.
 * Accepts a *callable* Value too: a trigger field accessor (`t.new`) is a
 * function carrying the `{value,tag,filters}` props, so `typeof` is "function"
 * (issue #78).
 */
export function isValue(w: unknown): w is Value {
  return (
    (typeof w === "object" || typeof w === "function") &&
    w !== null &&
    !Array.isArray(w) &&
    "tag" in w &&
    "value" in w
  );
}

/**
 * Flatten a {@link Value} to a plain `{value,tag,filters}` object. A trigger
 * field accessor (`t.new`) is a *callable* Value — a function object — and the
 * workspace encoder (`phpJsonEncode`) serializes a function to `null`, silently
 * dropping the field. Passing the accessor through a coercer normalizes it to a
 * plain object so it survives export (issue #78). A plain Value is returned
 * unchanged (byte-identical shape).
 */
const plain = (v: Value): Value => {
  // `v` is typed `Value` (not callable), but an accessor is a function at
  // runtime; read the props off it through an untyped view.
  if (typeof v !== "function") return v;
  const { value, tag, filters } = v as unknown as Value;
  return { value, tag, filters };
};

export const coerceText = (v: string | Value | undefined): Value | undefined =>
  v === undefined ? undefined : isValue(v) ? plain(v) : c.text(v);
export const coerceInt = (v: number | Value | undefined): Value | undefined =>
  v === undefined ? undefined : isValue(v) ? plain(v) : c.int(v);
export const coerceBool = (v: boolean | Value | undefined): Value | undefined =>
  v === undefined ? undefined : isValue(v) ? plain(v) : c.bool(v);
/**
 * Coerce an object field (`params`, …) to its `Value` form.
 *
 * - `undefined` → dropped downstream.
 * - a tagged {@link Value} → passed through (the dynamic escape hatch), flattened
 *   to a plain object if it is a callable accessor like `t.new` (issue #78).
 * - an array → a `c.obj` constant, as before (a pure-JSON array stays `[…]`; an
 *   array holding a tagged value still throws #42). An object-of-values is a
 *   record, never a list, so arrays never take the `set`-filter path.
 * - a plain **pure-JSON** record → a `c.obj` constant (`tag:"const:obj"`), as before.
 * - a plain record that **contains tagged values** at the top level → a real
 *   object-of-values: a `c.obj` base seeded from the literal-valued keys, plus one
 *   `set` filter per Value-valued key. This makes `params: { count: ref("count") }`
 *   *just work*, mirroring the record-of-values `response: { key: value }` accepts
 *   (issues #74/#75) — instead of routing into `c.obj`, which refuses to embed a
 *   tagged value (issue #42).
 *
 * Only **top-level** Value keys are lifted. A value nested *inside* a sub-object
 * or array lands in the `c.obj` base and still trips the #42 guard — a loud
 * failure, not a silent drop (the documented flat-only boundary).
 */
export const coerceObj = (v: object | Value | undefined): Value | undefined => {
  if (v === undefined) return undefined;
  // Strict tagged-value check (a real `Tag` + `filters[]`), NOT the loose local
  // `isValue`: a params record like `{ tag: "sale", value: "50" }` structurally
  // matches the loose shape and would be passed through as a bogus node. The
  // strict check — the same one `c.obj`'s #42 guard rejects on — only matches an
  // actual Value, so such a record correctly falls through to the record path.
  if (isTaggedValue(v)) return plain(v);
  // Arrays keep their pre-change behavior: a pure array serializes as an array
  // constant, an array holding a Value throws #42. They never become an
  // object-of-values (that shape is a record, not a list).
  if (Array.isArray(v)) return c.obj(v as unknown as Record<string, unknown>);
  const literals: Record<string, unknown> = {};
  const valueEntries: [string, Value][] = [];
  for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
    if (isTaggedValue(val)) valueEntries.push([key, val]);
    else literals[key] = val;
  }
  // `c.obj` still enforces #42 on the literal subset — a value nested inside a
  // sub-object stays here and throws (the flat-only boundary). With no top-level
  // Value keys this is byte-identical to the old plain-JSON constant path.
  const base = c.obj(literals);
  if (valueEntries.length === 0) return base;
  return withFilters(
    base,
    ...valueEntries.map(([key, val]) => {
      // The engine `set` filter reads `.`/`[` in the path as a nested-path DSL
      // (`"a.b"` → `{a:{b:…}}`), so a dotted key carrying a Value would encode
      // differently than the same key with a literal value (which `c.obj` keeps
      // flat). Fail loud on that ambiguity rather than silently diverging.
      if (/[.[]/.test(key))
        throw new Error(
          `coerceObj: object key ${JSON.stringify(key)} carries a tagged value but contains "." or "[", ` +
            `which the engine's set filter reads as a nested path ("a.b" → {a:{b:…}}) — the same key with a ` +
            `plain value would stay flat. Use a nested object, or a key without "." / "[".`,
        );
      return filter("set", c.text(key), val);
    }),
  );
};
export const coerceArray = (v: readonly string[] | Value | undefined): Value | undefined =>
  v === undefined ? undefined : isValue(v) ? plain(v) : c.array(v as string[]);

/**
 * A value acceptable in a call/agent `input` map — a raw scalar literal, a nested
 * object/array, or a tagged {@link Value}. Widening the maps to this lets
 * `input: { max_age_days: 3 }` compile without wrapping every literal in `c.int`.
 */
export type InputValue = string | number | boolean | object | Value;

/**
 * Coerce one {@link InputValue} to a {@link Value} for a call/agent input map.
 * - a tagged {@link Value} → passed through (flattened if a callable accessor).
 * - `number` → `c.int` when integral, else `c.decimal` (the unambiguous split;
 *   ambiguous nested cases fail loud inside {@link coerceObj}).
 * - `string` → `c.text`; `boolean` → `c.bool`.
 * - an object/array → {@link coerceObj} (record-of-values or JSON constant).
 */
export const coerceScalar = (v: InputValue): Value => {
  if (isValue(v)) return plain(v);
  if (typeof v === "number") return (Number.isInteger(v) ? c.int(v) : c.decimal(v)) as Value;
  if (typeof v === "string") return c.text(v);
  if (typeof v === "boolean") return c.bool(v);
  return coerceObj(v) as Value;
};

/** The shared TLS/HTTP fields carried by `api.request` / `stream.from_request` / `webflow.request`. */
export interface HttpRequestFields {
  method?: HttpMethod | (string & {}) | Value;
  params?: object | Value;
  headers?: readonly string[] | Value;
  timeout?: number | Value;
  follow_location?: boolean | Value;
  verify_host?: boolean | Value;
  verify_peer?: boolean | Value;
  ca_certificate?: string | Value;
  certificate?: string | Value;
  certificate_pass?: string | Value;
  private_key?: string | Value;
  private_key_pass?: string | Value;
}

/** Coerce the shared HTTP fields to their `Value` forms (undefined fields dropped downstream). */
export function coerceHttpFields(a: HttpRequestFields): Record<string, Value | undefined> {
  return {
    method: coerceText(a.method),
    params: coerceObj(a.params),
    headers: coerceArray(a.headers),
    timeout: coerceInt(a.timeout),
    follow_location: coerceBool(a.follow_location),
    verify_host: coerceBool(a.verify_host),
    verify_peer: coerceBool(a.verify_peer),
    ca_certificate: coerceText(a.ca_certificate),
    certificate: coerceText(a.certificate),
    certificate_pass: coerceText(a.certificate_pass),
    private_key: coerceText(a.private_key),
    private_key_pass: coerceText(a.private_key_pass),
  };
}

/** A field's statically-known emptiness: `"unknown"` for a dynamic `Value` we can't resolve. */
function textState(v: string | Value | undefined): "empty" | "nonempty" | "unknown" {
  if (v === undefined) return "empty"; // absent → engine's empty default
  if (typeof v === "string") return v === "" ? "empty" : "nonempty";
  if (isValue(v) && v.tag === "const") return v.value === "" ? "empty" : "nonempty";
  return "unknown"; // inp/ref/filtered — indeterminate at build time
}

function boolState(v: boolean | Value | undefined, engineDefault: boolean): "true" | "false" | "unknown" {
  if (v === undefined) return engineDefault ? "true" : "false";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (isValue(v) && v.tag === "const:bool") return v.value === "true" ? "true" : "false";
  return "unknown";
}

/**
 * Enforce the engine's TLS/mTLS field interdependencies (as enforced by the
 * Xano engine's API-request handler) at build time — but ONLY when the combination is *statically
 * provable* invalid. A dynamic `Value` in any relevant field yields `"unknown"`
 * and is skipped, so this never rejects a workspace the engine would accept: it
 * is a strict superset of the engine's runtime checks, surfacing the same errors
 * earlier. The frontend does not block on these; the engine throws at runtime.
 */
export function assertSslConsistency(label: string, a: HttpRequestFields): void {
  const cert = textState(a.certificate);
  const key = textState(a.private_key);
  if (cert === "nonempty" && key === "empty")
    throw new Error(`${label}: \`certificate\` requires \`private_key\` — a client certificate needs its matching key.`);
  if (key === "nonempty" && cert === "empty")
    throw new Error(`${label}: \`private_key\` requires \`certificate\` — a client key needs its matching certificate.`);

  const ca = textState(a.ca_certificate);
  const verifyPeer = boolState(a.verify_peer, true);
  if (ca === "nonempty" && verifyPeer === "false")
    throw new Error(`${label}: \`ca_certificate\` requires \`verify_peer: true\` — the engine only consults a CA cert when peer verification is on.`);
}
