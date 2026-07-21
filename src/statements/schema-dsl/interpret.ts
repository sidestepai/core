/**
 * Schema-DSL interpreter (U9). Turns a declarative statement schema's
 * `transform` rules into a runtime encoder, so the ~169 declarative statements
 * are driven by data (a `StatementSpec`) rather than hand-written per statement.
 *
 * A `StatementSpec` is a flat list of `FieldRule`s — one per authored field the
 * statement consumes — mirroring the engine's `transform.args` / `transform.blocks`
 * entries. Each rule says where one authored field lands in the stored statement:
 *  - `route: { kind: "as" }`             → the statement's top-level `as`.
 *  - `route: { kind: "context-plain" }`  → a plain string written at `context.<path>`.
 *  - `route: { kind: "context-spread" }` → a Value's `{value,tag,filters}` spread
 *      directly into `context` (the `!assign context` rule).
 *  - `route: { kind: "context-nest" }`   → a Value's `{value,tag,filters}` nested
 *      under `context.<path>` (the `!assign context.<key>` rule).
 *
 * Rules carry optionality + an optional string `default` (the schema's `?=X`).
 * `output` (whether the stored item carries `output:{filters:[]}`) is NOT
 * derivable from the transform schema — it is engine statement-class metadata
 * (e.g. `uuid4` has an `as` but no `output`; `return` has a value block but no
 * `output`). The codegen pins it from the persisted golden fixture (KTD-4),
 * never guessing.
 *
 * Validated against real persisted fixtures (math_add, bitwise_and, object_keys,
 * array_push, array_pop). The codegen pipeline (scripts/codegen.ts) populates the
 * spec catalog from the cloud-client schema YAMLs; uninterpretable schemas are
 * logged, never guessed.
 */
import type { Statement } from "../statement.js";
import { registerStatement } from "../statement.js";
import type { Value } from "../../values/value.js";
import { leanInput } from "../lean-input.js";
import { encodeComparison } from "../conditional.js";
import type { Comparison } from "../conditional.js";

/**
 * What kind of authored value a field consumes:
 *  - `string`     — a plain `static:text`/`bool` arg.
 *  - `value`      — a `!kinds assign` tagged Value.
 *  - `comparison` — a binary `Comparison` (the `!compare` directive).
 */
export type FieldType = "string" | "value" | "comparison";

/** Where one authored field lands in the stored statement. */
export type Route =
  | { kind: "as" }
  | { kind: "context-plain"; path: string }
  | { kind: "context-spread" }
  | { kind: "context-nest"; path: string }
  | { kind: "context-compare"; path: string }
  | { kind: "input"; name: string };

/**
 * Per-statement envelope shape, pinned from the persisted fixture (KTD-4) — the
 * engine-class metadata that isn't in the transform schema. "Full" statements
 * (api_request, db ops, file ops) carry richer `input[]` entries and extra
 * top-level keys; lean statements (math, array, object) carry none of these.
 */
export interface EnvelopeProfile {
  /** `input[]` entries carry `ignore/expand/children` (vs the lean `{name,value,tag,filters}`). */
  inputFull?: boolean;
  /** Always emit `as` (default `""`) even when no rule sets it. */
  emitAs?: boolean;
  /** Emit `description:""`. */
  description?: boolean;
  /** Emit `settings_registry:[]`. */
  settingsRegistry?: boolean;
  /** Emit `addon:[]`. */
  addon?: boolean;
  /** `output` is the rich `{customize:false,filters:[],items:[]}` (vs lean `{filters:[]}`). */
  richOutput?: boolean;
}

/** One authored field → its routing into the stored statement. */
export interface FieldRule {
  /** Authored field name (e.g. "as", "name", "value", "filename"). */
  field: string;
  /** String arg vs Value(assign) — determines how `default`/missing is handled. */
  type: FieldType;
  /** Optional in authoring (the schema's trailing `?`). */
  optional: boolean;
  /** Literal default for string fields when not provided (the schema's `?=X`). */
  default?: string;
  /** Routing target. */
  route: Route;
}

export interface StatementSpec {
  /** Stored statement name, e.g. "mvp:math_add". */
  name: string;
  /** Marks the engine's argNameIsVar family (informational; does not affect encoding). */
  argNameIsVar?: boolean;
  /** Ordered field rules. */
  rules: FieldRule[];
  /** Emit `output` when true (pinned from the golden fixture; shape per `envelope.richOutput`). */
  output?: boolean;
  /** Per-statement envelope shape pinned from the fixture; absent = lean. */
  envelope?: EnvelopeProfile;
}

/**
 * Authored `output` envelope shaping (the frontend's "Output" tab). Any of the
 * three stored members may be set; omitted members keep their empty default.
 * `filters` attaches a filter chain to the result variable; `customize`/`items`
 * drive response field-mapping. Merged over the spec's default `output` shape.
 */
export interface OutputAuthored {
  filters?: unknown[];
  customize?: boolean;
  items?: unknown[];
}

/**
 * Authored inputs for a spec-driven statement, keyed by field name. Besides the
 * spec's rule fields, two reserved envelope keys are honored when the spec's
 * envelope permits them: `description` (a per-statement description string, the
 * frontend "Settings" tab) and `output` (an {@link OutputAuthored} shaping the
 * result envelope). No engine statement routes a rule field named `description`
 * or `output`, so these names are unambiguous.
 */
export type Authored = Record<
  string,
  string | Value | Comparison | OutputAuthored | undefined
>;

function valueFields(v: Value): { value: string; tag: string; filters: unknown[] } {
  return { value: v.value, tag: v.tag, filters: v.filters };
}

/**
 * A `context-nest` value block (`error`, `payload`, `array`, …). Unlike an
 * expression operand or a `context-spread`, the engine schema types `filters`
 * here WITHOUT a default (`filters[]: mvp_filter`, then `XS::optional`), so the
 * persisted form omits the key entirely when empty and keeps it only when a
 * filter is attached (verified against the live xdo corpus: 19/19 precondition
 * `error` blocks are `{tag,value}` with no `filters`). Mirror that.
 */
function nestedValueFields(v: Value): Record<string, unknown> {
  const fields: Record<string, unknown> = { value: v.value, tag: v.tag };
  if (Array.isArray(v.filters) && v.filters.length > 0) fields.filters = v.filters;
  return fields;
}

/** Shallow-copy only the defined own keys of an object (drops `undefined`). */
function pickDefined(o: OutputAuthored): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** Write `value` at a dotted `path` inside `obj`, creating intermediate objects. */
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (typeof cur[key] !== "object" || cur[key] === null) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** Build a statement `input[]` argument binding from an authored Value. */
function inputEntry(name: string, v: Value, full: boolean): Record<string, unknown> {
  const entry: Record<string, unknown> = { ...leanInput(name, v) };
  if (full) {
    entry.ignore = false;
    entry.expand = false;
    entry.children = [];
  }
  return entry;
}

/** Encode authored inputs into a `Statement` using a spec's field rules. */
export function encodeFromSpec(spec: StatementSpec, authored: Authored): Statement {
  const env = spec.envelope;
  const context: Record<string, unknown> = {};
  const input: Record<string, unknown>[] = [];
  let as: string | undefined;

  for (const rule of spec.rules) {
    let provided = authored[rule.field];
    if (provided === undefined) {
      if (rule.default !== undefined && rule.type === "string") {
        provided = rule.default;
      } else if (rule.optional || rule.default !== undefined) {
        // Optional, or a value-field with a default we can't synthesize → omit.
        continue;
      } else {
        throw new Error(`Statement "${spec.name}": required field "${rule.field}" is missing.`);
      }
    }
    switch (rule.route.kind) {
      case "as":
        as = provided as string;
        break;
      case "context-plain":
        setPath(context, rule.route.path, provided);
        break;
      case "context-spread":
        Object.assign(context, valueFields(provided as Value));
        break;
      case "context-nest":
        setPath(context, rule.route.path, nestedValueFields(provided as Value));
        break;
      case "context-compare":
        setPath(context, rule.route.path, encodeComparison(provided as Comparison));
        break;
      case "input":
        input.push(inputEntry(rule.route.name, provided as Value, env?.inputFull ?? false));
        break;
    }
  }

  const stmt: Statement = { name: spec.name, context, input };
  if (as !== undefined) stmt.as = as;
  else if (env?.emitAs) stmt.as = "";
  if (env?.description) {
    // Reserved envelope key: an authored per-statement description, else "".
    const d = authored.description;
    stmt.description = typeof d === "string" ? d : "";
  }
  if (env?.settingsRegistry) stmt.settings_registry = [];
  if (spec.output) {
    const base = env?.richOutput ? { customize: false, filters: [], items: [] } : { filters: [] };
    // Reserved envelope key: authored output shaping merged over the default.
    const authoredOut = authored.output as OutputAuthored | undefined;
    stmt.output = authoredOut ? { ...base, ...pickDefined(authoredOut) } : base;
  }
  if (env?.addon) stmt.addon = [];
  return stmt;
}

/** Register a spec on the statement registry; returns its factory. */
export function registerSpec(spec: StatementSpec): (authored: Authored) => Statement {
  const factory = (authored: Authored): Statement => encodeFromSpec(spec, authored);
  registerStatement(spec.name, factory);
  return factory;
}
