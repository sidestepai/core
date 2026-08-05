/**
 * Classifies the enum-constrained field values held in STORED workspace bytes.
 *
 * The encode-time guard (`src/statements/schema-dsl/enum-guard.ts`) refuses a
 * constant outside a field's declared set. That is the intended behavior for
 * something an author just typed — but the same code path runs on the source
 * `codegen` EMITS for a pulled workspace. If any real workspace stores a value
 * the current schema does not list, its own emitted source would refuse to
 * re-encode: a working pull/push cycle turned into a hard failure.
 *
 * So the guard is only trustworthy to the extent stored bytes have been checked
 * against it. This walker is that check, shared by two callers so they cannot
 * drift: a test over the vendored fixture corpus (small, deterministic, always
 * runs) and `codegen-replay` over a sweep's bundles (broad, needs a capture).
 *
 * It reports rather than judges. A value is only counted as `outOfSet` when it
 * is statically decidable AND absent from the set — the same three exemptions
 * the guard itself makes (dynamic tag, filter chain, the empty/unconfigured
 * value), because a value the guard would not check cannot break re-encoding.
 */
import { GENERATED_SPECS } from "../src/statements/generated/specs.generated.js";

export interface EnumAudit {
  /** Enum-bearing statements encountered. */
  statements: number;
  /** A checkable constant that IS in the declared set. */
  inSet: number;
  /** The empty (unconfigured) value — exempt, and the main round-trip hazard. */
  blank: number;
  /** A non-constant tag (inp/ref/env/…) — exempt, unknowable statically. */
  dynamic: number;
  /** A constant carrying filters — exempt, a filter can rewrite it. */
  filtered: number;
  /** A checkable constant NOT in the declared set — every one of these is a re-encode break. */
  outOfSet: number;
  /** One entry per distinct out-of-set value, with where it was found. */
  offenders: string[];
}

/** stored statement name → stored input name → declared values. */
function constrainedFields(): Map<string, Map<string, string[]>> {
  const index = new Map<string, Map<string, string[]>>();
  for (const spec of GENERATED_SPECS) {
    for (const rule of spec.rules) {
      if (!rule.enum || rule.route.kind !== "input") continue;
      if (!index.has(spec.name)) index.set(spec.name, new Map());
      index.get(spec.name)!.set(rule.route.name, rule.enum);
    }
  }
  return index;
}

export function emptyAudit(): EnumAudit {
  return { statements: 0, inSet: 0, blank: 0, dynamic: 0, filtered: 0, outOfSet: 0, offenders: [] };
}

/**
 * Walk arbitrary stored JSON (a bundle, a payload section, one fixture),
 * accumulating into `audit`. Statements nest arbitrarily deep inside loop and
 * conditional bodies, so this recurses over everything rather than assuming a
 * stack shape.
 */
export function auditStoredJson(node: unknown, where: string, audit: EnumAudit): void {
  const fields = constrainedFields();

  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const child of n) visit(child);
      return;
    }
    if (!n || typeof n !== "object") return;
    const obj = n as Record<string, unknown>;
    const constrained = typeof obj.name === "string" ? fields.get(obj.name) : undefined;

    if (constrained && Array.isArray(obj.input)) {
      audit.statements++;
      for (const raw of obj.input) {
        const entry = raw as { name?: string; tag?: string; value?: unknown; filters?: unknown[] };
        const values = entry.name ? constrained.get(entry.name) : undefined;
        if (!values) continue;

        if (entry.tag !== "const") {
          audit.dynamic++;
        } else if (Array.isArray(entry.filters) && entry.filters.length > 0) {
          audit.filtered++;
        } else if (entry.value === "") {
          audit.blank++;
        } else if (typeof entry.value === "string" && values.includes(entry.value)) {
          audit.inSet++;
        } else {
          audit.outOfSet++;
          audit.offenders.push(
            `${where}: ${obj.name}.${entry.name} = ${JSON.stringify(entry.value)} (declared: ${values.join(" | ")})`,
          );
        }
      }
    }
    for (const child of Object.values(obj)) visit(child);
  };

  visit(node);
}

/** One-line summary, for a script's stdout. */
export function formatAudit(audit: EnumAudit): string {
  return (
    `enum fields in stored bytes — statements: ${audit.statements}, ` +
    `in-set: ${audit.inSet}, blank: ${audit.blank}, dynamic: ${audit.dynamic}, ` +
    `filtered: ${audit.filtered}, OUT-OF-SET: ${audit.outOfSet}`
  );
}
