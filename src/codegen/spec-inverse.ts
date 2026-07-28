/**
 * Spec-inverse statement decoder — the 155 declarative statements.
 *
 * `encodeFromSpec` routes each authored field into the stored statement through
 * one of six route kinds, and every one of them is mechanically readable back.
 * This inverts them, then **proves the result before emitting it**: the recovered
 * record is passed to the very `s.<sPath>` function the generated source will
 * call, re-encoded, and compared against the stored statement. Only an exact
 * match is emitted.
 *
 * Proving through the real `s` leaf rather than through `encodeFromSpec` is what
 * makes this safe without a maintained exclusion list. Four surfaces
 * (`api.request`, `api.stream`, `webflow.request`, `api.microservice`) have
 * hand-authored factories that shadow their generated ones with a different
 * argument shape; calling those with a spec-shaped record simply fails to
 * reproduce the bytes, so they fall through to the next dispatch arm instead of
 * being silently mis-emitted. The same is true of any future override.
 *
 * It also subsumes the total-coverage gate: a stored key no rule accounts for
 * cannot survive a byte comparison, so "every stored key was consumed" is
 * checked as a consequence rather than as a separate heuristic — and unlike a
 * key-coverage check, this also catches a *value* decoded to a near-miss.
 */
import type { StackItemXdo, TaggedValue } from "../types/xdo.js";
import { GENERATED_SPECS } from "../statements/generated/specs.generated.js";
import type { FieldRule, StatementSpec } from "../statements/schema-dsl/interpret.js";
import { STATEMENT_SURFACES, sPathOf } from "../statements/surfaces.js";
import { s } from "../statements/s.js";
import { encodeStatement, type Statement } from "../statements/statement.js";
import { normalize } from "../validate/normalize.js";
import { CORE_MODULE, type DecodeContext } from "./context.js";
import { call, lit, obj, type Expr } from "./print.js";
import { deepEqual } from "./field.js";
import { decodeCondition } from "./expression.js";
import { decodeValue } from "./value.js";

/** Specs by stored name. */
const SPECS_BY_NAME: ReadonlyMap<string, StatementSpec> = new Map(
  GENERATED_SPECS.map((spec) => [spec.name, spec]),
);

/**
 * Stored name → the public `s.` paths that reach it, sorted for determinism.
 * Two names map to more than one path: `mvp:get_input` (harmless aliases of one
 * factory) and `mvp:function` (genuinely distinct factories). Both are handled
 * by trying each candidate and keeping the one that proves.
 */
const SPATHS_BY_NAME: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, string[]>();
  for (const [surface, storedName] of STATEMENT_SURFACES) {
    const paths = out.get(storedName) ?? [];
    paths.push(sPathOf(surface));
    out.set(storedName, paths);
  }
  for (const paths of out.values()) paths.sort();
  return out;
})();

/** Resolve a dotted `s.` path to its callable leaf. */
function leafOf(path: string): ((authored: Record<string, unknown>) => Statement) | null {
  const leaf = path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node === null || node === undefined
          ? undefined
          : (node as Record<string, unknown>)[key],
      s,
    );
  return typeof leaf === "function"
    ? (leaf as (authored: Record<string, unknown>) => Statement)
    : null;
}

/** Read a dotted path out of a stored object. */
function getPath(root: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node === null || node === undefined
          ? undefined
          : (node as Record<string, unknown>)[key],
      root,
    );
}

/** Coerce a stored `{value, tag, filters?}` block to a full tagged value. */
function toTaggedValue(raw: unknown): TaggedValue | null {
  if (raw === null || typeof raw !== "object") return null;
  const block = raw as { value?: unknown; tag?: unknown; filters?: unknown };
  if (typeof block.tag !== "string" || block.value === undefined) return null;
  return {
    value: block.value as string,
    tag: block.tag as TaggedValue["tag"],
    filters: (Array.isArray(block.filters) ? block.filters : []) as TaggedValue["filters"],
  };
}

/** One recovered authored field: its runtime value and its source form. */
interface Recovered {
  readonly field: string;
  readonly runtime: unknown;
  readonly expr: Expr;
  /** True when the stored value equals the rule's declared default. */
  readonly isDefault: boolean;
}

/** Recover one rule's authored field from the stored statement, or null. */
function recoverRule(
  ctx: DecodeContext,
  rule: FieldRule,
  stored: StackItemXdo,
): Recovered | null {
  const context = (stored.context ?? {}) as Record<string, unknown>;

  switch (rule.route.kind) {
    case "as": {
      const as = (stored as { as?: unknown }).as;
      if (typeof as !== "string" || as === "") return null;
      return { field: rule.field, runtime: as, expr: lit(as), isDefault: false };
    }
    case "context-plain": {
      const raw = getPath(context, rule.route.path);
      if (raw === undefined) return null;
      return {
        field: rule.field,
        runtime: raw,
        expr: lit(raw),
        isDefault: rule.default !== undefined && raw === rule.default,
      };
    }
    case "context-spread": {
      // The spread writes `{value, tag, filters}` onto `context` itself, so the
      // sibling `context-plain` keys sit alongside it — read the three by name
      // rather than assuming the spread owns the object.
      const value = toTaggedValue(context);
      if (!value) return null;
      return { field: rule.field, runtime: value, expr: decodeValue(ctx, value), isDefault: false };
    }
    case "context-nest": {
      const value = toTaggedValue(getPath(context, rule.route.path));
      if (!value) return null;
      return { field: rule.field, runtime: value, expr: decodeValue(ctx, value), isDefault: false };
    }
    case "input": {
      const entries = Array.isArray(stored.input) ? stored.input : [];
      const entry = entries.find(
        (candidate) => (candidate as { name?: unknown })?.name === (rule.route as { name: string }).name,
      );
      const value = toTaggedValue(entry);
      if (!value) return null;
      return { field: rule.field, runtime: value, expr: decodeValue(ctx, value), isDefault: false };
    }
    case "context-compare": {
      // The same `{expression: […]}` boolean tree conditionals and db searches
      // use, so it inverts through the shared algebra rather than one of its own.
      // This is what makes the predicate-taking statements (`array.find`,
      // `array.filter`, `array.every`, …) readable instead of raw.
      const condition = decodeCondition(ctx, getPath(context, rule.route.path));
      if (!condition) return null;
      return {
        field: rule.field,
        runtime: condition.runtime,
        expr: condition.expr,
        isDefault: false,
      };
    }
  }
}

/** The `output` envelope a spec emits when the author shapes nothing. */
function baseOutput(spec: StatementSpec): Record<string, unknown> {
  return spec.envelope?.richOutput
    ? { customize: false, filters: [], items: [] }
    : { filters: [] };
}

/** Build the reserved envelope entries (`description`, `output`) a spec allows. */
function envelopeEntries(spec: StatementSpec, stored: StackItemXdo): Recovered[] {
  const out: Recovered[] = [];
  const description = (stored as { description?: unknown }).description;
  if (spec.envelope?.description && typeof description === "string" && description !== "") {
    out.push({ field: "description", runtime: description, expr: lit(description), isDefault: false });
  }
  const storedOutput = (stored as { output?: unknown }).output;
  if (spec.output && storedOutput !== undefined && !deepEqual(storedOutput, baseOutput(spec))) {
    out.push({ field: "output", runtime: storedOutput, expr: lit(storedOutput), isDefault: false });
  }
  return out;
}

/** Statement equality under the round-trip contract's comparator. */
function sameStatement(a: unknown, b: unknown): boolean {
  return deepEqual(normalize(a), normalize(b));
}

/**
 * Decode a stored statement through its declarative spec.
 *
 * Returns null when no spec applies, a rule cannot be read back, or the
 * recovered record does not re-encode to the stored bytes — in every case the
 * caller falls through to the next dispatch arm.
 */
export function decodeFromSpec(ctx: DecodeContext, stored: StackItemXdo): Expr | null {
  const spec = SPECS_BY_NAME.get(stored.name);
  if (!spec) return null;

  const recovered: Recovered[] = [];
  for (const rule of spec.rules) {
    const field = recoverRule(ctx, rule, stored);
    if (field !== null) recovered.push(field);
    else if (!rule.optional && rule.default === undefined) {
      // A required field that is not present cannot be re-authored; emitting the
      // call anyway would produce source that throws at compile time.
      return null;
    }
  }
  recovered.push(...envelopeEntries(spec, stored));

  // Leanest first: a field sitting at its rule default reads as noise, and the
  // proof below is what licenses dropping it.
  const candidates: Recovered[][] = [];
  const lean = recovered.filter((entry) => !entry.isDefault);
  if (lean.length < recovered.length) candidates.push(lean);
  candidates.push(recovered);

  for (const sPath of SPATHS_BY_NAME.get(stored.name) ?? []) {
    const factory = leafOf(sPath);
    if (!factory) continue;
    for (const candidate of candidates) {
      const authored: Record<string, unknown> = {};
      for (const entry of candidate) authored[entry.field] = entry.runtime;

      let encoded: StackItemXdo;
      try {
        encoded = encodeStatement(factory(authored));
      } catch {
        continue;
      }
      if (!sameStatement(encoded, stored)) continue;

      ctx.use(CORE_MODULE, "s");
      const args = candidate.length > 0 ? [obj(candidate.map((e) => [e.field, e.expr]))] : [];
      return call(`s.${sPath}`, ...args);
    }
  }
  return null;
}
