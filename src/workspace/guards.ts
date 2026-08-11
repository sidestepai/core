/**
 * Export-time guards for authoring shapes that can only produce a failed
 * deploy, and the build-time warnings for shapes that succeed with the wrong
 * result.
 *
 * The bar for a guard here is deliberately high, and it is NOT "the engine
 * currently rejects this" — most of the audit's engine-class findings are bugs
 * in a single engine code path, against shapes the engine's own tooling emits.
 * Blocking those would disable a supported feature and have to be un-shipped
 * the moment the engine is fixed. They are labelled `external` on the tracker
 * and carry a regression test in `test/workspace/diagnostics.test.ts` asserting
 * NO diagnostic fires: `useXdo: true` (#214), a `.` in a query name (#227) and
 * `idType: "uuid"` (#205).
 *
 * There are currently NO hard guards on engine-rejected shapes, and that is the
 * considered position rather than an omission. A seeded table carrying a
 * non-scalar column (#195) was guarded here for exactly one release, on the
 * strength of a live reproduction; the cause turned out to be a stale
 * per-worker model cache upstream (DEV-7605) that dropped a column's value
 * cast, which is fixed and was never anything an author could avoid. A
 * reproduction proves a symptom, not a rule — the guards that survive are the
 * ones about SideStep's OWN contract (a reference must name something the
 * bundle carries), not ones asserting what the engine will accept.
 */
import { tableColumns } from "../kinds/table.js";
import { resolveRef } from "../refs/guid.js";
import { DECODE_ONLY_STATEMENTS } from "../statements/decode-only.js";
import type { TableDef } from "../kinds/table.js";
import type { DiagnosticBag } from "./diagnostics.js";

// --- stack warnings: shapes that succeed with HTTP 200 and the wrong result ---

/** Statement names the stack walk keys on. */
const BULK_UPDATE = "mvp:dbo_bulkupdate";
const DB_GET = "mvp:dbo_getby";

/**
 * Auto-injected columns an author is not expected to restate on a bulk item:
 * `id` targets the row, and `created_at` carries an engine default.
 */
const SYSTEM_COLUMNS = new Set(["id", "created_at"]);

/** One encoded statement, loosely typed — only the keys the walk reads. */
interface EncodedStatement {
  readonly name: string;
  readonly as?: unknown;
  readonly input?: unknown;
  readonly context?: unknown;
  readonly output?: unknown;
}

/**
 * Every statement in an object, including those nested in a conditional or a
 * loop. A statement is any object carrying a `mvp:`-prefixed `name`, which is
 * the one marker every encoded statement shares regardless of where it sits.
 */
function collectStatements(node: unknown, out: EncodedStatement[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectStatements(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const name = (node as { name?: unknown }).name;
  if (typeof name === "string" && name.startsWith("mvp:")) {
    out.push(node as EncodedStatement);
  }
  for (const value of Object.values(node as Record<string, unknown>)) {
    collectStatements(value, out);
  }
}

/** The named entry of a statement's `input[]`, if present. */
function statementInput(
  statement: EncodedStatement,
  name: string,
): { tag?: unknown; value?: unknown } | undefined {
  if (!Array.isArray(statement.input)) return undefined;
  return statement.input.find(
    (entry) => (entry as { name?: unknown })?.name === name,
  ) as { tag?: unknown; value?: unknown } | undefined;
}

/** The table guid a db statement is bound to (`context.dbo.id`). */
function statementTableGuid(statement: EncodedStatement): string | undefined {
  const id = (statement.context as { dbo?: { id?: unknown } } | undefined)?.dbo?.id;
  return typeof id === "string" ? id : undefined;
}

/**
 * `s.db.bulk.update` is a full-row REPLACE, and nothing says so (#203).
 *
 * Confirmed in the engine: bulk update and bulk patch run the same code and
 * differ by one argument to the input-schema builder — update keeps each
 * column's default and writes it, patch strips defaults so an absent key
 * contributes nothing. So an item shaped `{ id, status }` applies the status
 * and writes every other column to its zero value: text to `""`, int to `0`.
 * HTTP 200, no error, data gone.
 *
 * This warns rather than blocks: replacing a row IS the statement's job, and an
 * author who supplies a deliberate subset may mean it. Only a STATIC items
 * array can be checked — a `ref` is opaque at build time, which is a documented
 * limit of the check rather than a silent gap.
 */
function checkBulkUpdate(
  statement: EncodedStatement,
  owner: string,
  tablesByGuid: ReadonlyMap<string, TableDef>,
  bag: DiagnosticBag,
): void {
  const guid = statementTableGuid(statement);
  const def = guid === undefined ? undefined : tablesByGuid.get(guid);
  if (!def) return;
  const items = statementInput(statement, "items");
  // A `ref`/`var` items list carries no keys to compare — say nothing.
  if (typeof items?.tag !== "string" || !items.tag.startsWith("const")) return;
  if (typeof items.value !== "string") return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(items.value);
  } catch {
    return;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return;

  const supplied = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    for (const key of Object.keys(item as Record<string, unknown>)) supplied.add(key);
  }
  if (supplied.size === 0) return;

  const cleared = tableColumns(def)
    .map((col) => col.name)
    .filter((name) => !SYSTEM_COLUMNS.has(name) && !supplied.has(name));
  if (cleared.length === 0) return;

  bag.warn(
    "db.bulk-update-partial-item",
    `${owner}: \`s.db.bulk.update\` on table "${def.name}" is a full-row REPLACE, and these ` +
      `items omit ${cleared.map((n) => `"${n}"`).join(", ")} — each omitted column is written ` +
      `to its zero value ("" / 0 / null), not left alone, with an HTTP 200 and no error. Use ` +
      `\`s.db.bulk.patch\` to write only the keys an item carries, or supply every column you ` +
      `mean to preserve. (Only a static \`items\` array is checked; a \`ref\` cannot be.)`,
  );
}

/** Column names a `db.get` will return, or `undefined` when it returns the default set. */
function outputColumns(statement: EncodedStatement): Set<string> | undefined {
  const output = statement.output as
    | { items?: unknown; customize?: unknown }
    | undefined;
  if (!output || output.customize !== true || !Array.isArray(output.items)) return undefined;
  const names = new Set<string>();
  for (const item of output.items) {
    const name = (item as { name?: unknown })?.name;
    if (typeof name === "string") names.add(name);
  }
  return names;
}

/** Every `{ tag: "var", value: "<path>" }` reference inside an object. */
function collectVarRefs(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectVarRefs(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as { tag?: unknown; value?: unknown };
  if (record.tag === "var" && typeof record.value === "string") out.push(record.value);
  for (const value of Object.values(node as Record<string, unknown>)) {
    collectVarRefs(value, out);
  }
}

/**
 * Reading an `access: "internal"` column that the `db.get` did not return (#224).
 *
 * An internal column is absent from a `db.get` result unless `output` names it
 * — `output` overrides column visibility. `f.password` defaults to
 * `access: "internal"`, so the canonical login stack (the most-copied stack in
 * the SDK) reads `ref("u.password")` against a row that has no `password` key
 * and dies at runtime with `Unable to locate var: u.password`.
 *
 * Statically unambiguous, so it warns. Scoped to vars bound by `db.get`: a var
 * bound by anything else is not something this can reason about, and guessing
 * would produce exactly the false positives that train a warning away.
 */
function checkInternalColumnReads(
  statements: readonly EncodedStatement[],
  owner: string,
  tablesByGuid: ReadonlyMap<string, TableDef>,
  bag: DiagnosticBag,
): void {
  // var name -> the table it was bound from, and what the read returned.
  const bindings = new Map<string, { def: TableDef; output: Set<string> | undefined }>();
  for (const statement of statements) {
    if (statement.name !== DB_GET) continue;
    const as = statement.as;
    if (typeof as !== "string" || as === "") continue;
    const guid = statementTableGuid(statement);
    const def = guid === undefined ? undefined : tablesByGuid.get(guid);
    if (!def) continue;
    bindings.set(as, { def, output: outputColumns(statement) });
  }
  if (bindings.size === 0) return;

  const refs: string[] = [];
  for (const statement of statements) collectVarRefs(statement, refs);

  const reported = new Set<string>();
  for (const path of refs) {
    const dot = path.indexOf(".");
    if (dot <= 0) continue;
    const root = path.slice(0, dot);
    const column = path.slice(dot + 1);
    const binding = bindings.get(root);
    if (!binding || binding.output?.has(column)) continue;
    const col = tableColumns(binding.def).find((c) => c.name === column);
    if (!col || col.access !== "internal") continue;
    if (reported.has(path)) continue;
    reported.add(path);
    bag.warn(
      "db.internal-column-read",
      `${owner}: reads \`ref("${path}")\`, but "${column}" on table "${binding.def.name}" is ` +
        `\`access: "internal"\` and a \`db.get\` does not return it — the row has no ` +
        `"${column}" key, so this fails at runtime with \`Unable to locate var: ${path}\`. Name ` +
        `the column in \`output\` on that \`db.get\` (\`output\` overrides column visibility), ` +
        `e.g. \`output: ["id", "${column}"]\`.`,
    );
  }
}

/** Every `{ tag: "input", value: "<name>" }` reference inside an object. */
function collectInputRefs(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectInputRefs(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as { tag?: unknown; value?: unknown };
  if (record.tag === "input" && typeof record.value === "string") out.push(record.value);
  for (const value of Object.values(node as Record<string, unknown>)) {
    collectInputRefs(value, out);
  }
}

/**
 * A middleware's declared `input` is never bound, and `inp()` inside one fails
 * at runtime (#210).
 *
 * Verified live: a middleware declaring `input: { probe: input.text({ default })
 * }` and reading `inp("probe")` returns
 * `500 Unable to locate input: probe` — the default does not even stand in. The
 * host request simply does not populate a middleware's inputs. The body is read
 * with `s.util.get_all_input`, which hands back a `{ type, vars }` envelope.
 *
 * **Warnings, not errors**, despite the field being useless at runtime. The
 * engine stores it and real workspaces carry one — a captured middleware in
 * this repo's own corpus declares `vars` and `type` inputs. Refusing it at
 * export would make such a workspace impossible to pull, edit and push back,
 * which is a worse failure than the one being reported: the SDK must be able to
 * represent what the engine holds.
 */
function checkMiddleware(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const mw of sections.middleware ?? []) {
    if (!mw || typeof mw !== "object") continue;
    const record = mw as { name?: unknown; input?: unknown; run?: unknown };
    const name = typeof record.name === "string" ? record.name : "?";

    if (Array.isArray(record.input) && record.input.length > 0) {
      bag.warn(
        "middleware.input-never-bound",
        `middleware "${name}" declares \`input\`, which the host request never binds — ` +
          `\`inp()\` inside a middleware fails at runtime with \`Unable to locate input\`, and a ` +
          `declared default does not stand in. Read the request body with ` +
          `\`s.util.get_all_input\` instead; it yields a \`{ type, vars }\` envelope. The field ` +
          `is kept because the engine stores it and existing workspaces carry one.`,
      );
    }

    const refs: string[] = [];
    collectInputRefs(record.run, refs);
    const unique = [...new Set(refs)];
    if (unique.length > 0) {
      bag.warn(
        "middleware.inp-unresolvable",
        `middleware "${name}" reads ${unique.map((r) => `\`inp("${r}")\``).join(", ")}, which ` +
          `cannot resolve — a middleware has no bound inputs, so this fails at runtime with ` +
          `\`Unable to locate input: ${unique[0]}\`. Use \`s.util.get_all_input\` and read the ` +
          `\`{ type, vars }\` envelope it binds.`,
      );
    }
  }
}

/**
 * Warn about the shapes that return HTTP 200 while destroying data, reading
 * nothing, or failing at runtime. All are statically detectable and none is
 * ever blocked — see the individual checks for why each stays a warning.
 */
export function checkStacks(
  tables: readonly TableDef[],
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  checkMiddleware(sections, bag);
  if (tables.length === 0) return;
  const tablesByGuid = new Map<string, TableDef>();
  for (const def of tables) tablesByGuid.set(resolveRef("dbo", def), def);

  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const name = (obj as { name?: unknown }).name;
      const owner = `${payloadKey} "${typeof name === "string" ? name : "?"}"`;
      const statements: EncodedStatement[] = [];
      collectStatements(obj, statements);
      if (statements.length === 0) continue;
      for (const statement of statements) {
        if (statement.name === BULK_UPDATE) {
          checkBulkUpdate(statement, owner, tablesByGuid, bag);
        }
      }
      checkInternalColumnReads(statements, owner, tablesByGuid, bag);
    }
  }
}

/**
 * Warn when a realtime GATING trigger cannot say yes.
 *
 * `connect` and `join` are gates: the transport reads the stack's return, and
 * anything empty or falsy is a DENY. A trigger that declares one of those
 * actions and carries no `response` returns nothing on every run, so it refuses
 * every client — a lockout that presents as "realtime silently stopped working"
 * rather than as an error, because a refusal is a normal, expected outcome and
 * looks identical to a working gate rejecting a caller.
 *
 * It is a WARNING, not an error, and the split is the one KTD2c draws. The
 * engine accepts this shape and behaves exactly as documented; what the check
 * asserts is INTENT — that nobody writes a gate meaning to reject 100% of
 * traffic. That is a prediction, and predictions warn. Someone who really wants
 * a closed door writes `response: () => c.bool(false)` and this stays quiet.
 *
 * Deliberately NOT checked: `leave`, `disconnect` (observational — the return is
 * ignored) and `deliver` (a missing return delivers the original payload
 * unchanged, which is a working default rather than a lockout).
 */
const GATING_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  realtime_server: ["connect"],
  channel: ["join"],
};

export function checkRealtimeGates(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const obj of sections.trigger ?? []) {
    if (!obj || typeof obj !== "object") continue;
    const t = obj as { name?: unknown; obj_type?: unknown; meta?: unknown; result?: unknown };
    // A response-bearing trigger encodes its response into `result[]`; a gating
    // trigger with none encodes an empty array, which is what returns nothing.
    if (!Array.isArray(t.result) || t.result.length > 0) continue;
    const objType = typeof t.obj_type === "string" ? t.obj_type : "";
    const gating = GATING_ACTIONS[objType];
    if (!gating) continue;
    const actions = (t.meta as Record<string, { action?: Record<string, unknown> }> | undefined)?.[
      objType
    ]?.action;
    const declared = gating.filter((a) => actions?.[a] === true);
    if (declared.length === 0) continue;
    const name = typeof t.name === "string" ? t.name : "?";
    bag.warn(
      "realtime.gate-denies-everyone",
      `trigger "${name}" gates \`${declared.join("`/`")}\` but declares no \`response\`, so it ` +
        `returns nothing on every run — and an empty return is a DENY, which refuses every ` +
        `client. A crash denies too, so there is no shape of this trigger that admits anyone. ` +
        `Add \`response: () => obj({ allowed: c.bool(true) })\` (any truthy value admits; an ` +
        `\`allowed: false\` with a \`reason\` reaches the client). If refusing everyone is the ` +
        `intent, say so explicitly with \`response: () => c.bool(false)\`.`,
    );
  }
}

/**
 * Refuse a bundle carrying a statement the engine will not read back.
 *
 * `mvp:placeholder` is the whole population today: the engine writes one into an
 * export in place of a statement it could not resolve, so the export stays
 * well-formed — and then refuses those same bytes on import, because there is no
 * statement class behind the name. A bundle containing one can only fail with
 * `Missing statement: mvp:placeholder`, after a destructive full-replace has
 * begun.
 *
 * This clears the KTD2c bar without asserting anything about what the engine
 * accepts: Xano's own CLI blocks a push whose preview names `mvp:placeholder`,
 * as a critical error, in the same breath as a syntax error. The rule is
 * upstream's. SideStep cannot even author one — there is no `s.` surface — so
 * the only way a bundle acquires one is a pull that carried it through `raw()`,
 * which is exactly the case worth stopping.
 */
export function checkDecodeOnlyStatements(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const objName = (obj as { name?: unknown }).name;
      const owner = `${payloadKey} "${typeof objName === "string" ? objName : "?"}"`;
      const statements: EncodedStatement[] = [];
      collectStatements(obj, statements);
      // One diagnostic per distinct statement name per object: three copies of
      // the same unresolved slot is one thing to go fix, not three.
      const found = new Set(
        statements.map((s) => s.name).filter((name) => DECODE_ONLY_STATEMENTS.has(name)),
      );
      for (const name of found) {
        bag.error(
          "statement.decode-only",
          `${owner} contains \`${name}\`, which is ${DECODE_ONLY_STATEMENTS.get(name)}. It ` +
            `reached this bundle from a pulled workspace — SideStep has no factory for it — and ` +
            `the generated source carries it as a \`raw({ name: "${name}", … })\` call. Replace ` +
            `that call with the statement it stands in for.`,
        );
      }
    }
  }
}

/** An engine object guid: 32 lowercase hex characters. */
const GUID_RE = /^[0-9a-f]{32}$/;

/**
 * Keys whose subtrees carry AUTHOR VALUES, never object references.
 *
 * A reference is structural — the encoder puts it there. Anything under these
 * keys came from the author, so a 32-hex string in one is a coincidence, not a
 * dangling pointer. This is not hypothetical: `examples/sandbox` has an
 * auth-token example whose statement input value is a literal 32-hex string.
 * Skipping these subtrees is what lets the check be an ERROR rather than a
 * warning nobody trusts.
 */
const VALUE_KEYS = new Set([
  "input",
  "value",
  "default",
  "filters",
  "search",
  "docs",
  "description",
  "mocks",
  "tag",
  "settings_registry",
  // An object's own identity, not a pointer at another object.
  "guid",
]);

/**
 * Reference keys whose target legitimately lives OUTSIDE the workspace, so an
 * unresolved guid is expected rather than a mistake. `run_version` is a
 * marketplace action-package version — installed on the instance, never part of
 * a bundle SideStep emits.
 */
const EXTERNAL_REF_KEYS = new Set(["run_version"]);

/** One dangling reference: where it was found and what it points at. */
interface DanglingRef {
  readonly owner: string;
  readonly path: string;
  readonly guid: string;
}

/** Collect every guid-valued reference under `node` that resolves to nothing. */
function collectDanglingRefs(
  node: unknown,
  path: string,
  owner: string,
  known: ReadonlySet<string>,
  out: DanglingRef[],
): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectDanglingRefs(item, `${path}[${i}]`, owner, known, out));
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (VALUE_KEYS.has(key) || EXTERNAL_REF_KEYS.has(key)) continue;
    if (typeof value === "string") {
      if (GUID_RE.test(value) && !known.has(value)) {
        out.push({ owner, path: `${path}.${key}`, guid: value });
      }
      continue;
    }
    collectDanglingRefs(value, `${path}.${key}`, owner, known, out);
  }
}

/**
 * Every cross-object reference must name an object this bundle emits.
 *
 * A reference is stored as the target's guid, and `resolveRef` derives that
 * guid from a name with **no registry visibility** — so `s.addon.call({ addon:
 * "ex_author_addon" })` against an addon actually named `ex_kind_author_addon`
 * produces a perfectly well-formed guid pointing at nothing. It exports clean
 * and then fails the import with `Invalid addon reference. Try importing:
 * <guid>`, after the full replace has begun. The author is handed a guid, which
 * is exactly the thing they cannot map back to their typo.
 *
 * `export()` already cross-checked one reference kind (a query's `auth` table)
 * and nothing else. This generalises it: the registry is fully known here, so
 * every reference is checkable. Five of these were live in `examples/sandbox`.
 *
 * Scoped to the full `workspace` bundle, which is what `deploy` ships and which
 * must be self-contained. A partial bundle (`schema`/`content`/`share`) may
 * legitimately reference an object it does not carry.
 */
export function checkReferences(
  bundleType: string,
  sections: Readonly<Record<string, unknown[] | undefined>>,
  workspaceGuid: unknown,
  bag: DiagnosticBag,
): void {
  if (bundleType !== "workspace") return;

  const known = new Set<string>();
  if (typeof workspaceGuid === "string") known.add(workspaceGuid);
  for (const arr of Object.values(sections)) {
    for (const obj of arr ?? []) {
      const guid = (obj as { guid?: unknown })?.guid;
      if (typeof guid === "string") known.add(guid);
    }
  }

  const dangling: DanglingRef[] = [];
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const name = (obj as { name?: unknown }).name;
      const owner = `${payloadKey} "${typeof name === "string" ? name : "?"}"`;
      collectDanglingRefs(obj, "$", owner, known, dangling);
    }
  }

  // One diagnostic per distinct target: a single mistyped name referenced from
  // three statements is one thing to fix, not three.
  const byGuid = new Map<string, DanglingRef[]>();
  for (const ref of dangling) {
    const bucket = byGuid.get(ref.guid);
    if (bucket) bucket.push(ref);
    else byGuid.set(ref.guid, [ref]);
  }

  for (const [guid, refs] of byGuid) {
    const owners = [...new Set(refs.map((r) => r.owner))];
    const from =
      owners.length === 1
        ? owners[0]!
        : `${owners.slice(0, 3).join(", ")}${owners.length > 3 ? `, +${owners.length - 3} more` : ""}`;
    bag.error(
      "reference.unresolved",
      `${from} references an object that is not registered on this workspace (guid ${guid}). ` +
        `A reference is resolved to a guid from the target's NAME with no registry lookup, so a ` +
        `mistyped name produces a valid-looking guid that only fails at deploy — ` +
        `"Invalid <kind> reference. Try importing: ${guid}" — after the import has begun. Check ` +
        `the name for a typo and register the target; pass the def handle rather than a bare ` +
        `name so a rename cannot silently break the reference. Reference found at ${refs[0]!.path}.`,
    );
  }
}
