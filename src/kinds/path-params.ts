/**
 * Shared `{param}` path handling for the two kinds whose `name` IS a path: an
 * API `query` (`"blog/{slug}"`) and a `realtimeChannel` (`"rooms/{room_id}"`).
 *
 * A path param is two declarations that must agree — the `{param}` marker in the
 * name, and an input of the same name that the engine binds the URL segment to.
 * Nothing in the persisted object links them, so an orphan marker deploys as a
 * permanently-broken route. These helpers make the pair a checked contract and
 * give both kinds one interpolation routine, so their rules cannot drift.
 *
 * Grammar (no wildcards, no special characters):
 *   path    := segment ("/" segment)*
 *   segment := literal | "{" identifier "}"    — a param is a WHOLE segment
 *   ident   := [A-Za-z_][A-Za-z0-9_]*          — unique within one path
 */
import type { InputDescriptor } from "../inputs/input.js";

/** A `{param}` segment: the whole segment, naming a plain identifier. */
const PARAM_SEGMENT = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Stored field types a URL/channel segment cannot carry. A segment is one
 * string, so anything structured (`obj`, `json`, a list), binary (`blob*`), or
 * multi-valued (`geo_*`, `vector`) is rejected.
 *
 * Deliberately a DENY-list: a scalar type added to the field catalog later keeps
 * working, and only the structurally impossible is refused. Note a `tableRef`
 * input is absent — it stores as an `int`/`uuid` scalar, so `"posts/{author_id}"`
 * against a table reference is a legitimate route.
 */
const NON_SEGMENT_TYPES = new Set(["obj", "json", "blob", "blob_img", "blob_video", "blob_audio", "vector"]);

/** Whether a stored field type can occupy one path segment. */
function isSegmentType(type: string): boolean {
  return !NON_SEGMENT_TYPES.has(type) && !type.startsWith("geo_");
}

/**
 * The `{param}` names in a path, in order (`[]` for a static path). Throws on a
 * malformed marker rather than silently treating it as a literal segment — a
 * route that looks parameterized but isn't is the failure this whole module
 * exists to prevent.
 */
export function parsePathParams(context: string, path: string): string[] {
  const params: string[] = [];
  for (const segment of path.replace(/^\/+/, "").split("/")) {
    if (!segment.includes("{") && !segment.includes("}")) continue;
    const match = PARAM_SEGMENT.exec(segment);
    if (!match) {
      throw new Error(
        `${context}: "${segment}" is not a valid path param. A {param} must be a whole path segment ` +
          `naming a plain identifier — "blog/{slug}", not "blog/post-{slug}". There are no wildcards ` +
          `or patterns; chain segments instead ("blog/{slug}/review/{review_id}").`,
      );
    }
    const name = match[1]!;
    if (params.includes(name)) {
      throw new Error(
        `${context}: the path param \`${name}\` appears twice. Each {param} must be unique within one path — ` +
          `two segments cannot bind the same input.`,
      );
    }
    params.push(name);
  }
  return params;
}

/**
 * Enforce the path↔input contract: every `{param}` has an input of that name,
 * and that input's type fits in one path segment.
 *
 * This is SideStep's opinion, not an engine rule. Xano treats a `{param}` as a
 * plain route string and will happily serve an endpoint whose marker binds to
 * nothing — which is precisely the silent breakage worth refusing at authoring
 * time. What is NOT enforced is `required: true`: the engine's own editor
 * creates path-param inputs unmarked, so demanding it here would put every
 * SideStep-authored object out of step with every UI-authored one.
 *
 * One-directional by design — an input that is NOT in the path is a normal
 * query-string or body param and is left alone.
 */
export function assertPathParamInputs(
  context: string,
  params: readonly string[],
  inputs: Record<string, InputDescriptor> | undefined,
): void {
  for (const name of params) {
    const descriptor = inputs?.[name];
    if (!descriptor) {
      throw new Error(
        `${context}: the path declares {${name}} but there is no \`${name}\` input to bind it to, ` +
          `so the segment would be an inert part of the route string. Add it: ` +
          `input: { ${name}: input.text() }.`,
      );
    }
    if (descriptor.options?.array === true) {
      throw new Error(
        `${context}: the path param \`${name}\` cannot be a list — one path segment holds one value. ` +
          `Use a scalar input, or take the list as a query-string/body param under a different name.`,
      );
    }
    const type = descriptor.type;
    if (!isSegmentType(type)) {
      const article = /^[aeiou]/i.test(type) ? "an" : "a";
      throw new Error(
        `${context}: the path param \`${name}\` cannot be ${article} \`${type}\` — a path segment is a single ` +
          `string, so structured, binary, and multi-valued types have no URL form. Use a scalar input ` +
          `(text/int/uuid/…), or move this value to a query-string or body param.`,
      );
    }
  }
}

/**
 * Substitute `{param}` segments with real values, yielding the concrete path a
 * client addresses. Throws rather than emitting a path that would silently hit
 * the wrong route: an unknown key, a missing/empty value, a non-finite number,
 * or a value containing `/` (which fabricates a segment).
 *
 * `accessor` names the caller in the error text (`getPath()` / `getChannel()`).
 */
export function fillPathParams(
  context: string,
  accessor: string,
  path: string,
  params?: Record<string, string | number>,
): string {
  const declared = parsePathParams(context, path);
  const given = params ?? {};
  for (const key of Object.keys(given)) {
    if (!declared.includes(key)) {
      throw new Error(
        `${context}: ${accessor} was given \`${key}\`, which is not a {param} segment of the path. ` +
          (declared.length
            ? `Expected: ${declared.map((p) => `\`${p}\``).join(", ")}.`
            : `This path is static — call ${accessor} with no arguments.`),
      );
    }
  }
  return path.replace(PARAM_MARKER, (_all, key: string) => {
    const value = given[key];
    if (value === undefined || value === null || value === "") {
      throw new Error(
        `${context}: ${accessor} needs a value for the path param \`${key}\` — ` +
          `pass { ${declared.map((p) => `${p}: … `).join(", ")}}.`,
      );
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(
        `${context}: the path param \`${key}\` is ${value} — not a finite value to put in a path.`,
      );
    }
    const text = String(value);
    if (text.includes("/")) {
      throw new Error(
        `${context}: the path param \`${key}\` cannot contain "/" (got ${JSON.stringify(text)}) — ` +
          `it would fabricate a path segment and address a different route.`,
      );
    }
    return text;
  });
}

/** Matches a well-formed marker for substitution; validity is `parsePathParams`'s job. */
const PARAM_MARKER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * The `{param}` names in a path literal, as a union of string literal types —
 * `PathParams<"blog/{slug}/review/{review_id}">` is `"slug" | "review_id"`, and
 * a static path yields `never`. Lets an accessor type its params argument from
 * the authored `name`, so a wrong or missing key is a compile error rather than
 * a runtime throw at request time.
 */
export type PathParams<S extends string> = S extends `${string}{${infer P}}${infer Rest}`
  ? P | PathParams<Rest>
  : never;

/** Whether a path literal `S` carries no `{param}` segments. */
export type IsStaticPath<S extends string> = [PathParams<S>] extends [never] ? true : false;

/** The exactly-keyed params record for a path literal `S`. */
export type PathParamValues<S extends string> = Record<PathParams<S>, string | number>;
