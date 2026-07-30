/**
 * Database-family decoders — the `!map:dbo` ops, the bulk writes, raw SQL, the
 * transaction block, and `db.query`.
 *
 * Almost the whole family shares one stored skeleton: the target table under
 * `context.dbo.id`, an optional `as`, and the operation's arguments as `input[]`
 * entries. That regularity is what {@link dboOp} exploits — one table-driven
 * decoder covers eleven statements, in the same spirit as `calls.ts`.
 *
 * `db.query` (`mvp:dbo_view`) is the exception and is written out longhand: its
 * arguments are spread across `context.search` (a boolean-expression tree),
 * `context.return` (five differently-shaped return blocks, each with its own
 * sort/paging/distinct sub-schema), `context.bind`, `context.eval`,
 * `context.external` / `context.simpleExternal`, *and* the statement's own
 * output/addon envelope. Every one of those is optional and most carry engine
 * defaults that must be elided to keep the generated call readable (KTD-4).
 *
 * As everywhere in codegen, each decoder is proof-carrying: it builds candidate
 * authoring args, calls the real `s.db.*` factory, and emits source only when the
 * re-encoded statement matches the stored one. Where a default is elided here,
 * that elision is verified rather than assumed.
 */
import type { StackItemXdo, TaggedValue } from "../../types/xdo.js";
import { arr, lit, obj, type Expr } from "../print.js";
import { resolveReference } from "../ref-index.js";
import { decodeValue } from "../value.js";
import { decodeCondition } from "../expression.js";
import { getPath, prove, type SpecialArgs, type SpecialDecoder } from "./prove.js";

/** Coerce a stored `{value, tag, filters}` block to a tagged value. */
function toValue(raw: unknown): TaggedValue | null {
  if (raw === null || typeof raw !== "object") return null;
  const block = raw as { value?: unknown; tag?: unknown; filters?: unknown };
  if (typeof block.tag !== "string" || block.value === undefined) return null;
  return {
    value: block.value as string,
    tag: block.tag as TaggedValue["tag"],
    filters: (Array.isArray(block.filters) ? block.filters : []) as TaggedValue["filters"],
  };
}

/** A stored `const:bool` with no filter chain, as a plain boolean. */
function plainBool(raw: unknown): boolean | null {
  const value = toValue(raw);
  if (!value || value.tag !== "const:bool" || value.filters.length > 0) return null;
  return value.value === "true";
}

/**
 * The `table:` argument for a stored table guid.
 *
 * The source side gets a symbol (or a `{name, guid}` literal); the runtime side
 * always references the table by guid, because `resolveRef` returns an explicit
 * guid verbatim — so proving never depends on whether a symbol was in scope. The
 * indexed name still rides along: `db.add_or_edit` stores it as `context.dbo.as`
 * and `db.query` uses it to alias-qualify aggregate columns.
 */
function tableArg(a: SpecialArgs, guid: string): { expr: Expr; runtime: { name: string; guid: string } } {
  const target = a.refs.lookup(guid);
  return {
    expr: resolveReference(a.ctx, a.refs, guid, { ...a.resolve, unresolved: "object-ref" }),
    runtime: { name: target?.name ?? "", guid },
  };
}

/**
 * The `tableAlias:` argument for a stored `context.dbo.as`.
 *
 * Read by PRESENCE, not compared against the table name: Xano writes this alias
 * on some db statements and omits it on others within the same workspace, so its
 * absence is data too. An alias that does not equal the referenced table's name
 * cannot be reproduced through a symbol reference (the def carries the real
 * name), so `prove` rejects it and the statement falls back — exact, unreadable.
 */
function aliasEntry(stored: unknown): { entry: [string, Expr]; runtime: string } | null {
  const alias = getPath(stored, "dbo.as");
  if (typeof alias !== "string") return null;
  return { entry: ["tableAlias", lit(alias)], runtime: alias };
}

/** One parsed `input[]` entry. */
interface InputEntry {
  readonly name: string;
  readonly value: TaggedValue;
  readonly ignore: boolean;
}

/** Parse `input[]` into name/value/ignore triples, or null if any entry is malformed. */
function inputEntries(stored: StackItemXdo): InputEntry[] | null {
  const list = Array.isArray(stored.input) ? stored.input : [];
  const out: InputEntry[] = [];
  for (const raw of list) {
    const value = toValue(raw);
    const name = (raw as { name?: unknown }).name;
    if (!value || typeof name !== "string") return null;
    out.push({ name, value, ignore: (raw as { ignore?: unknown }).ignore === true });
  }
  return out;
}

/** The column whitelist a statement's `output` envelope carries, if it is customized. */
function outputCols(stored: StackItemXdo): string[] | undefined {
  const output = (stored as { output?: unknown }).output as
    | { customize?: unknown; items?: unknown }
    | undefined;
  if (!output || output.customize !== true) return undefined;
  const items = Array.isArray(output.items) ? output.items : [];
  const names = items.map((item) => (item as { name?: unknown }).name);
  return names.every((n) => typeof n === "string") ? (names as string[]) : undefined;
}

/** Decode one stored addon attachment, recursing into `children`. */
function decodeAddonSpec(
  a: SpecialArgs,
  stored: unknown,
): { expr: Expr; runtime: Record<string, unknown> } | null {
  if (stored === null || typeof stored !== "object") return null;
  const block = stored as Record<string, unknown>;
  const guid = block.id;
  const alias = block.as;
  if (typeof guid !== "string" || typeof alias !== "string") return null;

  // The encoder splits the authored destination at its last dot into
  // `offset` + `as`; rejoining them recovers exactly what was authored, including
  // any `items[]` paging-envelope prefix (whose re-application is idempotent).
  const offset = typeof block.offset === "string" ? block.offset : "";
  const destination = offset ? `${offset}.${alias}` : alias;

  const target = a.refs.lookup(guid);
  const entries: Array<[string, Expr]> = [
    ["addon", resolveReference(a.ctx, a.refs, guid, { ...a.resolve, unresolved: "object-ref" })],
    ["as", lit(destination)],
  ];
  const runtime: Record<string, unknown> = {
    addon: { name: target?.name ?? "", guid },
    as: destination,
  };

  const inputList = Array.isArray(block.input) ? block.input : [];
  if (inputList.length > 0) {
    const cells: Array<[string, Expr]> = [];
    const inputRuntime: Record<string, unknown> = {};
    for (const raw of inputList) {
      const value = toValue(raw);
      const name = (raw as { name?: unknown }).name;
      if (!value || typeof name !== "string") return null;
      cells.push([name, decodeValue(a.ctx, value)]);
      inputRuntime[name] = value;
    }
    entries.push(["input", obj(cells)]);
    runtime.input = inputRuntime;
  }

  const output = block.output as { customize?: unknown; items?: unknown } | undefined;
  if (output?.customize === true) {
    const items = Array.isArray(output.items) ? output.items : [];
    const names = items.map((item) => (item as { name?: unknown }).name);
    if (!names.every((n) => typeof n === "string")) return null;
    entries.push(["output", lit(names)]);
    runtime.output = names;
  }

  const children = Array.isArray(block.children) ? block.children : [];
  if (children.length > 0) {
    const decoded = children.map((child) => decodeAddonSpec(a, child));
    if (decoded.some((d) => d === null)) return null;
    entries.push(["children", arr(decoded.map((d) => d!.expr))]);
    runtime.children = decoded.map((d) => d!.runtime);
  }
  return { expr: obj(entries), runtime };
}

/** Decode the statement's `addon[]` block, or null when it is malformed. */
function decodeAddons(
  a: SpecialArgs,
  stored: StackItemXdo,
): { expr: Expr; runtime: unknown[] } | null {
  const list = (stored as { addon?: unknown }).addon;
  if (!Array.isArray(list) || list.length === 0) return null;
  const decoded = list.map((spec) => decodeAddonSpec(a, spec));
  if (decoded.some((d) => d === null)) return null;
  return { expr: arr(decoded.map((d) => d!.expr)), runtime: decoded.map((d) => d!.runtime) };
}

/** Decode `[{sortBy, orderBy}]` back to the authoring `[{sortBy, dir?}]` form. */
function decodeSort(list: unknown): { expr: Expr; runtime: unknown[] } | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const exprs: Expr[] = [];
  const runtime: unknown[] = [];
  for (const raw of list) {
    const sortBy = (raw as { sortBy?: unknown }).sortBy;
    const orderBy = (raw as { orderBy?: unknown }).orderBy;
    if (typeof sortBy !== "string") return null;
    const cells: Array<[string, Expr]> = [["sortBy", lit(sortBy)]];
    const entry: Record<string, unknown> = { sortBy };
    // `asc` is the encoder's default, so stating it would be noise.
    if (typeof orderBy === "string" && orderBy !== "asc") {
      cells.push(["dir", lit(orderBy)]);
      entry.dir = orderBy;
    }
    exprs.push(obj(cells));
    runtime.push(entry);
  }
  return { expr: arr(exprs), runtime };
}

/**
 * Decode an `eval[]` block (`context.eval`, or an aggregate's `group`/`eval`).
 *
 * `stripAlias` undoes the aggregate qualifier: the encoder prefixes a bare column
 * with the primary table alias, so removing that prefix recovers what was
 * authored and re-qualifies to the identical stored name.
 */
function decodeEvals(
  a: SpecialArgs,
  list: unknown,
  stripAlias = "",
): { expr: Expr; runtime: unknown[] } | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const exprs: Expr[] = [];
  const runtime: unknown[] = [];
  const prefix = stripAlias ? `${stripAlias}.` : "";
  for (const raw of list) {
    const block = raw as { as?: unknown; name?: unknown; filters?: unknown };
    if (typeof block.as !== "string" || typeof block.name !== "string") return null;
    const name = prefix && block.name.startsWith(prefix) ? block.name.slice(prefix.length) : block.name;
    const cells: Array<[string, Expr]> = [
      ["name", lit(name)],
      ["as", lit(block.as)],
    ];
    const entry: Record<string, unknown> = { name, as: block.as };

    const filters = Array.isArray(block.filters) ? block.filters : [];
    if (filters.length > 0) {
      const filterExprs: Expr[] = [];
      const filterRuntime: unknown[] = [];
      for (const step of filters) {
        const stepBlock = step as { name?: unknown; arg?: unknown; disabled?: unknown };
        if (typeof stepBlock.name !== "string") return null;
        const stepCells: Array<[string, Expr]> = [["name", lit(stepBlock.name)]];
        const stepEntry: Record<string, unknown> = { name: stepBlock.name };
        const args = Array.isArray(stepBlock.arg) ? stepBlock.arg : [];
        if (args.length > 0) {
          const values = args.map(toValue);
          if (values.some((v) => v === null)) return null;
          stepCells.push(["arg", arr(values.map((v) => decodeValue(a.ctx, v!)))]);
          stepEntry.arg = values;
        }
        if (stepBlock.disabled === true) {
          stepCells.push(["disabled", lit(true)]);
          stepEntry.disabled = true;
        }
        filterExprs.push(obj(stepCells));
        filterRuntime.push(stepEntry);
      }
      cells.push(["filters", arr(filterExprs)]);
      entry.filters = filterRuntime;
    }
    exprs.push(obj(cells));
    runtime.push(entry);
  }
  return { expr: arr(exprs), runtime };
}

// ---------------------------------------------------------------------------
// The uniform `!map:dbo` operations
// ---------------------------------------------------------------------------

/** How one uniform db op maps its stored `input[]` onto authoring arguments. */
interface DboOpShape {
  /** The `s.` path to emit. */
  readonly path: string;
  /** Consume a leading `field_name`/`field_value` pair as `fieldName`/`fieldValue`. */
  readonly lookup?: boolean;
  /** Named entries mapped straight onto an authoring argument. */
  readonly named?: ReadonlyArray<{
    readonly entry: string;
    readonly arg: string;
    /** A `const:bool` entry decodes to a plain boolean; anything else stays a value. */
    readonly bool?: boolean;
    /**
     * The entry is `?=` in the engine schema, so its ABSENCE is meaningful and
     * must survive: present → emit the argument (even at its default value),
     * absent → omit it. Reading presence rather than comparing to a default is
     * what lets both the lean shape Xano's editor writes and the explicit shape
     * an author asks for round-trip to their own bytes.
     */
    readonly optional?: boolean;
  }>;
  /** Remaining entries become the row-write `data:` list. */
  readonly rowData?: boolean;
  /** The op accepts an `output:` column whitelist. */
  readonly takesOutput?: boolean;
  /** The op accepts `addon:` attachments. */
  readonly takesAddon?: boolean;
}

/** Build a decoder for one uniform `context.dbo.id` + `input[]` operation. */
function dboOp(shape: DboOpShape): SpecialDecoder {
  return (a) => {
    const guid = getPath(a.stored.context, "dbo.id");
    if (typeof guid !== "string" || guid === "") return null;
    const entriesIn = inputEntries(a.stored);
    if (!entriesIn) return null;

    const table = tableArg(a, guid);
    const entries: Array<[string, Expr]> = [["table", table.expr]];
    const runtime: Record<string, unknown> = { table: table.runtime };
    const alias = aliasEntry(a.stored.context);
    if (alias) {
      entries.push(alias.entry);
      runtime.tableAlias = alias.runtime;
    }
    let cursor = 0;

    if (shape.lookup) {
      const fieldName = entriesIn[cursor++];
      const fieldValue = entriesIn[cursor++];
      if (fieldName?.name !== "field_name" || fieldValue?.name !== "field_value") return null;
      if (fieldName.value.tag !== "const" || fieldName.value.filters.length > 0) return null;
      // `id` is the encoder's default lookup column, so naming it adds nothing.
      if (fieldName.value.value !== "id") {
        entries.push(["fieldName", lit(fieldName.value.value)]);
        runtime.fieldName = fieldName.value.value;
      }
      entries.push(["fieldValue", decodeValue(a.ctx, fieldValue.value)]);
      runtime.fieldValue = fieldValue.value;
    }

    for (const spec of shape.named ?? []) {
      const found = entriesIn[cursor];
      if (found?.name !== spec.entry) {
        // An optional entry the engine omitted: skip it without consuming a slot.
        if (spec.optional) continue;
        return null;
      }
      cursor += 1;
      if (spec.bool) {
        const value = plainBool(found.value);
        if (value === null) return null;
        entries.push([spec.arg, lit(value)]);
        runtime[spec.arg] = value;
        continue;
      }
      entries.push([spec.arg, decodeValue(a.ctx, found.value)]);
      runtime[spec.arg] = found.value;
    }

    if (shape.rowData) {
      const rows = entriesIn.slice(cursor);
      cursor = entriesIn.length;
      if (rows.length > 0) {
        const cells = rows.map((row) => {
          const fields: Array<[string, Expr]> = [
            ["name", lit(row.name)],
            ["value", decodeValue(a.ctx, row.value)],
          ];
          if (row.ignore) fields.push(["ignore", lit(true)]);
          return obj(fields);
        });
        entries.push(["data", arr(cells)]);
        runtime.data = rows.map((row) => ({ name: row.name, value: row.value, ignore: row.ignore }));
      }
    }

    // A stored entry no rule accounts for means this is not the shape we think
    // it is — fall through rather than silently dropping it.
    if (cursor !== entriesIn.length) return null;

    if (shape.takesOutput) {
      const cols = outputCols(a.stored);
      if (cols?.length) {
        entries.push(["output", lit(cols)]);
        runtime.output = cols;
      }
    }
    if (shape.takesAddon) {
      const addons = decodeAddons(a, a.stored);
      if (addons) {
        entries.push(["addon", addons.expr]);
        runtime.addon = addons.runtime;
      }
    }

    const as = (a.stored as { as?: unknown }).as;
    if (typeof as === "string" && as !== "") {
      entries.push(["as", lit(as)]);
      runtime.as = as;
    }
    return prove(a.ctx, a.stored, shape.path, [runtime], [obj(entries)]);
  };
}

/**
 * `db.add_or_edit` — the one `!map:dbo` op on the leaner serialization.
 *
 * Its `context.dbo` carries the table's own name beside the guid, its input
 * entries are the lean form, and only the row-data entries carry an `ignore`
 * flag. The table argument must therefore reproduce that stored name, which is
 * why the ref index's name — not an empty placeholder — is what proves here.
 */
const dbAddOrEdit: SpecialDecoder = (a) => {
  const guid = getPath(a.stored.context, "dbo.id");
  if (typeof guid !== "string" || guid === "") return null;
  // `dbo.as` is read by PRESENCE, like every other db statement: it is authored
  // per statement, so its absence is data. Requiring it here (which this decoder
  // used to) made `add_or_edit` the one db statement that could not decode
  // without an alias.
  const alias = aliasEntry(a.stored.context);

  const entriesIn = inputEntries(a.stored);
  if (!entriesIn) return null;
  const [fieldName, fieldValue, ...rows] = entriesIn;
  if (fieldName?.name !== "field_name" || fieldValue?.name !== "field_value") return null;
  if (fieldName.value.tag !== "const" || fieldName.value.filters.length > 0) return null;

  const target = a.refs.lookup(guid);
  const entries: Array<[string, Expr]> = [
    ["table", resolveReference(a.ctx, a.refs, guid, { ...a.resolve, unresolved: "object-ref" })],
  ];
  const runtime: Record<string, unknown> = { table: { name: target?.name ?? "", guid } };
  if (alias) {
    entries.push(alias.entry);
    runtime.tableAlias = alias.runtime;
  }

  if (fieldName.value.value !== "id") {
    entries.push(["fieldName", lit(fieldName.value.value)]);
    runtime.fieldName = fieldName.value.value;
  }
  entries.push(["fieldValue", decodeValue(a.ctx, fieldValue.value)]);
  runtime.fieldValue = fieldValue.value;

  if (rows.length > 0) {
    entries.push([
      "data",
      arr(
        rows.map((row) => {
          const fields: Array<[string, Expr]> = [
            ["name", lit(row.name)],
            ["value", decodeValue(a.ctx, row.value)],
          ];
          if (row.ignore) fields.push(["ignore", lit(true)]);
          return obj(fields);
        }),
      ),
    ]);
    runtime.data = rows.map((row) => ({ name: row.name, value: row.value, ignore: row.ignore }));
  }

  const as = (a.stored as { as?: unknown }).as;
  if (typeof as === "string" && as !== "") {
    entries.push(["as", lit(as)]);
    runtime.as = as;
  }
  return prove(a.ctx, a.stored, "db.add_or_edit", [runtime], [obj(entries)]);
};

// ---------------------------------------------------------------------------
// Raw SQL, bulk writes, and the transaction block
// ---------------------------------------------------------------------------

/** The positional `arg[]` bind values a raw-SQL statement carries. */
function sqlArgs(
  a: SpecialArgs,
  context: Record<string, unknown>,
): { expr: Expr; runtime: TaggedValue[] } | null {
  const list = Array.isArray(context.arg) ? context.arg : [];
  const values = list.map(toValue);
  if (values.some((v) => v === null)) return null;
  return {
    expr: arr(values.map((v) => decodeValue(a.ctx, v!))),
    runtime: values as TaggedValue[],
  };
}

/** Shared decode of the `{code, response_type, arg[]}` raw-SQL context. */
function sqlEntries(
  a: SpecialArgs,
  context: Record<string, unknown>,
): { entries: Array<[string, Expr]>; runtime: Record<string, unknown> } | null {
  if (typeof context.code !== "string") return null;
  const entries: Array<[string, Expr]> = [["sql", lit(context.code)]];
  const runtime: Record<string, unknown> = { sql: context.code };
  // `list` is the encoder's default result shape.
  if (typeof context.response_type === "string" && context.response_type !== "list") {
    entries.push(["responseType", lit(context.response_type)]);
    runtime.responseType = context.response_type;
  }
  const args = sqlArgs(a, context);
  if (!args) return null;
  if (args.runtime.length > 0) {
    entries.push(["args", args.expr]);
    runtime.args = args.runtime;
  }
  return { entries, runtime };
}

/** `db.direct_query` — raw SQL against the workspace database. */
const dbDirectQuery: SpecialDecoder = (a) => {
  const context = (a.stored.context ?? {}) as Record<string, unknown>;
  const decoded = sqlEntries(a, context);
  if (!decoded) return null;
  const as = (a.stored as { as?: unknown }).as;
  if (typeof as === "string" && as !== "") {
    decoded.entries.push(["as", lit(as)]);
    decoded.runtime.as = as;
  }
  return prove(a.ctx, a.stored, "db.direct_query", [decoded.runtime], [obj(decoded.entries)]);
};

/** Stored name → the external engine segment of its `s.` path. */
const EXTERNAL_ENGINES: ReadonlyMap<string, string> = new Map([
  ["mvp:dbo_external_mssql_query", "mssql"],
  ["mvp:dbo_external_mysql_query", "mysql"],
  ["mvp:dbo_external_oracle_query", "oracle"],
  ["mvp:dbo_external_postgres_query", "postgres"],
  ["mvp:dbo_external_snowflake_query", "snowflake"],
]);

/** `db.external.<engine>.direct_query` — raw SQL against an external database. */
function externalQuery(engine: string): SpecialDecoder {
  return (a) => {
    const context = (a.stored.context ?? {}) as Record<string, unknown>;
    const decoded = sqlEntries(a, context);
    if (!decoded) return null;
    // The connection string rides `connection_string_flex`, not `connection_string`.
    const connection = toValue(context.connection_string_flex);
    if (!connection) return null;
    decoded.entries.splice(1, 0, ["connectionString", decodeValue(a.ctx, connection)]);
    decoded.runtime.connectionString = connection;

    const as = (a.stored as { as?: unknown }).as;
    if (typeof as === "string" && as !== "") {
      decoded.entries.push(["as", lit(as)]);
      decoded.runtime.as = as;
    }
    return prove(
      a.ctx,
      a.stored,
      `db.external.${engine}.direct_query`,
      [decoded.runtime],
      [obj(decoded.entries)],
    );
  };
}

/** `db.bulk.delete` — the one bulk op whose filter rides `context.search`. */
const dbBulkDelete: SpecialDecoder = (a) => {
  const context = (a.stored.context ?? {}) as Record<string, unknown>;
  const guid = getPath(context, "dbo.id");
  if (typeof guid !== "string" || guid === "") return null;
  const table = tableArg(a, guid);
  const entries: Array<[string, Expr]> = [["table", table.expr]];
  const runtime: Record<string, unknown> = { table: table.runtime };
  const alias = aliasEntry(context);
  if (alias) {
    entries.push(alias.entry);
    runtime.tableAlias = alias.runtime;
  }

  if (context.search !== undefined) {
    const where = decodeWhere(a, context.search);
    if (!where) return null;
    entries.push(["where", where.expr]);
    runtime.where = where.runtime;
  }
  const as = (a.stored as { as?: unknown }).as;
  if (typeof as === "string" && as !== "") {
    entries.push(["as", lit(as)]);
    runtime.as = as;
  }
  return prove(a.ctx, a.stored, "db.bulk.delete", [runtime], [obj(entries)]);
};

/** `db.transaction { … }` — a pure block statement over a nested `run[]`. */
const dbTransaction: SpecialDecoder = (a) => {
  const body = a.decodeStack(getPath(a.stored.context, "run"));
  return prove(
    a.ctx,
    a.stored,
    "db.transaction",
    [{ body: body.statements }],
    [obj([["body", arr(body.exprs)]])],
  );
};

// ---------------------------------------------------------------------------
// `db.query` — the wide one
// ---------------------------------------------------------------------------

/**
 * Decode a stored `where`: an `{expression: […]}` tree through the shared
 * boolean-expression inverse, or a raw `Value` escape hatch passed through.
 */
function decodeWhere(a: SpecialArgs, stored: unknown): { expr: Expr; runtime: unknown } | null {
  const condition = decodeCondition(a.ctx, stored);
  if (condition) return { expr: condition.expr, runtime: condition.runtime };
  const value = toValue(stored);
  if (!value) return null;
  return { expr: decodeValue(a.ctx, value), runtime: value };
}

/** A persisted int, whether serialized as a number or as a numeric string. */
function numberOf(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v !== "" && /^-?\d+$/.test(v)) return Number(v);
  return undefined;
}

/** The paging fields a query recovers, split between the static block and `simpleExternal`. */
function decodePaging(
  a: SpecialArgs,
  block: Record<string, unknown>,
  simple: Record<string, unknown>,
  fields: readonly (readonly [key: "page" | "per_page" | "offset", fallback: number])[],
): { entries: Array<[string, Expr]>; runtime: Record<string, unknown> } | null {
  const entries: Array<[string, Expr]> = [];
  const runtime: Record<string, unknown> = {};
  for (const [key, fallback] of fields) {
    // An input-bound field lives in `simpleExternal` and shadows the static
    // baseline, which stays at its engine default in that case.
    if (simple[key] !== undefined) {
      const value = toValue(simple[key]);
      if (!value) return null;
      entries.push([key, decodeValue(a.ctx, value)]);
      runtime[key] = value;
      continue;
    }
    // The engine's schema types these `int`, but a persisted value can arrive as
    // a numeric STRING — the same serialization artifact `normalize` absorbs for
    // tagged `value`/`arg`. Requiring a number here silently skipped the field, so
    // the re-encode fell back to the engine default and the whole query degraded
    // to `raw()` over a paging size the SDK had read but discarded.
    const stored = numberOf(block[key]);
    if (stored !== undefined && stored !== fallback) {
      entries.push([key, lit(stored)]);
      runtime[key] = stored;
    }
  }
  return { entries, runtime };
}

/** `db.query` — the full query-all surface. */
const dbQuery: SpecialDecoder = (a) => {
  const context = (a.stored.context ?? {}) as Record<string, unknown>;
  const guid = getPath(context, "dbo.id");
  if (typeof guid !== "string" || guid === "") return null;
  if (Array.isArray(a.stored.input) && a.stored.input.length > 0) return null;

  const table = tableArg(a, guid);
  const entries: Array<[string, Expr]> = [["table", table.expr]];
  const runtime: Record<string, unknown> = { table: table.runtime };
  const alias = aliasEntry(context);
  if (alias) {
    entries.push(alias.entry);
    runtime.tableAlias = alias.runtime;
  }

  const ret = (context.return ?? {}) as Record<string, unknown>;
  const returnType = typeof ret.type === "string" ? ret.type : "list";
  if (returnType !== "list") {
    entries.push(["returnType", lit(returnType)]);
    runtime.returnType = returnType;
  }

  if (context.search !== undefined) {
    const where = decodeWhere(a, context.search);
    if (!where) return null;
    entries.push(["where", where.expr]);
    runtime.where = where.runtime;
  }

  if (context.bind !== undefined) {
    if (!Array.isArray(context.bind)) return null;
    const bindExprs: Expr[] = [];
    const bindRuntime: unknown[] = [];
    for (const stored of context.bind) {
      const bindGuid = getPath(stored, "dbo.id");
      const bindAlias = getPath(stored, "dbo.as");
      if (typeof bindGuid !== "string") return null;
      const joined = tableArg(a, bindGuid);
      const cells: Array<[string, Expr]> = [["table", joined.expr]];
      const entry: Record<string, unknown> = { table: joined.runtime };
      // The alias defaults to the joined table's own name.
      if (typeof bindAlias === "string" && bindAlias !== joined.runtime.name) {
        cells.push(["as", lit(bindAlias)]);
        entry.as = bindAlias;
      }
      const join = (stored as { join?: unknown }).join;
      if (typeof join === "string" && join !== "inner") {
        cells.push(["join", lit(join)]);
        entry.join = join;
      }
      const search = (stored as { search?: unknown }).search;
      if (search !== undefined) {
        const where = decodeWhere(a, search);
        if (!where) return null;
        cells.push(["where", where.expr]);
        entry.where = where.runtime;
      }
      bindExprs.push(obj(cells));
      bindRuntime.push(entry);
    }
    entries.push(["bind", arr(bindExprs)]);
    runtime.bind = bindRuntime;
  }

  if (context.eval !== undefined) {
    const evals = decodeEvals(a, context.eval);
    if (!evals) return null;
    entries.push(["eval", evals.expr]);
    runtime.eval = evals.runtime;
  }

  if (context.lock !== undefined) {
    const lock = plainBool(context.lock);
    if (lock === null) return null;
    entries.push(["lock", lit(lock)]);
    runtime.lock = lock;
  }

  const simple = (context.simpleExternal ?? {}) as Record<string, unknown>;
  const pagingEntries: Array<[string, Expr]> = [];
  const pagingRuntime: Record<string, unknown> = {};
  let sortBlock: unknown;
  let distinct: unknown;

  if (returnType === "single") {
    sortBlock = getPath(ret, "single.sort");
  } else if (returnType === "stream") {
    sortBlock = getPath(ret, "stream.sort");
    distinct = getPath(ret, "stream.distinct");
    const block = (getPath(ret, "stream.paging") ?? {}) as Record<string, unknown>;
    const paging = decodePaging(a, block, simple, [
      ["page", 1],
      ["per_page", 25],
    ]);
    if (!paging) return null;
    pagingEntries.push(...paging.entries);
    Object.assign(pagingRuntime, paging.runtime);
  } else if (returnType === "aggregate") {
    sortBlock = getPath(ret, "aggregate.sort");
  } else if (returnType === "list") {
    sortBlock = getPath(ret, "list.sort");
    distinct = getPath(ret, "list.distinct");
    const block = (getPath(ret, "list.paging") ?? {}) as Record<string, unknown>;
    const paging = decodePaging(a, block, simple, [
      ["page", 1],
      ["per_page", 25],
      ["offset", 0],
    ]);
    if (!paging) return null;
    pagingEntries.push(...paging.entries);
    Object.assign(pagingRuntime, paging.runtime);
    if (block.metadata === false) {
      pagingEntries.push(["metadata", lit(false)]);
      pagingRuntime.metadata = false;
    }
    if (block.totals === true) {
      pagingEntries.push(["totals", lit(true)]);
      pagingRuntime.totals = true;
    }
  }

  // `search`/`sort` overrides are input-bound only — they have no static
  // counterpart, so they come straight off `simpleExternal`.
  for (const key of ["search", "sort"] as const) {
    if (simple[key] === undefined) continue;
    const value = toValue(simple[key]);
    if (!value) return null;
    pagingEntries.push([key, decodeValue(a.ctx, value)]);
    pagingRuntime[key] = value;
  }

  if (returnType !== "aggregate") {
    const sort = decodeSort(sortBlock);
    if (sort) {
      entries.push(["sort", sort.expr]);
      runtime.sort = sort.runtime;
    }
  }
  if (pagingEntries.length > 0) {
    entries.push(["paging", obj(pagingEntries)]);
    runtime.paging = pagingRuntime;
  }
  if (context.external !== undefined) {
    const external = decodeExternal(a, context.external);
    if (!external) return null;
    entries.push(["external", external.expr]);
    runtime.external = external.runtime;
  }
  // `auto` is the encoder's default and is written unconditionally.
  if (typeof distinct === "string" && distinct !== "auto") {
    entries.push(["distinct", lit(distinct)]);
    runtime.distinct = distinct;
  }

  if (returnType === "aggregate") {
    const aggregate = decodeAggregate(a, ret, table.runtime.name, sortBlock);
    if (!aggregate) return null;
    entries.push(["aggregate", aggregate.expr]);
    runtime.aggregate = aggregate.runtime;
  }

  const cols = outputCols(a.stored);
  if (cols?.length) {
    entries.push(["output", lit(cols)]);
    runtime.output = cols;
  }
  const addons = decodeAddons(a, a.stored);
  if (addons) {
    entries.push(["addon", addons.expr]);
    runtime.addon = addons.runtime;
  }
  const as = (a.stored as { as?: unknown }).as;
  if (typeof as === "string" && as !== "") {
    entries.push(["as", lit(as)]);
    runtime.as = as;
  }
  return prove(a.ctx, a.stored, "db.query", [runtime], [obj(entries)]);
};

/** Decode the classic single-blob `context.external` override. */
function decodeExternal(
  a: SpecialArgs,
  stored: unknown,
): { expr: Expr; runtime: Record<string, unknown> } | null {
  const value = toValue(stored);
  if (!value) return null;
  const entries: Array<[string, Expr]> = [["value", decodeValue(a.ctx, value)]];
  const runtime: Record<string, unknown> = { value };

  const permissions = (stored as { permissions?: unknown }).permissions as
    | Record<string, unknown>
    | undefined;
  // Engine defaults, written unconditionally by the encoder — only a deviation
  // needs to be authored back.
  const defaults: ReadonlyArray<readonly [string, boolean]> = [
    ["search", true],
    ["sort", true],
    ["page", true],
    ["per_page", false],
  ];
  if (permissions) {
    const cells: Array<[string, Expr]> = [];
    const gates: Record<string, boolean> = {};
    for (const [key, fallback] of defaults) {
      const gate = permissions[key];
      if (typeof gate !== "boolean") return null;
      if (gate !== fallback) {
        cells.push([key, lit(gate)]);
        gates[key] = gate;
      }
    }
    if (cells.length > 0) {
      entries.push(["permissions", obj(cells)]);
      runtime.permissions = gates;
    }
  }
  return { expr: obj(entries), runtime };
}

/** Decode `context.return.aggregate` — group/eval aliases, sort, and paging. */
function decodeAggregate(
  a: SpecialArgs,
  ret: Record<string, unknown>,
  primaryAlias: string,
  sortBlock: unknown,
): { expr: Expr; runtime: Record<string, unknown> } | null {
  const entries: Array<[string, Expr]> = [];
  const runtime: Record<string, unknown> = {};

  const group = decodeEvals(a, getPath(ret, "aggregate.group"), primaryAlias);
  if (group) {
    entries.push(["group", group.expr]);
    runtime.group = group.runtime;
  }
  const evals = decodeEvals(a, getPath(ret, "aggregate.eval"), primaryAlias);
  if (evals) {
    entries.push(["eval", evals.expr]);
    runtime.eval = evals.runtime;
  }
  const sort = decodeSort(sortBlock);
  if (sort) {
    entries.push(["sort", sort.expr]);
    runtime.sort = sort.runtime;
  }
  const paging = getPath(ret, "aggregate.paging") as Record<string, unknown> | undefined;
  if (paging) {
    const cells: Array<[string, Expr]> = [];
    const values: Record<string, unknown> = {};
    if (typeof paging.page === "number" && paging.page !== 1) {
      cells.push(["page", lit(paging.page)]);
      values.page = paging.page;
    }
    if (typeof paging.per_page === "number" && paging.per_page !== 25) {
      cells.push(["per_page", lit(paging.per_page)]);
      values.per_page = paging.per_page;
    }
    if (paging.metadata === false) {
      cells.push(["metadata", lit(false)]);
      values.metadata = false;
    }
    // An aggregate `paging` block exists only when it was authored, so the key
    // is emitted even when every field sits at its default.
    entries.push(["paging", obj(cells)]);
    runtime.paging = values;
  }
  return { expr: obj(entries), runtime };
}

/** Database-family decoders by stored name. */
export const DB_DECODERS: ReadonlyMap<string, SpecialDecoder> = new Map<string, SpecialDecoder>([
  [
    "mvp:dbo_getby",
    dboOp({
      path: "db.get",
      lookup: true,
      named: [{ entry: "lock", arg: "lock", bool: true, optional: true }],
      takesOutput: true,
      takesAddon: true,
    }),
  ],
  ["mvp:dbo_delby", dboOp({ path: "db.del", lookup: true })],
  ["mvp:dbo_hasby", dboOp({ path: "db.has", lookup: true })],
  [
    "mvp:dbo_patch",
    dboOp({
      path: "db.patch",
      lookup: true,
      named: [{ entry: "item", arg: "data" }],
      takesAddon: true,
    }),
  ],
  ["mvp:dbo_truncate", dboOp({ path: "db.truncate", named: [{ entry: "reset", arg: "reset", bool: true, optional: true }] })],
  ["mvp:dbo_get_schema", dboOp({ path: "db.schema", named: [{ entry: "path", arg: "path" }] })],
  ["mvp:dbo_add", dboOp({ path: "db.add", rowData: true, takesAddon: true })],
  ["mvp:dbo_editby", dboOp({ path: "db.edit", lookup: true, rowData: true, takesAddon: true })],
  ["mvp:dbo_addoreditby", dbAddOrEdit],
  [
    "mvp:dbo_bulkadd",
    dboOp({
      path: "db.bulk.add",
      named: [
        { entry: "allow_id_field", arg: "allowIdField", bool: true, optional: true },
        { entry: "items", arg: "items" },
      ],
    }),
  ],
  ["mvp:dbo_bulkpatch", dboOp({ path: "db.bulk.patch", named: [{ entry: "items", arg: "items" }] })],
  ["mvp:dbo_bulkupdate", dboOp({ path: "db.bulk.update", named: [{ entry: "items", arg: "items" }] })],
  ["mvp:dbo_bulkdelete", dbBulkDelete],
  ["mvp:dbo_direct_query", dbDirectQuery],
  ["mvp:db_transaction", dbTransaction],
  ["mvp:dbo_view", dbQuery],
  ...[...EXTERNAL_ENGINES].map(
    ([name, engine]) => [name, externalQuery(engine)] as [string, SpecialDecoder],
  ),
]);
