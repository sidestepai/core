/**
 * Rich field-type catalog (`f.*`). A typed, validated authoring surface over the
 * shared field encoder. Each constructor returns a {@link FieldDescriptor}
 * (`{ type, options }`) carrying the **stored** type string — the engine's
 * author-facing names differ from what it persists, so this layer applies the
 * authoritative mapping (the engine's stored-type map):
 *
 *   object → obj · timestamp → epochms · image → blob_img ·
 *   video → blob_video · audio → blob_audio · attachment → blob
 *
 * Every other type (text/int/decimal/bool/uuid/date/email/password/json/enum/
 * vector/geo_*) is stored under its own name. Columns and inputs both consume
 * descriptors; the per-context differences (`customize`, `market_item`,
 * `description`) are still applied by {@link encodeField}.
 */
import type { FieldOptions, NestedField, MethodArg, ReadonlyMethods } from "./field.js";
import type {
  TypeBrand,
  XanoFileRef,
  XanoGeoJson,
  FromFieldMap,
} from "./value-types.js";
import { resolveRef } from "../refs/guid.js";
import type { ObjectRef } from "../refs/guid.js";
import type {
  TextMethod,
  IntMethod,
  DecimalMethod,
  EmailMethod,
  PasswordMethod,
  VectorMethod,
  TableRefMethod,
} from "./generated/field-methods.generated.js";

/** A typed field, ready to attach to a column/input name. */
export interface FieldDescriptor {
  /** The **stored** type string (post-mapping), e.g. `blob_img`, `epochms`. */
  type: string;
  options: FieldOptions;
}

/** A named map of fields — used for table schemas and object children. */
export type FieldMap = Record<string, FieldDescriptor>;

/** Options accepted by every catalog constructor (no `values`/`children`/`vector` — those are positional). */
export type FieldOpts = Omit<FieldOptions, "values" | "children" | "vector">;

/**
 * {@link FieldOpts} with `methods` narrowed to the field type's valid method set
 * `N` (see {@link MethodArg}). Types with no engine-declared methods use
 * `MethodOpts<never>`, leaving only the `{ name, arg }` escape hatch.
 */
export type MethodOpts<N extends string> = Omit<FieldOpts, "methods"> & {
  methods?: MethodArg<N>[];
};

/** {@link MethodOpts} made safe to capture under a `const` type parameter (see {@link ReadonlyMethods}). */
export type ConstMethodOpts<N extends string> = ReadonlyMethods<MethodOpts<N>, N>;

/**
 * The stored types that persist a `default` value. The engine drops `default`
 * on every other type at import (per the engine's schema processing), so
 * authoring one would silently lose data — guard it instead.
 */
const DEFAULTABLE_TYPES = new Set([
  "text",
  "int",
  "decimal",
  "enum",
  "bool",
  "email",
  "json",
  "date",
  "epochms",
]);

/** Field visibility — the engine's `access` enum. */
const ACCESS_VALUES = new Set(["public", "private", "internal"]);

/** Valid `format` values for text fields (per the engine's text-field schema). */
const FORMAT_VALUES = new Set(["", "plaintext", "yaml", "html", "xml", "markdown"]);

function descriptor(type: string, options: FieldOptions): FieldDescriptor {
  if (options.format && type !== "text") {
    throw new Error(`f: \`format\` is only valid on text fields, not "${type}".`);
  }
  if (options.format !== undefined && !FORMAT_VALUES.has(options.format)) {
    throw new Error(
      `f: invalid text \`format\` "${options.format}"; ` +
        `valid: plaintext/yaml/html/xml/markdown.`,
    );
  }
  if (options.access !== undefined && !ACCESS_VALUES.has(options.access)) {
    throw new Error(
      `f: invalid \`access\` "${options.access}"; valid: public/private/internal.`,
    );
  }
  if (
    options.default !== undefined &&
    options.default !== "" &&
    !DEFAULTABLE_TYPES.has(type)
  ) {
    throw new Error(
      `f: \`default\` is not supported on "${type}" fields (the engine drops it); ` +
        `valid on text/int/decimal/enum/bool/email/json/date/timestamp.`,
    );
  }
  // The two say opposite things about the same key, and silently honouring one
  // would emit bytes the author did not ask for.
  if (options.noDefault === true && options.default !== undefined) {
    throw new Error(
      `f: \`noDefault\` and \`default\` are mutually exclusive on "${type}" fields — ` +
        `\`noDefault\` omits the key entirely, so there is no value to set.`,
    );
  }
  return { type, options };
}

/**
 * A plain scalar/geo/file constructor: `f.int(opts?)`. `V` is the field's value
 * type (carried as a phantom brand for `InferInput`); the method-set type param
 * `N` narrows `options.methods` to the names valid for the field type. Options
 * are captured via a `const` type parameter `O` so literal flags survive on the
 * brand; the runtime object is still exactly `{ type, options }`.
 */
function make<V, N extends string = never>(type: string, defaults?: Partial<FieldOptions>) {
  return <const O extends ConstMethodOpts<N> = Record<string, never>>(
    options: O = {} as O,
  ): FieldDescriptor & TypeBrand<V, O> =>
    descriptor(type, { ...defaults, ...options } as FieldOptions) as FieldDescriptor & TypeBrand<V, O>;
}

/** Convert a named field map into the encoder's `NestedField[]` form. */
export function toNestedFields(map: FieldMap): NestedField[] {
  return Object.entries(map).map(([name, d]) => ({ name, type: d.type, ...d.options }));
}

/**
 * The stored scalar type of a `tableRef` FK, derived from its `type` option: a
 * `uuid`-keyed reference stores a `string`, everything else (the default `int`)
 * stores a `number`. Keeps `InferRow` honest — a FK column is the referenced
 * table's PK value, never the loose `string | number`.
 */
type TableRefValue<O> = "uuid" extends (O extends { type: infer T } ? T : never)
  ? string
  : number;

/** The rich field-type catalog. */
export const f = {
  // --- scalars ---
  text: make<string, TextMethod>("text"),
  int: make<number, IntMethod>("int"),
  decimal: make<number, DecimalMethod>("decimal"),
  bool: make<boolean>("bool"),
  uuid: make<string>("uuid"),
  date: make<string>("date"),
  email: make<string, EmailMethod>("email"),
  /** Password field; defaults to `access:"internal"` (the engine's stored default). */
  password: make<string, PasswordMethod>("password", { access: "internal" }),
  json: make<unknown>("json"),
  /** Epoch-millisecond timestamp (authored as `timestamp`). */
  timestamp: make<number>("epochms"),

  // --- file resources (authoring name → blob_* stored name) ---
  /** Image file resource (stored `blob_img`). */
  image: make<XanoFileRef>("blob_img"),
  /** Video file resource (stored `blob_video`). */
  video: make<XanoFileRef>("blob_video"),
  /** Audio file resource (stored `blob_audio`). */
  audio: make<XanoFileRef>("blob_audio"),
  /** Generic file attachment (stored `blob`). */
  attachment: make<XanoFileRef>("blob"),

  // --- geo ---
  geo: {
    point: make<XanoGeoJson>("geo_point"),
    multipoint: make<XanoGeoJson>("geo_multipoint"),
    linestring: make<XanoGeoJson>("geo_linestring"),
    multilinestring: make<XanoGeoJson>("geo_multilinestring"),
    polygon: make<XanoGeoJson>("geo_polygon"),
    multipolygon: make<XanoGeoJson>("geo_multipolygon"),
  },

  // --- composite (positional payload + options) ---
  /** Enum field; `values` is required and must be non-empty. */
  enum<const V extends ReadonlyArray<string | number>, const O extends ConstMethodOpts<never> = Record<string, never>>(
    values: V,
    options: O = {} as O,
  ): FieldDescriptor & TypeBrand<V[number], O> {
    if (!values?.length) throw new Error("f.enum: at least one value is required.");
    return descriptor("enum", { ...options, values: [...values] } as FieldOptions) as FieldDescriptor &
      TypeBrand<V[number], O>;
  },

  /** Vector field; `size` (>= 1) is the embedding dimensionality. */
  vector<const O extends ConstMethodOpts<VectorMethod> = Record<string, never>>(
    size: number,
    options: O = {} as O,
  ): FieldDescriptor & TypeBrand<number[], O> {
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(`f.vector: size must be an integer >= 1, got ${size}.`);
    }
    return descriptor("vector", { ...options, vector: { size } } as FieldOptions) as FieldDescriptor &
      TypeBrand<number[], O>;
  },

  /** Nested object field (stored `obj`); `children` is a named field map. */
  object<const C extends FieldMap, const O extends ConstMethodOpts<never> = Record<string, never>>(
    children: C,
    options: O = {} as O,
  ): FieldDescriptor & TypeBrand<FromFieldMap<C>, O> {
    return descriptor("obj", { ...options, children: toNestedFields(children) } as FieldOptions) as FieldDescriptor &
      TypeBrand<FromFieldMap<C>, O>;
  },

  /**
   * Table-reference (foreign-key) field — the column holds the referenced
   * table's primary key. The engine persists the link as a trailing `@` method
   * carrying the target table's id (`{name:"@", arg:["dbo=<guid>"]}`); on import
   * it parses that back into the column's `tableref_id`. The reference resolves to the
   * table's deterministic guid via the shared cross-object resolver, so it
   * agrees with the target table's payload `guid` with no shared registry.
   *
   * Defaults to an `int` column (matching an `int` primary key); pass
   * `{ type: "uuid" }` to reference a uuid-keyed table. A reference column may
   * only be `int` or `uuid` — the two valid primary-key types.
   *
   * @param table The referenced table (a `table()` def handle or its bare name).
   *   For a **self-reference** (e.g. `tweets.reply_to → tweets`), the table's
   *   `const` binding isn't assigned yet inside its own initializer — using the
   *   handle throws a "used before declaration" error. Pass the **bare name**
   *   instead: `f.tableRef("tweets", { type: "int" })`. Identity guids derive
   *   from `(type, name)`, so the name form resolves to the same guid.
   *
   * @TODO(byte-verify): MODELED on the engine's tableref schema. Round-trip-tested
   *   (the `@` arg guid equals the target table's payload guid) but the exact stored
   *   method shape (does `@` carry `disabled:false`? is it always last?) is
   *   unconfirmed. Blocked on an object-level capture: `sidestep validate --capture`
   *   round-trips FUNCTIONS, so it yields statement goldens but not a persisted TABLE
   *   schema — a tableref golden needs a table-object readback the capture path
   *   doesn't emit yet. The engine also asserts the referenced table's PK type
   *   matches (int↔int, uuid↔uuid); sidestep does NOT validate that here (no access
   *   to the target's schema), so a mismatched f.tableRef(uuidTable) on an int
   *   column would only fail at import.
   */
  tableRef<
    const O extends ConstMethodOpts<TableRefMethod> & { type?: "int" | "uuid" } = Record<string, never>,
  >(table: ObjectRef, options: O = {} as O): FieldDescriptor & TypeBrand<TableRefValue<O>, O> {
    const { type = "int", methods = [], ...rest } = options as ConstMethodOpts<TableRefMethod> & {
      type?: "int" | "uuid";
    };
    const guid = resolveRef("dbo", table);
    return descriptor(type, {
      ...rest,
      methods: [...(methods ?? []), { name: "@", arg: [`dbo=${guid}`] }],
    }) as FieldDescriptor & TypeBrand<TableRefValue<O>, O>;
  },
} as const;
