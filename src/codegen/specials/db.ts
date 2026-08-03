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
import { configuredDeadReturnBlocks, isDefaultEnvelopeMember } from "../../validate/normalize.js";
import { outputPaths } from "../../statements/special/output-select.js";
import { arr, lit, obj, type Expr } from "../print.js";
import { isBoundNumericId, isReferenceId, isUnboundId, resolveReference } from "../ref-index.js";
import { decodeValue } from "../value.js";
import { decodeCondition } from "../expression.js";
import {
  blankRefDetail,
  declineHere,
  getPath,
  prove,
  type SpecialArgs,
  type SpecialDecoder,
} from "./prove.js";

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

/**
 * True when a stored `context` member holds the empty default the engine writes
 * unconditionally, so authoring nothing re-encodes to the same bytes.
 *
 * The engine fills `search` / `bind` / `eval` on a query that filters, joins, and
 * computes nothing; the SDK's encoder omits them (`if (search !== undefined)`).
 * `normalize` already reconciles that by dropping such a member from **both**
 * sides, so the only correct reading of one is "not authored" — and the test is
 * delegated to the normalizer rather than restated here, which is what keeps the
 * decoder and the comparison it will be judged by from drifting apart.
 *
 * Reading them as a filter this decoder failed to parse is what cost 113 of 201
 * fallen-back `db.query` statements their readability.
 */
function isUnauthored(key: string, value: unknown): boolean {
  return value === undefined || isDefaultEnvelopeMember(key, value);
}

/** A stored `const:bool` with no filter chain, as a plain boolean. */
function plainBool(raw: unknown): boolean | null {
  const value = toValue(raw);
  if (!value || value.tag !== "const:bool" || value.filters.length > 0) return null;
  return value.value === "true";
}

/** A recovered `table:` argument — a bound reference, or `null` when unbound. */
interface TableArg {
  readonly expr: Expr;
  readonly runtime: { name: string; guid: string } | null;
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
function tableArg(a: SpecialArgs, guid: string): TableArg {
  const target = a.refs.lookup(guid);
  return {
    expr: resolveReference(a.ctx, a.refs, guid, { ...a.resolve, unresolved: "object-ref" }),
    runtime: { name: target?.name ?? "", guid },
  };
}

/**
 * A blank `context.dbo.id` — recovered as `table: null`, and REPORTED.
 *
 * The bytes are faithful either way (`raw()` would carry the same blank), and the
 * authoring surface models the unbound state deliberately as `table: null` — the
 * same contract an addon's `table` has carried all along. Reading it as "nothing
 * to recover" degraded 83 db statements to `raw()` across the sweep.
 *
 * **It reports rather than emitting quietly**, because a blank binding is a
 * defect in the workspace and `table: null` is the faithful rendering of one —
 * emitting it silently would let a lost binding pass as a deliberate choice.
 * There is one reading and no hedge: this flow pulls whole workspaces, so a
 * blank reference cannot be a live target that merely sat outside the export
 * (see {@link blankRefDetail}). Same contract the realtime kinds already hold
 * blank bindings to (`test/codegen/realtime-blank-refs`), applied consistently.
 *
 * The alias is left to {@link aliasEntry}, which reads `dbo.as` by presence: a
 * deleted table's alias frequently outlives it (`{as: "user", id: ""}`).
 */
function unboundTableArg(a: SpecialArgs, what: string): TableArg {
  a.ctx.problem("unresolved-ref", blankRefDetail(`${what} has a blank table reference`, "table"));
  return { expr: lit(null), runtime: null };
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

/**
 * The `enforceHiddenFields:` argument for a stored `context.enforce_hidden_fields`.
 *
 * Read by VALUE rather than presence, because this one has a real default: the
 * engine declares `enforce_hidden_fields?=false` and three statement classes read
 * it as `?? false`, so absent and `false` are the same OFF and only `true` is
 * worth authoring. All 557 stored `dbo_add` statements in the offline corpus omit
 * it entirely; the flag showed up on a current instance.
 *
 * Returning null for a stored `false` is what keeps the round trip exact — the
 * encoder writes the key only when on, so recovering `enforceHiddenFields: false`
 * would re-encode to an absent key and fail its own proof.
 *
 * A stored `false` therefore falls back to `raw()`, and that is deliberate. The
 * engine's side of "absent means false" is evidenced twice over, but invariant 2
 * wants the other half too — a real workspace storing the key present-at-default
 * beside one omitting it — and no workspace does: 557 stored `dbo_add` statements
 * omit it and the only one that writes it writes `true`. Normalizing a spelling
 * nothing produces would be modelling on an analogy. If it ever shows up, the
 * fallback now names the exact key, which is the whole point of the report.
 */
function enforceHiddenFieldsEntry(
  stored: unknown,
): { entry: [string, Expr]; runtime: boolean } | null {
  return getPath(stored, "enforce_hidden_fields") === true
    ? { entry: ["enforceHiddenFields", lit(true)], runtime: true }
    : null;
}

/** One parsed `input[]` entry, with the sub-entries of an expanded one. */
interface InputEntry {
  readonly name: string;
  readonly value: TaggedValue;
  readonly ignore: boolean;
  readonly children: InputEntry[];
}

/**
 * Parse `input[]` into name/value/ignore entries, recursing into the `children`
 * of an expanded one, or null if any entry is malformed.
 *
 * `expand` and `children` must agree, because the encoder derives `expand` from
 * "has children" and so cannot reproduce a tree where they disagree. Neither
 * disagreeing combination occurs in the wild; declining keeps them recorded as
 * `raw()` rather than re-encoded into a shape that differs from what is stored.
 */
function inputEntries(stored: StackItemXdo): InputEntry[] | null {
  return parseEntries(stored.input, "input[]");
}

function parseEntries(list: unknown, path: string): InputEntry[] | null {
  const out: InputEntry[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const value = toValue(raw);
    const name = (raw as { name?: unknown }).name;
    if (!value || typeof name !== "string")
      return declineHere(`${path}: entry is not a named tagged value`);
    const rawChildren = (raw as { children?: unknown }).children;
    const expand = (raw as { expand?: unknown }).expand === true;
    const hasChildren = Array.isArray(rawChildren) && rawChildren.length > 0;
    if (expand !== hasChildren)
      return declineHere(`${path}: "expand" disagrees with "children"`);
    const children = hasChildren ? parseEntries(rawChildren, `${path}.children[]`) : [];
    if (!children) return null;
    out.push({
      name,
      value,
      ignore: (raw as { ignore?: unknown }).ignore === true,
      children,
    });
  }
  return out;
}

/**
 * The column whitelist a statement's `output` envelope carries, if it is
 * customized — as the dotted paths that re-encode to the stored tree, so a
 * nested selection (sub-keys of an object column) survives the round trip.
 * `undefined` for an uncustomized block; a customized block the path form cannot
 * express returns `undefined` too, which leaves the block unaccounted and lets
 * `prove` decline rather than emitting a selection that drops keys.
 */
function outputCols(stored: StackItemXdo): string[] | undefined {
  const output = (stored as { output?: unknown }).output as
    | { customize?: unknown; items?: unknown }
    | undefined;
  if (!output || output.customize !== true) return undefined;
  return outputPaths(output.items ?? []) ?? undefined;
}

/**
 * Only row-data entries have an authored home for sub-entries or an `ignore`
 * flag. A lookup or named entry that carries either would re-encode without it,
 * so this declines with a label rather than letting `prove` report it as an
 * anonymous byte difference.
 *
 * `ignore` is not exhaust on these entries — it is honoured. The engine walks
 * every statement's `input[]` through ONE generic routine that knows nothing
 * about which slot an entry fills: a flagged entry is recorded as
 * `"<name>:ignore"` and then skipped, so it never reaches the statement and
 * never joins the input whitelist. On a lookup that means `field_name` or
 * `field_value` is simply not passed. That is a real (if broken-looking) stored
 * state, and `raw()` preserves it rather than re-encoding a statement that
 * would suddenly start passing the entry.
 */
function plainEntry(row: InputEntry, path: string): boolean {
  if (row.children.length > 0) {
    declineHere(`${path}: "${row.name}" carries sub-entries, which only row data can hold`);
    return false;
  }
  if (row.ignore) {
    declineHere(
      `${path}: "${row.name}" is flagged \`ignore\`, which only row data can hold — the engine ` +
        `drops the entry, so it is not passed at all`,
    );
    return false;
  }
  return true;
}

/**
 * One row-write entry as authored `data:` — `{name, value}`, plus `ignore` when
 * set and `children` when the entry is expanded. Shared by every op that carries
 * row data so the nested form cannot decode one way here and another there.
 */
function rowCell(
  a: SpecialArgs,
  row: InputEntry,
): { expr: Expr; runtime: Record<string, unknown> } {
  const fields: Array<[string, Expr]> = [
    ["name", lit(row.name)],
    ["value", decodeValue(a.ctx, row.value)],
  ];
  const runtime: Record<string, unknown> = { name: row.name, value: row.value };
  if (row.ignore) {
    fields.push(["ignore", lit(true)]);
    runtime.ignore = true;
  }
  if (row.children.length > 0) {
    const children = row.children.map((child) => rowCell(a, child));
    fields.push(["children", arr(children.map((child) => child.expr))]);
    runtime.children = children.map((child) => child.runtime);
  }
  return { expr: obj(fields), runtime };
}

/** Decode one stored addon attachment, recursing into `children`. */
function decodeAddonSpec(
  a: SpecialArgs,
  stored: unknown,
): { expr: Expr; runtime: Record<string, unknown> } | null {
  if (stored === null || typeof stored !== "object")
    return declineHere("addon[]: attachment is not an object");
  const block = stored as Record<string, unknown>;
  const guid = block.id;
  const alias = block.as;
  // A NUMERIC id is a bound row reference, not portable identity — the same
  // settled case the call family declines by name, and the only shape in the
  // survey corpus that reaches this guard (3 attachments; every other one
  // carries a string id, blank or otherwise). It was reported as "has no id",
  // which is false and sent the reader looking for a missing key.
  if (typeof guid === "number" && isBoundNumericId(guid))
    return declineHere(
      `addon[]: attachment id ${JSON.stringify(guid)} is a numeric object reference, not portable identity`,
    );
  if ((typeof guid !== "string" && typeof guid !== "number") || typeof alias !== "string")
    return declineHere("addon[]: attachment has no id or no as");

  // The encoder splits the authored destination at its last dot into
  // `offset` + `as`; rejoining them recovers exactly what was authored, including
  // any `items[]` paging-envelope prefix (whose re-application is idempotent).
  const offset = typeof block.offset === "string" ? block.offset : "";
  const destination = offset ? `${offset}.${alias}` : alias;

  // An UNBOUND id is an attachment whose addon was deleted or never bound.
  // Resolving it threw inside the factory, which degraded the whole enclosing
  // query to `raw()`; `addon: null` is the same "no target" spelling `table:
  // null` and `fn: null` already carry, and it keeps the query readable.
  //
  // Both stored spellings of "no target" count — the blank string and the
  // numeric `0` a pre-guid attachment carries. A numeric id that is NOT the
  // sentinel already declined above, so this reads no identity out of a number;
  // it only recognizes the absence of one.
  const unbound = isUnboundId(guid);
  const target = unbound ? undefined : a.refs.lookup(guid as string);
  // Reported for the same reason a blank `table` is: the two causes — deleted or
  // never bound vs. blanked on the way out of a narrow export — are
  // indistinguishable here, and emitting `addon: null` silently would present a
  // real lost binding as a deliberate one.
  if (unbound) {
    a.ctx.problem(
      "unresolved-ref",
      blankRefDetail(`addon attachment "${alias}" has a blank addon reference`, "addon"),
    );
  }
  const entries: Array<[string, Expr]> = [
    [
      "addon",
      unbound
        ? lit(null)
        : resolveReference(a.ctx, a.refs, guid as string, { ...a.resolve, unresolved: "object-ref" }),
    ],
    ["as", lit(destination)],
  ];
  const runtime: Record<string, unknown> = {
    addon: unbound ? null : { name: target?.name ?? "", guid: guid as string },
    as: destination,
  };

  const inputList = Array.isArray(block.input) ? block.input : [];
  if (inputList.length > 0) {
    const cells: Array<[string, Expr]> = [];
    const inputRuntime: Record<string, unknown> = {};
    for (const raw of inputList) {
      const value = toValue(raw);
      const name = (raw as { name?: unknown }).name;
      if (!value || typeof name !== "string")
        return declineHere("addon[].input[]: entry is not a named tagged value");
      cells.push([name, decodeValue(a.ctx, value)]);
      inputRuntime[name] = value;
    }
    entries.push(["input", obj(cells)]);
    runtime.input = inputRuntime;
  }

  const output = block.output as { customize?: unknown; items?: unknown } | undefined;
  if (output?.customize === true) {
    const paths = outputPaths(output.items ?? []);
    if (!paths)
      return declineHere("addon[].output.items[]: column selection is not a name tree");
    entries.push(["output", lit(paths)]);
    runtime.output = paths;
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
    if (typeof sortBy !== "string") return declineHere("sort[]: entry has no sortBy");
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
    if (typeof block.as !== "string" || typeof block.name !== "string")
      return declineHere("eval[]: entry has no name or no as");
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
        if (typeof stepBlock.name !== "string")
          return declineHere("eval[].filters[]: step has no name");
        const stepCells: Array<[string, Expr]> = [["name", lit(stepBlock.name)]];
        const stepEntry: Record<string, unknown> = { name: stepBlock.name };
        const args = Array.isArray(stepBlock.arg) ? stepBlock.arg : [];
        if (args.length > 0) {
          const values = args.map(toValue);
          if (values.some((v) => v === null))
            return declineHere("eval[].filters[].arg[]: argument is not a tagged value");
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
    const storedId = getPath(a.stored.context, "dbo.id");
    if (!isReferenceId(storedId))
      return declineHere(`${shape.path}: context.dbo.id is not a reference id`);
    if (isBoundNumericId(storedId))
      return declineHere(`${shape.path}: context.dbo.id is a numeric object reference`);
    const entriesIn = inputEntries(a.stored);
    if (!entriesIn) return null;

    const table = isUnboundId(storedId)
      ? unboundTableArg(a, shape.path)
      : tableArg(a, String(storedId));
    const entries: Array<[string, Expr]> = [["table", table.expr]];
    const runtime: Record<string, unknown> = { table: table.runtime };
    const alias = aliasEntry(a.stored.context);
    if (alias) {
      entries.push(alias.entry);
      runtime.tableAlias = alias.runtime;
    }
    const enforce = enforceHiddenFieldsEntry(a.stored.context);
    if (enforce) {
      entries.push(enforce.entry);
      runtime.enforceHiddenFields = enforce.runtime;
    }
    let cursor = 0;

    if (shape.lookup) {
      const fieldName = entriesIn[cursor++];
      const fieldValue = entriesIn[cursor++];
      if (fieldName?.name !== "field_name" || fieldValue?.name !== "field_value")
        return declineHere(`${shape.path}: input[] does not lead with field_name/field_value`);
      if (fieldName.value.tag !== "const" || fieldName.value.filters.length > 0)
        return declineHere(`${shape.path}: field_name is not a bare constant`);
      if (!plainEntry(fieldName, shape.path) || !plainEntry(fieldValue, shape.path)) return null;
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
        return declineHere(`${shape.path}: input[] is missing required "${spec.entry}"`);
      }
      cursor += 1;
      if (!plainEntry(found, shape.path)) return null;
      if (spec.bool) {
        const value = plainBool(found.value);
        if (value === null)
          return declineHere(`${shape.path}: "${spec.entry}" is not a bare boolean constant`);
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
        const cells = rows.map((row) => rowCell(a, row));
        entries.push(["data", arr(cells.map((cell) => cell.expr))]);
        runtime.data = cells.map((cell) => cell.runtime);
      }
    }

    // A stored entry no rule accounts for means this is not the shape we think
    // it is — fall through rather than silently dropping it.
    if (cursor !== entriesIn.length)
      return declineHere(
        `${shape.path}: input[] carries ${entriesIn.length - cursor} unaccounted entries ` +
          `(first: "${entriesIn[cursor]?.name ?? ""}")`,
      );

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
  const storedId = getPath(a.stored.context, "dbo.id");
  if (!isReferenceId(storedId))
    return declineHere("db.add_or_edit: context.dbo.id is not a reference id");
  if (isBoundNumericId(storedId))
    return declineHere("db.add_or_edit: context.dbo.id is a numeric object reference");
  // `dbo.as` is read by PRESENCE, like every other db statement: it is authored
  // per statement, so its absence is data. Requiring it here (which this decoder
  // used to) made `add_or_edit` the one db statement that could not decode
  // without an alias.
  const alias = aliasEntry(a.stored.context);

  const entriesIn = inputEntries(a.stored);
  if (!entriesIn) return null;
  const [fieldName, fieldValue, ...rows] = entriesIn;
  if (fieldName?.name !== "field_name" || fieldValue?.name !== "field_value")
    return declineHere("db.add_or_edit: input[] does not lead with field_name/field_value");
  if (fieldName.value.tag !== "const" || fieldName.value.filters.length > 0)
    return declineHere("db.add_or_edit: field_name is not a bare constant");
  if (!plainEntry(fieldName, "db.add_or_edit") || !plainEntry(fieldValue, "db.add_or_edit"))
    return null;

  // Through the shared table argument like the rest of the family, which is what
  // gives this one the unbound state too — it used to resolve the guid inline.
  const table = isUnboundId(storedId)
    ? unboundTableArg(a, "db.add_or_edit")
    : tableArg(a, String(storedId));
  const entries: Array<[string, Expr]> = [["table", table.expr]];
  const runtime: Record<string, unknown> = { table: table.runtime };
  if (alias) {
    entries.push(alias.entry);
    runtime.tableAlias = alias.runtime;
  }
  const enforce = enforceHiddenFieldsEntry(a.stored.context);
  if (enforce) {
    entries.push(enforce.entry);
    runtime.enforceHiddenFields = enforce.runtime;
  }

  if (fieldName.value.value !== "id") {
    entries.push(["fieldName", lit(fieldName.value.value)]);
    runtime.fieldName = fieldName.value.value;
  }
  entries.push(["fieldValue", decodeValue(a.ctx, fieldValue.value)]);
  runtime.fieldValue = fieldValue.value;

  if (rows.length > 0) {
    const cells = rows.map((row) => rowCell(a, row));
    entries.push(["data", arr(cells.map((cell) => cell.expr))]);
    runtime.data = cells.map((cell) => cell.runtime);
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
  if (values.some((v) => v === null))
    return declineHere("raw SQL: context.arg[] holds a non-tagged value");
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
  // An UNCONFIGURED statement — the engine writes `context: {}` for one that was
  // dropped into a stack and never filled in, and all 6 in the survey corpus are
  // that, not a malformed `code`. Left as `raw()` deliberately, and the two
  // halves have DIFFERENT reasons — read them before re-opening this:
  //
  //  - The five external-engine variants declare `connection_string_flex` as a
  //    NESTED object, and the optional-schema pass defaults a nested member to
  //    the literal string `"{}"` rather than materializing it (see the note by
  //    {@link filledContext}). There is nothing to recover, full stop.
  //  - `mvp:dbo_direct_query` is different: its context is `{code, response_type
  //    ?=list, parser?=prepared, arg[]?=[]}` — every member a scalar or a list,
  //    so the engine DOES supply them all and the state is in principle
  //    recoverable. What stops it is shape, not evidence: {@link
  //    EMPTY_CONTEXT_FILL} fills a context that IS a tagged value, and this one
  //    is a plain multi-member record. Closing it means a second fill shape for
  //    one row of a statement that has no SQL in it either way.
  if (context.code === undefined && Object.keys(context).length === 0) {
    declineHere("raw SQL: context is empty — the statement was never configured");
    return a.ctx.declined(
      "the statement stores an entirely empty context — it was added to the stack and never " +
        "configured, so there is no SQL and no connection to recover. `raw()` is what an " +
        "unconfigured stub looks like",
    );
  }
  if (typeof context.code !== "string") return declineHere("raw SQL: context.code is not a string");
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
    if (!connection)
      return declineHere("external SQL: context.connection_string_flex is not a tagged value");
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
  const storedId = getPath(context, "dbo.id");
  if (!isReferenceId(storedId))
    return declineHere("db.bulk.delete: context.dbo.id is not a reference id");
  if (isBoundNumericId(storedId))
    return declineHere("db.bulk.delete: context.dbo.id is a numeric object reference");
  const table = isUnboundId(storedId)
    ? unboundTableArg(a, "db.bulk.delete")
    : tableArg(a, String(storedId));
  const entries: Array<[string, Expr]> = [["table", table.expr]];
  const runtime: Record<string, unknown> = { table: table.runtime };
  const alias = aliasEntry(context);
  if (alias) {
    entries.push(alias.entry);
    runtime.tableAlias = alias.runtime;
  }

  if (!isUnauthored("search", context.search)) {
    const where = decodeWhere(a, context.search, "db.bulk.delete search");
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
 *
 * Null is always fatal for a caller (a search filter cannot be dropped), so the
 * decline is recorded here rather than at each call site.
 *
 * `site` names WHICH where failed. A query has three of them — its own search,
 * a `bind[]` join's, and an addon attachment's — and the bare message named
 * none, so six declines in the survey corpus all read identically and could not
 * be told apart without re-deriving the call site by hand.
 */
function decodeWhere(
  a: SpecialArgs,
  stored: unknown,
  site: string,
): { expr: Expr; runtime: unknown } | null {
  const condition = decodeCondition(a.ctx, stored);
  if (condition) return { expr: condition.expr, runtime: condition.runtime };
  const value = toValue(stored);
  if (!value)
    return declineHere(
      `where (${site}): neither a decodable condition tree nor a tagged value — stored ${JSON.stringify(stored).slice(0, 80)}`,
    );
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
      if (!value)
        return declineHere(`db.query: context.simpleExternal.${key} is not a tagged value`);
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
  const storedId = getPath(context, "dbo.id");
  if (!isReferenceId(storedId))
    return declineHere("db.query: context.dbo.id is not a reference id");
  if (isBoundNumericId(storedId))
    return declineHere("db.query: context.dbo.id is a numeric object reference");
  if (Array.isArray(a.stored.input) && a.stored.input.length > 0)
    return declineHere("db.query: statement-level input[] is populated");

  const table = isUnboundId(storedId)
    ? unboundTableArg(a, "db.query")
    : tableArg(a, String(storedId));
  const entries: Array<[string, Expr]> = [["table", table.expr]];
  const runtime: Record<string, unknown> = { table: table.runtime };
  const alias = aliasEntry(context);
  if (alias) {
    entries.push(alias.entry);
    runtime.tableAlias = alias.runtime;
  }

  const ret = (context.return ?? {}) as Record<string, unknown>;
  const returnType = typeof ret.type === "string" ? ret.type : "list";
  // The editor writes every return branch and the engine reads only the one
  // `type` selects, so the rest are dropped (see `liveReturnSection`). A dropped
  // branch that still holds real configuration is worth saying out loud — it is
  // what the query used to do before its return type was switched.
  for (const dead of configuredDeadReturnBlocks(ret)) {
    a.ctx.problem(
      "expected-omission",
      `db.query returns "${returnType}", so its stored "${dead}" return block — which carries a sort, grouping, or paging — is inert: the engine reads only the branch \`return.type\` names. Dropped.`,
    );
  }
  if (returnType !== "list") {
    entries.push(["returnType", lit(returnType)]);
    runtime.returnType = returnType;
  }

  if (!isUnauthored("search", context.search)) {
    const where = decodeWhere(a, context.search, "db.query search");
    if (!where) return null;
    entries.push(["where", where.expr]);
    runtime.where = where.runtime;
  }

  if (!isUnauthored("bind", context.bind)) {
    if (!Array.isArray(context.bind))
      return declineHere("db.query: context.bind is present but not an array");
    const bindExprs: Expr[] = [];
    const bindRuntime: unknown[] = [];
    for (const stored of context.bind) {
      const bindGuid = getPath(stored, "dbo.id");
      const bindAlias = getPath(stored, "dbo.as");
      if (typeof bindGuid !== "string")
        return declineHere("db.query: a context.bind[] join has no dbo.id");
      // A join to an UNBOUND table — the join's table was deleted, and the
      // engine clears the id rather than recording a tombstone. `DbBind.table`
      // models this as `null` on the same contract the query's own `table`
      // holds, so it round-trips instead of taking the whole statement to
      // `raw()` for one broken join.
      const unbound = isUnboundId(bindGuid);
      const joined = unbound
        ? unboundTableArg(a, "db.query bind")
        : tableArg(a, bindGuid);
      const cells: Array<[string, Expr]> = [["table", joined.expr]];
      const entry: Record<string, unknown> = { table: joined.runtime };
      // The alias defaults to the joined table's own name — except on an unbound
      // join, which has no name to default from, so it is always authored. The
      // stored bytes show the alias outliving the table (`{as:"…", id:""}`).
      if (typeof bindAlias === "string" && (unbound || bindAlias !== joined.runtime?.name)) {
        cells.push(["as", lit(bindAlias)]);
        entry.as = bindAlias;
      }
      const join = (stored as { join?: unknown }).join;
      if (typeof join === "string" && join !== "inner") {
        cells.push(["join", lit(join)]);
        entry.join = join;
      }
      // A join's own filter gets the same "empty means unauthored" treatment the
      // query's top-level search has always had. Testing only `!== undefined`
      // sent the engine's unconditional `{expression: []}` into the condition
      // inverse, which cannot build an empty tree — so five joined queries in
      // the survey corpus fell back to `raw()` for filtering on nothing.
      const search = (stored as { search?: unknown }).search;
      if (!isUnauthored("search", search)) {
        const where = decodeWhere(a, search, "db.query bind[] join");
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

  if (!isUnauthored("eval", context.eval)) {
    const evals = decodeEvals(a, context.eval);
    if (!evals) return null;
    entries.push(["eval", evals.expr]);
    runtime.eval = evals.runtime;
  }

  if (context.lock !== undefined) {
    const lock = plainBool(context.lock);
    if (lock === null)
      return declineHere("db.query: context.lock is not a bare boolean constant");
    entries.push(["lock", lit(lock)]);
    runtime.lock = lock;
  }

  // Same story as `search`/`eval` above, and it bit harder: the engine writes all
  // five `simpleExternal` facets at an empty `input` default on a query that binds
  // none of them. Read as authored, they became five bound paging Values — and
  // since the engine honors `external` over `simpleExternal`, the SDK forbids
  // authoring both, so the recovered call did not merely mismatch, it THREW.
  // Measured: 70 of 230 fallen-back queries stored exactly this pair.
  const simple = isUnauthored("simpleExternal", context.simpleExternal)
    ? {}
    : (context.simpleExternal as Record<string, unknown>);
  const pagingEntries: Array<[string, Expr]> = [];
  const pagingRuntime: Record<string, unknown> = {};
  let sortBlock: unknown;
  let distinct: unknown;
  /** The stored paging gate, for the return types that carry one. */
  let storedEnabled: boolean | undefined;

  if (returnType === "single") {
    sortBlock = getPath(ret, "single.sort");
  } else if (returnType === "stream") {
    sortBlock = getPath(ret, "stream.sort");
    distinct = getPath(ret, "stream.distinct");
    const block = (getPath(ret, "stream.paging") ?? {}) as Record<string, unknown>;
    if (typeof block.enabled === "boolean") storedEnabled = block.enabled;
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
    if (typeof block.enabled === "boolean") storedEnabled = block.enabled;
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
    if (!value)
      return declineHere(`db.query: context.simpleExternal.${key} is not a tagged value`);
    pagingEntries.push([key, decodeValue(a.ctx, value)]);
    pagingRuntime[key] = value;
  }

  // The gate is DERIVED by the encoder (a page field or an `external` blob turns it
  // on), so it is authored back only when the stored value disagrees — which real
  // workspaces routinely do: they persist a non-default `per_page` with the gate
  // off. Emitting it unconditionally would be noise on every query; not emitting it
  // at all is what cost ~158 statements their readability, since the same
  // derivation also decides where addons graft (`items[]`).
  if (storedEnabled !== undefined) {
    const derived =
      pagingRuntime.page !== undefined ||
      pagingRuntime.per_page !== undefined ||
      pagingRuntime.offset !== undefined ||
      context.external !== undefined;
    if (storedEnabled !== derived) {
      pagingEntries.push(["enabled", lit(storedEnabled)]);
      pagingRuntime.enabled = storedEnabled;
    }
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
    if (!external) return null; // `decodeExternal` records which part refused
    entries.push(["external", external.expr]);
    runtime.external = external.runtime;
  }
  // `auto` is the encoder's default and is written unconditionally.
  if (typeof distinct === "string" && distinct !== "auto") {
    entries.push(["distinct", lit(distinct)]);
    runtime.distinct = distinct;
  }

  if (returnType === "aggregate") {
    // An unbound table contributes no alias to qualify aggregate columns with,
    // matching the encoder's own `null` branch.
    const aggregate = decodeAggregate(a, ret, table.runtime?.name ?? "", sortBlock);
    if (!aggregate) return declineHere("db.query: context.return.aggregate is not decodable");
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
  if (!value) return declineHere("db.query: context.external is not a tagged value");
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
      if (typeof gate !== "boolean")
        return declineHere(`db.query: context.external.permissions.${key} is not a boolean`);
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
    // The gate defaults to on (a `paging` block is how you ask for paging), so
    // only a parked block — configured but switched back off — authors it.
    if (paging.enabled === false) {
      cells.push(["enabled", lit(false)]);
      values.enabled = false;
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
  // The engine's dedicated get-by-primary-key statement, distinct from
  // `dbo_getby` above: one `id` input instead of a field_name/field_value pair.
  [
    "mvp:dbo_get",
    dboOp({
      path: "db.get_by_id",
      named: [{ entry: "id", arg: "id" }],
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
      takesOutput: true,
      takesAddon: true,
    }),
  ],
  ["mvp:dbo_truncate", dboOp({ path: "db.truncate", named: [{ entry: "reset", arg: "reset", bool: true, optional: true }] })],
  ["mvp:dbo_get_schema", dboOp({ path: "db.schema", named: [{ entry: "path", arg: "path" }] })],
  ["mvp:dbo_add", dboOp({ path: "db.add", rowData: true, takesOutput: true, takesAddon: true })],
  [
    "mvp:dbo_editby",
    dboOp({ path: "db.edit", lookup: true, rowData: true, takesOutput: true, takesAddon: true }),
  ],
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
