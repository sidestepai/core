/**
 * Offline filter-name validation (issue #106).
 *
 * The typed `fl.*` surface only exposes runtime-resolvable filters, but the raw
 * `filter(name, …)` escape hatch accepts any string. A name the engine can't
 * resolve type-checks and exports clean, then 500s on the first live request with
 * `Unable to locate func entry: <name>`. This walks a compiled bundle, collects
 * every `filters[].name`, and flags any that is not in the resolvable catalog —
 * turning a runtime 500 into an export-time warning (or a `--strict` failure).
 *
 * Browser-safe: no node imports; the allowlist is the generated `FILTER_NAMES`.
 */
import { FILTER_NAMES } from "../values/generated/filters.generated.js";

/** One unresolvable filter usage found in a bundle. */
export interface FilterNameFinding {
  /** The offending filter name. */
  name: string;
  /** Best-effort owning object (nearest named ancestor), for an actionable message. */
  location: string;
  /** Closest resolvable name(s), when one is an obvious fix (`to_upper` → `upper`). */
  suggestions: string[];
}

const RESOLVABLE = new Set<string>(FILTER_NAMES);

/** Levenshtein distance, single-row DP — only used to rank a short suggestion list. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/**
 * Up to two likely-intended resolvable names for an unresolvable one. Prefers a
 * substring relationship (`to_upper` contains `upper`) then small edit distance,
 * so the common rename/prefix footguns get a precise "did you mean".
 */
export function suggestFilterNames(name: string): string[] {
  // Affix rename: one name is the other minus a short prefix/suffix — the exact
  // shape of the real footguns (`to_upper`→`upper`, `keys`→`array_keys`). Bound
  // the affix to 6 chars so an unrelated name that merely ends in a filter word
  // (`..._a_filter`) doesn't spuriously match.
  const AFFIX_MAX = 6;
  const affix = (long: string, short: string): boolean =>
    (long.startsWith(short) || long.endsWith(short)) && long.length - short.length <= AFFIX_MAX;
  const substr = FILTER_NAMES.filter((r) =>
    name.length >= r.length ? affix(name, r) : affix(r, name),
  ).sort((a, b) => Math.abs(a.length - name.length) - Math.abs(b.length - name.length));
  if (substr.length) return substr.slice(0, 2);
  return FILTER_NAMES.map((r) => ({ r, d: editDistance(name, r) }))
    .filter((x) => x.d <= 2)
    .sort((a, b) => a.d - b.d)
    .slice(0, 2)
    .map((x) => x.r);
}

/**
 * Walk any compiled-bundle value and collect every unresolvable `filters[].name`.
 * Generic over the bundle shape: recurses all objects/arrays, and wherever a
 * `filters` array holds `{name}` entries, checks each name. `context` carries the
 * nearest non-empty ancestor `name` so a finding points at its owning object.
 */
export function findUnresolvableFilters(bundle: unknown): FilterNameFinding[] {
  const findings: FilterNameFinding[] = [];
  const seen = new Set<string>(); // dedupe identical name+location pairs

  const walk = (node: unknown, context: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, context);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;

    // A non-empty `name` at this level names the enclosing object (function,
    // query, …) — carry it down as the location for nested filters. Skip kind
    // markers like `mvp:set_var` (they carry a `:`); we want the object name.
    const nm = obj.name;
    const nextContext = typeof nm === "string" && nm !== "" && !nm.includes(":") ? nm : context;

    const filters = obj.filters;
    if (Array.isArray(filters)) {
      for (const f of filters) {
        const fname = (f as { name?: unknown })?.name;
        if (typeof fname === "string" && fname !== "" && !RESOLVABLE.has(fname)) {
          const key = `${fname}@${nextContext}`;
          if (!seen.has(key)) {
            seen.add(key);
            findings.push({ name: fname, location: nextContext || "(unknown)", suggestions: suggestFilterNames(fname) });
          }
        }
      }
    }

    for (const value of Object.values(obj)) walk(value, nextContext);
  };

  walk(bundle, "");
  return findings;
}
