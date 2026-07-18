/**
 * Statement model, base envelope encoder, and registry (U5 — the KTD-4
 * extensibility seam).
 *
 * The real stored statement shape (from the golden fixture's `run[0]`) is lean:
 * `{name, as?, context, input}`. The base encoder fills the common envelope
 * (`input: []` default) so each concrete statement factory only declares its
 * `name`, optional `as`, and `context`. The registry maps statement name →
 * factory so the eventual ~500-statement catalog plugs in here.
 */
import type { StackItemXdo } from "../types/xdo.js";

/** What a statement factory returns before base-envelope encoding. */
export interface Statement {
  name: string;
  as?: string;
  context: unknown;
  input?: unknown[];
  /** `output` envelope. Lean (`{filters:[]}`) or rich (`{customize,filters,items}`) forms are both accepted and normalized to the full rich form. */
  output?: unknown;
  /** Statement description (defaults to `""`). */
  description?: string;
  /** Settings-registry bindings (defaults to `null`). */
  settings_registry?: unknown[] | null;
  /** Attached addons (defaults to `[]`). */
  addon?: unknown[];
  /** Async/runtime block (e.g. `mvp:call_agent`'s `{ mode }`); defaults to `null`. */
  runtime?: unknown;
  /** Mock overrides keyed by branch/test (defaults to `{}`). */
  mocks?: unknown;
  /** Whether the statement is disabled in the stack (defaults to `false`). */
  disabled?: boolean;
}

/** Registry of known statement names → factory (for catalog extensibility). */
const registry = new Map<string, (...args: any[]) => Statement>();

/** Register a statement factory under its stored `name` (e.g. `mvp:set_var`). */
export function registerStatement(
  name: string,
  factory: (...args: any[]) => Statement,
): void {
  registry.set(name, factory);
}

/** True when a statement name has a registered factory. */
export function isRegisteredStatement(name: string): boolean {
  return registry.has(name);
}

/** Look up a registered factory, throwing a clear error when absent. */
export function getStatementFactory(name: string): (...args: any[]) => Statement {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(
      `Unknown statement "${name}". Registered: ${[...registry.keys()].join(", ") || "(none)"}`,
    );
  }
  return factory;
}

/**
 * Normalize a statement `input[]` entry to the full stored binding shape. The
 * persisted form is uniform across every statement type — `{name, value, tag,
 * filters, ignore, expand, children}` — so any missing members are filled with
 * their defaults (confirmed against live `mvp_query`/`mvp_tool`: 100% of entries
 * carry all seven keys).
 */
function fullInputEntry(raw: unknown): Record<string, unknown> {
  const e = (raw ?? {}) as Record<string, unknown>;
  return {
    name: e.name,
    value: e.value,
    tag: e.tag,
    filters: e.filters ?? [],
    ignore: e.ignore ?? false,
    expand: e.expand ?? false,
    children: e.children ?? [],
  };
}

/**
 * Encode a statement into the stored `StackItemXdo`, filling the **full**
 * persisted envelope. Every stored statement carries the same 12 keys
 * regardless of type (confirmed against live `mvp_query`/`mvp_tool`), so the
 * envelope is uniform here rather than per-statement: empty members are emitted
 * with their canonical defaults so the output is 1:1 with the engine's
 * persisted form. `_xsid` is engine-generated on import; we emit `""` (the
 * stored placeholder) so the key is present for comparison.
 */
export function encodeStatement(stmt: Statement): StackItemXdo {
  if (!isRegisteredStatement(stmt.name)) {
    throw new Error(
      `Cannot encode unregistered statement "${stmt.name}". ` +
        `Registered: ${[...registry.keys()].join(", ") || "(none)"}`,
    );
  }
  // `output` is always the rich `{items, filters, customize}` form in the
  // persisted corpus; merge any authored output (lean or rich) over the default.
  const output = {
    items: [],
    filters: [],
    customize: false,
    ...((stmt.output ?? {}) as Record<string, unknown>),
  };
  // The persisted form stores an empty settings-registry as `null` (not `[]`);
  // the older parser fixtures emit `[]`. Canonicalize empty → null so the raw
  // output matches the engine; a populated binding list is kept verbatim.
  const sr = stmt.settings_registry;
  const settings_registry = sr == null || (Array.isArray(sr) && sr.length === 0) ? null : sr;
  return {
    as: stmt.as ?? "",
    name: stmt.name,
    _xsid: "",
    addon: stmt.addon ?? [],
    input: (stmt.input ?? []).map(fullInputEntry),
    mocks: stmt.mocks ?? {},
    output,
    context: stmt.context,
    runtime: stmt.runtime ?? null,
    disabled: stmt.disabled ?? false,
    description: stmt.description ?? "",
    settings_registry,
  };
}
