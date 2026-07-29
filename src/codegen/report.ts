/**
 * Decode reporting — one computation, three sinks.
 *
 * Anything the decoder could not represent faithfully has to reach the user
 * loudly and specifically (R9). It reaches them three ways: as structured
 * entries, as a section in the generated README, and as the CLI summary. All
 * three read from a single `summarize()` so a README claiming "3 raw fallbacks"
 * can never disagree with a CLI claiming 4.
 */

/** What kind of problem an entry records. */
export type ReportCategory =
  /** A statement fell through to `raw()` instead of a typed call. */
  | "raw-fallback"
  /** A value was emitted as an annotated literal instead of a `c.*`/`ref` call. */
  | "value-fallback"
  /** A guid referenced by an object is not present in the bundle. */
  | "unresolved-ref"
  /** A non-empty payload section this SDK models no kind for. */
  | "unsupported-section"
  /** Runtime verification found a re-export that does not match the source bundle. */
  | "verify-mismatch"
  /**
   * A secret or server-assigned value the SDK deliberately did not carry into
   * the generated tree. Informational — it does not mean anything went wrong.
   */
  | "expected-omission"
  /**
   * A body-bearing object arrived with no body, so its generated def is an
   * identity stub. Informational: the decode was faithful — the object really is
   * empty upstream. It is reported because the output is indistinguishable from
   * a decode failure, and without a line here the only way to tell them apart is
   * to go read the workspace.
   */
  | "empty-source"
  /**
   * The stored form was a superseded one and the tree emits the CURRENT form
   * instead. Not a failure and not a silent cleanup: the whole reason this has
   * its own category is that a modernization can change what a value evaluates
   * to, so it has to be visible without being alarming. Warning severity —
   * "read this line and confirm you want it", not "this output is broken".
   */
  | "modernized";

/**
 * How much a category should worry the reader.
 *
 * The report used to carry categories only, which left every consumer to invent
 * its own split — the CLI hardcoded "everything except expected-omission is a
 * problem", and the sweep tool kept a second list that could disagree with it.
 * Severity is that judgment, made once, here.
 */
export type ReportSeverity =
  /** The generated tree does not reproduce its source. Acting on it is unsafe. */
  | "error"
  /** Faithful, but degraded or changed in a way that wants a human glance. */
  | "warning"
  /** Purely informational — nothing to decide, nothing to fix. */
  | "notice";

/**
 * Category display order and label — ordered by severity, so the entries that
 * mean "this output is wrong" sit above the ones that mean "this output is ugly".
 * Stable regardless of insertion order.
 */
const CATEGORY_LABELS: ReadonlyArray<readonly [ReportCategory, string, ReportSeverity]> = [
  ["verify-mismatch", "Round-trip mismatches", "error"],
  ["unresolved-ref", "References that could not be resolved", "error"],
  ["raw-fallback", "Statements emitted as raw() passthroughs", "warning"],
  ["unsupported-section", "Unsupported payload sections", "warning"],
  ["value-fallback", "Values emitted as annotated literals", "warning"],
  ["modernized", "Updated to the current form (evaluates differently)", "warning"],
  ["expected-omission", "Deliberately not carried into the tree", "notice"],
  ["empty-source", "Objects that were already empty in the source", "notice"],
];

/** How each severity is prefixed in the two renderings. */
const SEVERITY_LABEL: Readonly<Record<ReportSeverity, string>> = {
  error: "ERROR",
  warning: "WARN",
  notice: "note",
};

/** Severity for a category — the single source both the CLI and tooling read. */
export function severityOf(category: ReportCategory): ReportSeverity {
  return CATEGORY_LABELS.find(([c]) => c === category)?.[2] ?? "warning";
}

/** One thing the decoder could not represent faithfully. */
export interface ReportEntry {
  readonly category: ReportCategory;
  /** The object it happened in, e.g. `function:signup` (or `bundle`). */
  readonly object: string;
  /** Where inside that object, e.g. `stack[2].context.where`. */
  readonly path?: string;
  readonly detail: string;
}

/** Entries for one category, with its count. */
export interface ReportGroup {
  readonly category: ReportCategory;
  readonly label: string;
  readonly severity: ReportSeverity;
  readonly count: number;
  readonly entries: readonly ReportEntry[];
}

/** The single computed view every rendering derives from. */
export interface ReportSummary {
  readonly total: number;
  /** Counts by severity, so a caller never has to enumerate categories itself. */
  readonly bySeverity: Readonly<Record<ReportSeverity, number>>;
  /** Non-empty categories only, in `CATEGORY_LABELS` order. */
  readonly byCategory: readonly ReportGroup[];
}

/** `object` + optional `path`, as shown to the user. */
function location(entry: ReportEntry): string {
  return entry.path ? `${entry.object} → ${entry.path}` : entry.object;
}

/** Collects decode problems and renders them for every surface that shows them. */
export class DecodeReport {
  readonly #entries: ReportEntry[] = [];

  /** Record a problem. */
  add(entry: ReportEntry): void {
    this.#entries.push(entry);
  }

  /** A position in the entry log, for {@link rewind}. */
  mark(): number {
    return this.#entries.length;
  }

  /**
   * Drop every entry recorded since `mark`. Used to discard a speculative decode
   * attempt, so the report describes what was emitted rather than what was tried.
   */
  rewind(mark: number): void {
    this.#entries.length = mark;
  }

  /** Every entry, in the order it was recorded. */
  get entries(): readonly ReportEntry[] {
    return this.#entries;
  }

  /** Group and count. The one computation both renderings read. */
  summarize(): ReportSummary {
    const byCategory: ReportGroup[] = [];
    const bySeverity: Record<ReportSeverity, number> = { error: 0, warning: 0, notice: 0 };
    for (const [category, label, severity] of CATEGORY_LABELS) {
      const entries = this.#entries.filter((e) => e.category === category);
      if (entries.length === 0) continue;
      byCategory.push({ category, label, severity, count: entries.length, entries });
      bySeverity[severity] += entries.length;
    }
    return { total: this.#entries.length, bySeverity, byCategory };
  }

  /** The generated README's report section. Empty string when there is nothing to say. */
  renderMarkdown(): string {
    const summary = this.summarize();
    if (summary.total === 0) return "";
    const lines: string[] = ["## What did not round-trip cleanly", ""];
    for (const group of summary.byCategory) {
      lines.push(`### ${SEVERITY_LABEL[group.severity]} ${group.label} [${group.category}=${group.count}]`, "");
      for (const entry of group.entries) lines.push(`- \`${location(entry)}\` — ${entry.detail}`);
      lines.push("");
    }
    return lines.join("\n");
  }

  /** The CLI summary. Empty string when there is nothing to say. */
  renderCli(): string {
    const summary = this.summarize();
    if (summary.total === 0) return "";
    const lines: string[] = [];
    for (const group of summary.byCategory) {
      lines.push(`  ${SEVERITY_LABEL[group.severity]} ${group.label} [${group.category}=${group.count}]`);
      for (const entry of group.entries) lines.push(`    ${location(entry)} — ${entry.detail}`);
    }
    return lines.join("\n");
  }
}
