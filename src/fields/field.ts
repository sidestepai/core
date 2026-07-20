/**
 * Shared field encoder (KTD-6). Function inputs and table columns are nearly
 * the same stored shape; this encoder fills the common defaults and is
 * parameterized by a `FieldContext` for the three spots where they differ:
 * `customize` (`""` vs `{}`), `market_item` id types (string vs numeric), and
 * whether `description` is emitted.
 */
import type { FieldXdo, MethodXdo } from "../types/xdo.js";

/** Field visibility — the engine's `access` enum (`dbo-schema-*.yaml`). */
export type FieldAccess = "public" | "private" | "internal";

/** Valid `format` values for text fields (`dbo-schema-text.yaml`). */
export type TextFormat = "" | "plaintext" | "yaml" | "html" | "xml" | "markdown";

/** Field cardinality — `"single"` (scalar) or `"list"` (array column). */
export type FieldStyleType = "single" | "list";

export interface FieldOptions {
  required?: boolean;
  nullable?: boolean;
  /**
   * Default value. Authored as a `string`, `number`, or `boolean` for
   * ergonomics (`default: 0`, `default: false`); the engine stores it as a
   * string, so it's coerced at encode time (`0` → `"0"`, `false` → `"false"`).
   *
   * On a **table column** the default must stay within the Basic Multilingual
   * Plane: a 4-byte character (codepoint > U+FFFF — emoji, CJK-extension glyphs)
   * is mangled into an invalid UTF-8 sequence by the engine's default pipeline
   * and is rejected at export/encode time rather than 500ing at deploy with
   * Postgres `22021` (issue #45). BMP characters (accents, `€`, most CJK) store
   * fine. A *function/endpoint input* default binds at runtime and has no limit.
   */
  default?: string | number | boolean;
  description?: string;
  /**
   * Methods/filters applied at bind time. Each entry is either a bare name
   * (`"trim"`), a colon-form string with args (`"min:8"` → `{name:"min",
   * arg:["8"]}`), or an explicit `{ name, arg }` object.
   */
  methods?: MethodSpec[];
  /** Enum values (for `type:"enum"` fields), e.g. `["draft","live"]`. */
  values?: Array<string | number>;
  mode?: string;
  /** Text-field display format (text fields only; the engine drops it elsewhere). */
  format?: TextFormat;
  sensitive?: boolean;
  /** Field visibility in API output. Defaults to `"public"`. */
  access?: FieldAccess;
  style?: { type: FieldStyleType };
  list?: { min: string; max: string };
  vector?: { size: number };
  /**
   * Array/list field — stored as `style:{type:"list"}` (e.g. `int[]`, `object[]`).
   * Ignored when an explicit `style` is given.
   */
  array?: boolean;
  /** Nested fields for `type:"obj"` columns; each is itself a named, typed field. */
  children?: NestedField[];
}

/** A nested field inside an object column's `children` — a named, typed `FieldOptions`. */
export interface NestedField extends FieldOptions {
  name: string;
  type: string;
}

/** Context distinguishing an input field from a column field. */
export interface FieldContext {
  customize: string | Record<string, unknown>;
  marketItem: { id: string | number; version: string | number; guid: string };
  includeDescription: boolean;
}

/**
 * Function-input and table-column fields share one persisted shape — confirmed
 * byte-for-byte against live `mvp_query.input[*]` and `mvp_dbo.schema[*]`: both
 * use `customize:{}` and numeric `market_item` ids. (The earlier `customize:""`
 * / string-id input form was the older parser-generation artifact.)
 */
export const INPUT_CONTEXT: FieldContext = {
  customize: {},
  marketItem: { id: 0, version: 0, guid: "" },
  includeDescription: true,
};

/** Table-column field context — identical persisted shape to {@link INPUT_CONTEXT}. */
export const COLUMN_CONTEXT: FieldContext = {
  customize: {},
  marketItem: { id: 0, version: 0, guid: "" },
  includeDescription: true,
};

/**
 * A field method/filter: a bare name (`"trim"`), a colon-form string carrying
 * args (`"min:8"`, `"min:8:foo"` — first segment is the name, the rest are
 * args), or an explicit `{ name, arg }` object.
 */
export type MethodSpec = string | { name: string; arg?: Array<string | number> };

/**
 * A type-narrowed {@link MethodSpec} for a field constructor: a bare method name
 * from the field type's valid set `N` (`"trim"`), the colon-form carrying args
 * (`"min:8"`), or the explicit `{ name, arg }` object — which stays a universal
 * escape hatch for any name the per-type union doesn't enumerate. The per-type
 * `N` unions live in `fields/generated/field-methods.generated.ts`.
 */
export type MethodArg<N extends string> =
  | N
  | `${N}:${string}`
  | { name: string; arg?: Array<string | number> };

/**
 * An options type `T` with its `methods` array widened to `readonly`. Field/input
 * constructors capture their options via a `const` type parameter so literal
 * flags (`required`/`nullable`/`array`) survive for `InferInput`; `const` also
 * makes any inline `methods: [...]` a readonly tuple, so a constructor's options
 * constraint must accept readonly arrays. The runtime cast back to `FieldOptions`
 * is safe — the encoder only ever reads (`.map`) the methods.
 */
export type ReadonlyMethods<T, N extends string> = Omit<T, "methods"> & {
  methods?: readonly MethodArg<N>[];
};

/** Normalize a `MethodSpec` into `{ name, arg }`, parsing the colon form. */
function parseMethod(spec: MethodSpec): { name: string; arg: Array<string | number> } {
  if (typeof spec !== "string") return { name: spec.name, arg: spec.arg ?? [] };
  const [name = spec, ...arg] = spec.split(":");
  return { name, arg };
}

export function encodeMethods(methods: MethodSpec[] | undefined): MethodXdo[] {
  return (methods ?? []).map((spec) => {
    const { name, arg } = parseMethod(spec);
    return { name, disabled: false, arg };
  });
}

/** Encode a named field (input or column) into its full stored `FieldXdo`. */
export function encodeField(
  name: string,
  type: string,
  options: FieldOptions,
  ctx: FieldContext,
): FieldXdo {
  const field: FieldXdo = {
    name,
    type,
    _xsid: "",
    nullable: options.nullable ?? false,
    default: options.default !== undefined ? String(options.default) : "",
    merge: false,
    hidden: [],
    override: [],
    customize: ctx.customize,
    required: options.required ?? false,
    values: options.values ?? [],
    mode: options.mode ?? "",
    format: options.format ?? "",
    sensitive: options.sensitive ?? false,
    list: options.list ?? { min: "", max: "" },
    vector: options.vector ?? { size: 3 },
    access: options.access ?? "public",
    style: options.style ?? { type: options.array ? "list" : "single" },
    children: (options.children ?? []).map((ch) => encodeField(ch.name, ch.type, ch, ctx)),
    methods: encodeMethods(options.methods),
    market_item: ctx.marketItem,
    is_settings_registry: false,
  };
  if (ctx.includeDescription) {
    field.description = options.description ?? "";
  }
  return field;
}
