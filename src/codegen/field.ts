/**
 * Field, input, and response decoders — stored `FieldXdo` → `f.*` / `input.*`
 * source, and stored `result[]` → a `response` def.
 *
 * Same discipline as the value decoder: a readable candidate is only emitted
 * after `encodeField` has been run over the recovered options and the result
 * compared against the stored field. When the catalog cannot reproduce a stored
 * shape, the decoder drops to the descriptor literal (`{type, options}`), which
 * is still a legal `FieldDescriptor` and still round-trips.
 *
 * A handful of stored keys are fixed by `encodeField` and have no authoring
 * surface at all (`merge`, `hidden`, `override`, `customize`, `market_item`,
 * `is_settings_registry`). A field carrying a non-default value for one of those
 * cannot round-trip through any authored form, so it is reported by name rather
 * than quietly emitted as something close.
 */
import type { FieldXdo, MethodXdo, ResultItemXdo, TaggedValue } from "../types/xdo.js";
import type { FieldOptions, MethodSpec, NestedField } from "../fields/field.js";
import { COLUMN_CONTEXT, INPUT_CONTEXT, encodeField } from "../fields/field.js";
import type { FieldContext } from "../fields/field.js";
import { f } from "../fields/catalog.js";
import type { FieldDescriptor } from "../fields/catalog.js";
import { input } from "../inputs/input.js";
import { CODEGEN_MODULE, CORE_MODULE, type DecodeContext } from "./context.js";
import { call, lit, obj, type Expr } from "./print.js";
import { resolveReference, type RefIndex, type ResolveOptions } from "./ref-index.js";
import { normalize } from "../validate/normalize.js";
import { decodeValue } from "./value.js";

/** Which authoring catalog to emit against: table columns (`f`) or inputs (`input`). */
export type FieldSurface = "f" | "input";

/**
 * Stored type → catalog accessor, for the types whose authoring name differs
 * from what the engine persists (plus the ones that match, for completeness).
 * `enum`, `vector`, `obj`, and table refs take positional payloads and are
 * handled separately.
 */
const CATALOG_BY_TYPE: Readonly<Record<string, string>> = {
  text: "text",
  int: "int",
  decimal: "decimal",
  bool: "bool",
  uuid: "uuid",
  date: "date",
  email: "email",
  password: "password",
  json: "json",
  epochms: "timestamp",
  blob_img: "image",
  blob_video: "video",
  blob_audio: "audio",
  blob: "attachment",
  geo_point: "geo.point",
  geo_multipoint: "geo.multipoint",
  geo_linestring: "geo.linestring",
  geo_multilinestring: "geo.multilinestring",
  geo_polygon: "geo.polygon",
  geo_multipolygon: "geo.multipolygon",
};

/**
 * Types that exist only as inputs, so they must not resolve against `f.*`.
 * `file` is a raw upload — the request's bytes, not a stored resource — which is
 * why no table column has the type and why `f` has no constructor for it.
 */
const INPUT_ONLY_BY_TYPE: Readonly<Record<string, string>> = { file: "file" };

/**
 * Stored keys `encodeField` writes unconditionally, with the value it always
 * writes. No authoring option reaches any of these, so a stored field carrying a
 * different value cannot round-trip through *any* source form — not the catalog
 * call and not the descriptor literal either.
 */
const ENCODER_FIXED: ReadonlyArray<readonly [string, unknown]> = [
  // `merge` and `hidden` used to sit here. They are authorable field options now,
  // which is what lets a merged/hidden field come back as a readable catalog call:
  // together they were the largest single cause of `rawField()` in the sweep.
  ["override", []],
  ["is_settings_registry", false],
];

/**
 * Field equality under the round-trip contract's own comparator (R2). `normalize`
 * strips the server-generated keys the SDK never emits — `_xsid`, `market_item` —
 * so a stored `_xsid` is not a fidelity loss, while `customize` (which it does not
 * strip) is.
 */
function sameField(a: unknown, b: unknown): boolean {
  return deepEqual(normalize(a), normalize(b));
}

/**
 * The top-level keys on which a re-encoded field disagrees with the stored one.
 *
 * A `value-fallback` that only says a field "emitted as a descriptor literal"
 * cannot be clustered — and two different causes reach that message, so a row
 * cannot even be attributed to one of them. Naming the keys is what turns the
 * category into something a sweep can group by. Compared under `normalize`, the
 * same comparator {@link sameField} uses, so a key it strips never shows up.
 */
function differingKeys(encoded: unknown, stored: unknown): string[] {
  const a = normalize(encoded) as Record<string, unknown> | null;
  const b = normalize(stored) as Record<string, unknown> | null;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => !deepEqual(a[key], b[key])).sort();
}

/** How a re-encode differed, as a message fragment naming the keys. */
function describeDiff(encoded: unknown, stored: unknown): string {
  const keys = differingKeys(encoded, stored);
  return keys.length === 0 ? "differs structurally" : `differs at ${keys.join(", ")}`;
}

/** Structural equality over stored JSON. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every(
    (k) =>
      Object.hasOwn(b as object, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * Stored keys with no authoring surface that this field sets to a non-default.
 *
 * `customize` and `market_item` come from the {@link FieldContext} rather than a
 * constant, so they are checked against the context in force.
 *
 * The comparison runs under `normalize` — the round-trip contract's own
 * comparator — not raw equality, so a legacy `customize:""` counts as the empty
 * customization it is rather than as an unrepresentable shape. Comparing raw
 * made this function contradict the oracle the decode is proven against: the
 * catalog call it refused reproduces the field exactly under the only
 * comparison anyone actually runs.
 */
function unrepresentableKeys(stored: FieldXdo, context: FieldContext): string[] {
  const record = stored as unknown as Record<string, unknown>;
  // `_xsid` and `market_item` are omitted deliberately: `normalize` strips both,
  // so a stored value there does not break the round trip and reporting it would
  // be noise on every pulled object.
  const fixed: Array<readonly [string, unknown]> = [
    ...ENCODER_FIXED,
    ["customize", context.customize],
  ];
  // Each side is normalized as a one-key OBJECT, not as a bare value: the rules
  // that canonicalize the empty `customize` forms (and that drop a member
  // sitting at its engine default) are keyed off the member NAME, so they only
  // fire when the key is there to be seen.
  return fixed
    .filter(
      ([key, value]) =>
        Object.hasOwn(record, key) &&
        !deepEqual(normalize({ [key]: record[key] }), normalize({ [key]: value })),
    )
    .map(([key]) => key);
}

/**
 * `"min:8"` for a method whose args survive the colon round trip, else null.
 *
 * Self-checking rather than rule-based: the candidate string is parsed back with
 * the encoder's own splitter and compared to the stored args, so this cannot
 * drift from `parseMethod` no matter how either side changes.
 */
function colonForm(name: string, args: readonly (string | number)[]): string | null {
  if (name.includes(":")) return null;
  if (args.length === 0) return name;
  if (!args.every((a) => typeof a === "number" || typeof a === "string")) return null;
  const candidate = [name, ...args].join(":");
  const [reName = candidate, ...reArgs] = candidate.split(":");
  if (reName !== name || reArgs.length !== args.length) return null;
  const recovered = reArgs.map((part) =>
    part !== "" && String(Number(part)) === part ? Number(part) : part,
  );
  return recovered.every((value, i) => value === args[i]) ? candidate : null;
}

/** Recover authoring `methods` from the stored list, or null when not expressible. */
function recoverMethods(stored: readonly MethodXdo[]): MethodSpec[] | null {
  const out: MethodSpec[] = [];
  for (const method of stored) {
    // `encodeMethods` always writes `disabled: false`; a disabled method has no
    // authoring form. An ABSENT `disabled` is the older engine generation's way
    // of writing the same default (see the lean field envelope in
    // `normalize`) — only an explicit `true` is a real disabled method.
    if ((method.disabled ?? false) !== false) return null;
    const args = method.arg ?? [];
    // Prefer the colon shorthand (`"min:8"`) — it is what an author writes, and
    // the object form turns a three-rule password column into fifteen lines.
    // It is only emitted when re-parsing it yields the stored args exactly, so
    // an arg that cannot survive the trip (an embedded `:`, a string that looks
    // like a number) falls back to the explicit form rather than drifting.
    const shorthand = colonForm(method.name, args);
    out.push(shorthand ?? { name: method.name, arg: [...args] });
  }
  return out;
}

/** Recover the authoring `FieldOptions` a stored field was encoded from. */
function recoverOptions(
  stored: FieldXdo,
  includeDescription: boolean,
  elide = true,
): FieldOptions | null {
  // Every read tolerates an absent key. A bundle's fields are complete, but a
  // decoder that throws on a partial shape turns a recoverable oddity into a
  // failed pull; falling through to the proof below (and then to `rawField()`)
  // keeps it exact instead.
  const options: FieldOptions = {};
  const values = Array.isArray(stored.values) ? stored.values : [];
  const list = stored.list ?? { min: "", max: "" };
  const vector = stored.vector ?? { size: 3 };
  const style = stored.style ?? { type: "single" };
  const access = stored.access ?? "public";
  const format = stored.format ?? "";
  const mode = stored.mode ?? "";
  const fallbackDefault = stored.default ?? "";

  // Recovered verbatim rather than interpreted: a stored `hidden: [""]` is a real
  // spelling in the wild, and reproducing it exactly is what makes this safe
  // without deciding what an empty entry MEANS.
  if (stored.merge === true || !elide) options.merge = stored.merge === true;
  const hidden = Array.isArray(stored.hidden) ? (stored.hidden as string[]) : [];
  if (hidden.length > 0 || !elide) options.hidden = [...hidden];
  if (stored.nullable || !elide) options.nullable = stored.nullable ?? false;
  if (stored.required || !elide) options.required = stored.required ?? false;
  if (stored.sensitive || !elide) options.sensitive = stored.sensitive ?? false;
  // An ABSENT `default` is not the same stored shape as an empty one, and only a
  // uuid primary key is stored that way. Recovering it as `noDefault` lets the
  // column come back as a readable catalog call; without it, no `f.*` form could
  // reproduce the absence and the field degraded to a `rawField()` passthrough.
  if (!Object.hasOwn(stored, "default")) options.noDefault = true;
  else if (fallbackDefault !== "" || !elide) options.default = fallbackDefault;
  if (mode !== "" || !elide) options.mode = mode;
  if (format !== "" || !elide) options.format = format as FieldOptions["format"];
  if (access !== "public" || !elide) options.access = access as FieldOptions["access"];
  if (values.length > 0) options.values = [...values] as FieldOptions["values"];
  if (!deepEqual(list, { min: "", max: "" })) options.list = { ...list };
  if (!deepEqual(vector, { size: 3 })) options.vector = { ...vector };
  // `array: true` and `style: {type:"list"}` encode identically; the explicit
  // style is used so the recovered options re-encode without relying on which
  // branch `encodeField` took.
  if (!deepEqual(style, { type: "single" })) {
    options.style = { type: style.type as NonNullable<FieldOptions["style"]>["type"] };
  }
  if (includeDescription && stored.description !== undefined && stored.description !== "") {
    options.description = stored.description;
  }

  const methods = recoverMethods(stored.methods ?? []);
  if (methods === null) return null;
  if (methods.length > 0) options.methods = methods;

  const children: NestedField[] = [];
  for (const child of storedChildren(stored)) {
    const childOptions = recoverOptions(child, includeDescription);
    if (childOptions === null) return null;
    children.push({ name: child.name, type: child.type, ...childOptions });
  }
  if (children.length > 0) options.children = children;

  return options;
}

/** A field's nested children. Stored loosely as `unknown[]`; every entry is a field. */
function storedChildren(stored: FieldXdo): FieldXdo[] {
  return (stored.children ?? []) as FieldXdo[];
}

/** The `@`-method table reference a `tableRef` column carries, if this is one. */
/**
 * The table a **database-link** input points at, or null when the field is not
 * one.
 *
 * The stored type is the table's identity with `_mvpschema` appended — the id in
 * the editor, the guid in an export, the same substitution `context.dbo.id`
 * gets. The engine splits on that suffix and expands the link into one input per
 * column of the named table.
 */
function dbLinkTableGuid(stored: FieldXdo): string | null {
  const suffix = "_mvpschema";
  if (typeof stored.type !== "string" || !stored.type.endsWith(suffix)) return null;
  const guid = stored.type.slice(0, -suffix.length);
  return guid === "" ? null : guid;
}

function tableRefGuid(stored: FieldXdo): string | null {
  if (stored.type !== "int" && stored.type !== "uuid") return null;
  const last = stored.methods?.[stored.methods.length - 1];
  const arg = last?.name === "@" ? last.arg?.[0] : undefined;
  if (typeof arg !== "string" || !arg.startsWith("dbo=")) return null;
  const guid = arg.slice("dbo=".length);
  // A bare `dbo=` is an FK annotation pointing at nothing — the editor writes it
  // when a reference is cleared. It is not a reference, and treating it as one
  // made `f.tableRef` throw on an empty target, which took the whole field down
  // to a descriptor literal. Returning null routes it through the ordinary
  // catalog path, where the `@` method rides along in `methods` verbatim.
  return guid === "" ? null : guid;
}

/**
 * The warning a `customize` block earns when it references tables by LOCAL id.
 *
 * A `customize` block carries per-column overrides, and those can include an `@`
 * table reference. The export remaps `@` targets to portable guids everywhere
 * else — 483 of them at field level across the sweep — but not inside
 * `customize`: all 60 references found there were still local numeric ids
 * (`dbo=14`). They are carried through byte-for-byte, so nothing is lost here,
 * but they name a row id in the SOURCE workspace and will point at whatever
 * happens to hold that id in a different one.
 *
 * That is also why `customize` has no authoring surface and should not get one:
 * a readable form would present unportable data as if it were authorable.
 */
function describeCustomizePortability(stored: FieldXdo): string {
  const customize = (stored as { customize?: unknown }).customize;
  if (customize === null || typeof customize !== "object") return "";
  const local = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value === null || typeof value !== "object") return;
    const method = value as { name?: unknown; arg?: unknown };
    if (method.name === "@" && Array.isArray(method.arg)) {
      const target = method.arg[0];
      if (typeof target === "string" && /^dbo=\d+$/.test(target)) local.add(target);
    }
    Object.values(value).forEach(walk);
  };
  walk(customize);
  if (local.size === 0) return "";
  return (
    `. Its customize references ${[...local].sort().join(", ")} by LOCAL row id rather than by guid — ` +
    `the export does not remap table references inside customize, so these carry verbatim but do not ` +
    `identify the same table in another workspace`
  );
}

/** Render recovered options as a source object literal, decoding nested children. */
function optionsExpr(options: FieldOptions, omit: ReadonlyArray<keyof FieldOptions> = []): Expr {
  const entries: Array<[string, Expr]> = [];
  for (const [key, value] of Object.entries(options)) {
    if ((omit as readonly string[]).includes(key)) continue;
    entries.push([key, lit(value)]);
  }
  return obj(entries);
}

/** A field decoded to source, plus whether it uses the readable catalog form. */
export interface DecodedField {
  readonly expr: Expr;
  readonly idiomatic: boolean;
}

/**
 * Decode one stored field to a `f.*` / `input.*` call, or to the descriptor
 * literal when the catalog cannot reproduce it.
 */
export function decodeField(
  ctx: DecodeContext,
  refs: RefIndex,
  stored: FieldXdo,
  surface: FieldSurface,
  resolve: ResolveOptions = {},
): DecodedField {
  const context = surface === "input" ? INPUT_CONTEXT : COLUMN_CONTEXT;
  const options = recoverOptions(stored, context.includeDescription);

  // Keys no authoring option can reach — `merge`, `customize`, … — would be
  // silently rewritten by any `f.*`/`input.*`/descriptor form. `rawField()`
  // carries the whole envelope instead, so this degrades readability without
  // losing data.
  const missing = unrepresentableKeys(stored, context);
  if (missing.length > 0) {
    ctx.use(CODEGEN_MODULE, "rawField");
    ctx.problem(
      "value-fallback",
      `field "${stored.name}" stores ${missing.join(", ")} in a shape no authoring surface can produce; emitted verbatim via rawField()` +
        describeCustomizePortability(stored),
    );
    return { idiomatic: false, expr: call("rawField", lit(stored)) };
  }

  /**
   * The descriptor literal reproduces the stored field through `encodeField`'s
   * normal path, so it is preferred over `rawField()` — it still reads as data,
   * but as *authorable* data. `rawField()` is the last resort.
   */
  const descriptorLiteral = (): DecodedField => {
    const descriptor: Expr = obj([
      ["type", lit(stored.type)],
      ["options", options === null ? lit({}) : optionsExpr(options)],
    ]);
    if (options !== null && sameField(encodeField(stored.name, stored.type, options, context), stored)) {
      return { idiomatic: false, expr: descriptor };
    }
    ctx.use(CODEGEN_MODULE, "rawField");
    return { idiomatic: false, expr: call("rawField", lit(stored)) };
  };

  // The descriptor literal is still a legal `FieldDescriptor`, so the schema
  // keeps compiling; it just reads as data rather than as a catalog call.
  const literalBecause = (why: string): DecodedField => {
    if (missing.length === 0) {
      ctx.problem(
        "value-fallback",
        `field "${stored.name}" (${stored.type}) emitted as a descriptor literal: ${why}`,
      );
    }
    return descriptorLiteral();
  };

  if (options === null) {
    return literalBecause("its options could not be recovered from the stored shape");
  }
  const reEncoded = encodeField(stored.name, stored.type, options, context);
  if (!sameField(reEncoded, stored)) {
    return literalBecause(`re-encoding the recovered options ${describeDiff(reEncoded, stored)}`);
  }

  const ns = ctx.use(CORE_MODULE, surface);
  const opts = options;

  /**
   * Emit a catalog call only once the constructor has been run and its output
   * compared against the stored field. Constructors apply their own defaults
   * (`f.password` sets `access:"internal"`), so recovered options that re-encode
   * correctly through `encodeField` can still be wrong through the catalog.
   */
  /**
   * Why the last candidate was rejected, kept so the fallback can say what the
   * catalog could not reproduce instead of only that it failed. A constructor
   * that throws leaves no encoding to diff, so it records that instead.
   */
  let lastRejection = "no catalog form was attempted";
  const proven = (expr: Expr, build: () => FieldDescriptor): DecodedField | null => {
    let built: FieldDescriptor;
    try {
      built = build();
    } catch (err) {
      lastRejection = `the catalog constructor threw (${err instanceof Error ? err.message : String(err)})`;
      return null;
    }
    const encoded = encodeField(stored.name, built.type, built.options, context);
    if (sameField(encoded, stored)) return { idiomatic: true, expr };
    lastRejection = `the catalog call ${describeDiff(encoded, stored)}`;
    return null;
  };

  /** The catalog the emitted call resolves against at evaluation time. */
  const catalog = (surface === "input" ? input : f) as unknown as Record<string, unknown>;

  const dbLinkGuid = dbLinkTableGuid(stored);
  if (dbLinkGuid !== null && surface === "input") {
    // `merge` is what makes the engine expand the link, so `input.dbLink` forces
    // it — emitting it back would be redundant, and it is not authorable here.
    const { merge: _merge, ...rest } = opts;
    const restExpr = optionsExpr(rest as FieldOptions);
    const args: Expr[] = [
      resolveReference(ctx, refs, dbLinkGuid, { ...resolve, unresolved: "object-ref" }),
    ];
    if (restExpr.kind === "object" && restExpr.entries.length > 0) args.push(restExpr);
    const decoded = proven(call(`${ns}.dbLink`, ...args), () =>
      input.dbLink({ name: "", guid: dbLinkGuid }, rest as never),
    );
    if (decoded) return decoded;
  }

  const refGuid = tableRefGuid(stored);
  if (refGuid !== null) {
    // The `@` method IS the reference; it is re-added by `f.tableRef`, so the
    // authored options must not repeat it.
    const withoutRef: FieldOptions = { ...opts, methods: opts.methods!.slice(0, -1) };
    if (withoutRef.methods!.length === 0) delete withoutRef.methods;
    // `type` is a tableRef-only option (the FK's scalar type) and defaults to int.
    const entries: Array<[string, Expr]> = stored.type === "uuid" ? [["type", lit("uuid")]] : [];
    for (const [key, value] of Object.entries(withoutRef)) entries.push([key, lit(value)]);
    // `f.tableRef` takes an ObjectRef, where a bare string is read as a NAME —
    // so an unresolvable guid must degrade to `{name, guid}`, not to the string.
    const args: Expr[] = [
      resolveReference(ctx, refs, refGuid, { ...resolve, unresolved: "object-ref" }),
    ];
    const tail = { ...(stored.type === "uuid" ? { type: "uuid" } : {}), ...withoutRef };
    if (entries.length > 0) args.push(obj(entries));
    const decoded = proven(call(`${ns}.tableRef`, ...args), () =>
      f.tableRef({ name: "", guid: refGuid }, tail as never),
    );
    if (decoded) return decoded;
  } else if (stored.type === "enum") {
    const rest = optionsExpr(opts, ["values"]);
    const args: Expr[] = [lit(opts.values ?? [])];
    if (rest.kind === "object" && rest.entries.length > 0) args.push(rest);
    const { values, ...restOpts } = opts;
    const decoded = proven(call(`${ns}.enum`, ...args), () =>
      (catalog.enum as (v: never, o: never) => FieldDescriptor)(
        (values ?? []) as never,
        restOpts as never,
      ),
    );
    if (decoded) return decoded;
  } else if (stored.type === "vector") {
    const rest = optionsExpr(opts, ["vector"]);
    const args: Expr[] = [lit(opts.vector?.size ?? 3)];
    if (rest.kind === "object" && rest.entries.length > 0) args.push(rest);
    const { vector, ...restOpts } = opts;
    const decoded = proven(call(`${ns}.vector`, ...args), () =>
      (catalog.vector as (s: number, o: never) => FieldDescriptor)(
        vector?.size ?? 3,
        restOpts as never,
      ),
    );
    if (decoded) return decoded;
  } else if (stored.type === "obj") {
    const rest = optionsExpr(opts, ["children"]);
    const children = storedChildren(stored);
    const args: Expr[] = [
      obj(children.map((child) => [child.name, decodeField(ctx, refs, child, surface, resolve).expr])),
    ];
    if (rest.kind === "object" && rest.entries.length > 0) args.push(rest);
    const { children: childOpts, ...restOpts } = opts;
    const decoded = proven(call(`${ns}.object`, ...args), () =>
      (catalog.object as (c: never, o: never) => FieldDescriptor)(
        Object.fromEntries(
          (childOpts ?? []).map(({ name, type, ...rest2 }) => [name, { type, options: rest2 }]),
        ) as never,
        restOpts as never,
      ),
    );
    if (decoded) return decoded;
  } else {
    const accessor =
      CATALOG_BY_TYPE[stored.type] ??
      (surface === "input" ? INPUT_ONLY_BY_TYPE[stored.type] : undefined);
    if (accessor !== undefined) {
      const [head, leaf] = accessor.split(".");
      const factory = (
        leaf === undefined
          ? catalog[head!]
          : (catalog[head!] as Record<string, unknown>)[leaf]
      ) as (o: never) => FieldDescriptor;

      // Try the leanest form first. A constructor may supply its own defaults
      // (`f.password` sets `access:"internal"`), so any recovered option the bare
      // call already produces is redundant — dropping it is what makes
      // `f.password()` read as `f.password()`. Each candidate is still proven, so
      // trimming can never change the emitted bytes.
      const candidates: FieldOptions[] = [opts];
      const bare = (() => {
        try {
          return factory({} as never).options as Record<string, unknown>;
        } catch {
          return null;
        }
      })();
      if (bare) {
        const lean = Object.fromEntries(
          Object.entries(opts).filter(([key, value]) => !deepEqual(value, bare[key])),
        ) as FieldOptions;
        if (Object.keys(lean).length < Object.keys(opts).length) candidates.unshift(lean);

        // The mirror case: a constructor default can also *override* a value the
        // recovered options dropped as an encoder default. `f.password` forces
        // `access:"internal"`, so a stored public password column needs `access`
        // stated back explicitly even though `encodeField` treats it as the default.
        const full = recoverOptions(stored, context.includeDescription, false);
        if (full) {
          const restated = Object.fromEntries(
            Object.keys(bare)
              .filter((key) => Object.hasOwn(full, key))
              .map((key) => [key, (full as Record<string, unknown>)[key]]),
          );
          candidates.push({ ...opts, ...restated } as FieldOptions);
        }
      }

      for (const candidate of candidates) {
        const rest = optionsExpr(candidate);
        const args = rest.kind === "object" && rest.entries.length > 0 ? [rest] : [];
        const decoded = proven(call(`${ns}.${accessor}`, ...args), () => factory(candidate as never));
        if (decoded) return decoded;
      }
    }
  }

  // The catalog form did not reproduce the stored bytes — a constructor default
  // the recovered options did not account for. The descriptor literal bypasses
  // constructors entirely, so it still round-trips.
  ctx.problem(
    "value-fallback",
    `field "${stored.name}" (${stored.type}) emitted as a descriptor literal: ${lastRejection}`,
  );
  return descriptorLiteral();
}

/** Decode a stored field array to a named `FieldMap` object literal. */
export function decodeFieldMap(
  ctx: DecodeContext,
  refs: RefIndex,
  fields: readonly FieldXdo[],
  surface: FieldSurface,
  resolve: ResolveOptions = {},
): Expr {
  return obj(
    fields.map((field) => [
      field.name,
      ctx.at(`${surface === "input" ? "input" : "schema"}.${field.name}`, () =>
        decodeField(ctx, refs, field, surface, resolve).expr,
      ),
    ]),
  );
}

/**
 * Decode a stored `result[]` back to a `response` def.
 *
 * A single unnamed item is a bare value; named items form a record. An empty
 * list means the def declared no response at all, so the caller omits the key.
 */
export function decodeResponse(
  ctx: DecodeContext,
  stored: readonly ResultItemXdo[],
): Expr | undefined {
  if (stored.length === 0) return undefined;

  const asValue = (item: ResultItemXdo): TaggedValue => ({
    value: item.value,
    tag: item.tag,
    filters: item.filters ?? [],
  });

  // `encodeResponse` writes `disabled` unconditionally at its default, so a
  // stored item that sets it cannot come back through the `response:` field in
  // any form. Carry the whole `result[]` verbatim instead. Checked before
  // decoding, since one such item spoils the array.
  //
  // `_xsid` is deliberately NOT a trigger. It is an engine-generated editor id
  // on `normalize()`'s strip list, so it is not authored data and can never fail
  // verification — measured across the fixture corpus, 13 result items carry a
  // non-empty one and none carry `disabled`. Treating it as unrepresentable
  // (as this check first did) would push nearly every real query onto the raw
  // path and cost the readability the typed decode exists for.
  const unrepresentable = stored.filter((item) => item.disabled !== false);
  if (unrepresentable.length > 0) {
    ctx.use(CODEGEN_MODULE, "rawResponse");
    ctx.problem(
      "raw-fallback",
      `response item${unrepresentable.length === 1 ? "" : "s"} ${unrepresentable
        .map((item) => `"${item.name || "(unnamed)"}"`)
        .join(", ")} set \`disabled\`, which no authoring surface can produce; the response is emitted verbatim via rawResponse()`,
    );
    return call("rawResponse", lit(stored));
  }

  const single = stored.length === 1 && stored[0]!.name === "";
  if (single) return decodeValue(ctx, asValue(stored[0]!));

  // Everything else is emitted as a RECORD, which is keyed by name — so it can
  // only carry items whose names are non-empty and distinct. Two items sharing a
  // name collapse into one, and a blank name is a name items share: one real
  // query stores four items, three of them unnamed, and came back as two with
  // the survivors' tags and values shuffled onto each other.
  const names = stored.map((item) => item.name);
  const keyed = names.every((name) => name !== "") && new Set(names).size === names.length;
  if (!keyed) {
    ctx.use(CODEGEN_MODULE, "rawResponse");
    ctx.problem(
      "raw-fallback",
      `the response has ${stored.length} items whose names do not key it (blank or repeated), which the record form cannot carry; emitted verbatim via rawResponse()`,
    );
    return call("rawResponse", lit(stored));
  }

  return obj(
    stored.map((item) => [item.name, ctx.at(`response.${item.name}`, () => decodeValue(ctx, asValue(item)))]),
  );
}

/** Re-exported so kind decoders share one structural comparison. */
export { deepEqual };
