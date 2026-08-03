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
  /**
   * A RETIRED version of a versioned statement family, carried verbatim on
   * purpose. Informational — nothing failed: the platform keeps these running
   * for existing stacks but no longer offers them, so this SDK models only the
   * latest of each family (see `SUPERSEDED_STATEMENTS`).
   */
  | "superseded"
  /** A value was emitted as an annotated literal instead of a `c.*`/`ref` call. */
  | "value-fallback"
  /**
   * A guid referenced by an object is not present in the bundle, and the
   * reference is one this SDK would otherwise have resolved. Error severity:
   * the generated tree does not reproduce its source.
   *
   * Narrow on purpose. This category used to absorb three other causes — an
   * unportable internal id, a binding that is blank upstream, and a reference
   * stored by name — each of which round-trips exactly. They shared one
   * severity, so the loudest cause set the tone for all of them and 371 rows
   * across the survey corpus read as "acting on this output is unsafe" when
   * none of them meant it. They are {@link ReportCategory}'s `unportable-id`,
   * `blank-binding`, and `name-bound-ref` now.
   */
  | "unresolved-ref"
  /**
   * A reference stored as an INTERNAL id rather than portable identity — a
   * `guid 0`, or a `customize` block naming its target by local row id.
   *
   * Notice severity, and the reason is that there is nothing to decide. An
   * internal row id is not identity that survives leaving the workspace, so
   * carrying it as `raw()`/unbound is the only faithful reading; no authoring
   * choice, no upstream fix, and no re-deploy would change it. It is reported
   * at all only because the output is otherwise indistinguishable from a
   * reference the decoder simply failed to follow.
   */
  | "unportable-id"
  /**
   * A statement or attachment whose binding is blank upstream — a `db.*`
   * pointing at no table, a `function.run` pointing at no fn, an addon
   * attachment pointing at no addon. Recovered as `null`.
   *
   * Warning severity, NOT notice. The decode is faithful and `null`
   * re-encodes to exactly what was stored, so nothing is lost — but the
   * workspace has a statement wired to a target that no longer exists, and
   * emitting that silently would let a lost binding pass as a deliberate
   * choice. The thing to fix is upstream rather than in the generated tree,
   * which is what makes it a warning and not an error.
   *
   * Coalesced per object by {@link COALESCE_BY_OBJECT}: one workspace in the
   * survey corpus carries 48 of these, and 48 lines saying the same sentence
   * about one workspace is not 48 times the signal.
   */
  | "blank-binding"
  /**
   * A reference stored by NAME rather than by guid, which this SDK resolves by
   * guid only. Carried verbatim, so the bytes are preserved.
   *
   * Warning severity: the output is faithful, but the reference is not linked
   * to its target's symbol and a re-deploy will not re-link it. Two readings
   * fit — an older workspace whose stored spelling the engine still honours, or
   * a target that was deleted or re-keyed — and the entry states both, because
   * nothing here can tell them apart.
   */
  | "name-bound-ref"
  /**
   * A non-empty payload section this SDK models no kind for, or a payload key it
   * has never seen. Warning: a real Xano object type is absent from the tree, so
   * the pull is incomplete and the reader should know it.
   */
  | "unsupported-section"
  /**
   * A payload section deliberately not carried into the tree because it belongs
   * to the instance, not the workspace — vault secrets, install history,
   * marketplace provenance, the current-branch pointer.
   *
   * Notice, and the split from `unsupported-section` is the point. "We chose not
   * to carry this" and "we don't know what this is" are different sentences, and
   * folding them together made 49 vault-and-history rows across the survey
   * corpus read as gaps in the pull. Codegen is not a backup tool; these are
   * recoverable only from the live workspace, and that is by design.
   */
  | "instance-owned"
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
   * A statement that stores an entirely empty context — added to a stack and
   * never configured. Emitted as `raw()`.
   *
   * Notice, and it is the statement-level twin of `empty-source`: the decode is
   * faithful, and there is nothing to recover because there is nothing there.
   * Filed as `raw-fallback` before, where six rows across the survey corpus
   * claimed a decoder had failed to reproduce a statement whose entire content
   * is `{}`. Reported at all for the same reason `empty-source` is — the output
   * is indistinguishable from a decode failure, and without a line here the only
   * way to tell them apart is to go read the workspace.
   */
  | "unconfigured-stub"
  /**
   * The stored form was a superseded one and the tree emits the CURRENT form
   * instead. Not a failure and not a silent cleanup: the whole reason this has
   * its own category is that a modernization can change what a value evaluates
   * to, so it has to be visible without being alarming. Warning severity —
   * "read this line and confirm you want it", not "this output is broken".
   */
  | "modernized"
  /**
   * A condition whose terms do not all join the same way (`a AND b OR c`). The
   * decode is EXACT — `mixed(...)` reproduces the stored joins term by term —
   * but the stored form does not record which grouping was meant, and the two
   * places such a condition can appear read it differently (a branch folds left
   * to right; a database query applies AND-before-OR precedence). Warning
   * severity: nothing is broken and nothing was lost, but the condition is worth
   * rewriting as nested `and(...)`/`or(...)` so it says what it means.
   */
  | "ambiguous-condition"
  /**
   * A `{param}` segment in an object's path had no input bound to it upstream,
   * and the generated def declares one so the tree builds.
   *
   * Xano treats an unbound `{param}` as an inert part of the route string, so
   * this is legal upstream — but SideStep refuses to author it, and emitting it
   * faithfully would produce a project that throws on import. The synthesized
   * input is the one place codegen deliberately does NOT reproduce its source,
   * which is exactly why it gets a line: deploying the generated tree back BINDS
   * that segment, and the reader has to know that.
   */
  | "path-param-bound";

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
  ["blank-binding", "Bindings that are blank upstream", "warning"],
  ["name-bound-ref", "References stored by name, not by guid", "warning"],
  ["superseded", "Retired statement versions, carried verbatim", "notice"],
  ["modernized", "Updated to the current form (evaluates differently)", "warning"],
  ["ambiguous-condition", "Conditions that mix AND and OR at one level", "warning"],
  ["path-param-bound", "Unbound {param} segments given an input", "warning"],
  ["expected-omission", "Deliberately not carried into the tree", "notice"],
  ["empty-source", "Objects that were already empty in the source", "notice"],
  ["unconfigured-stub", "Statements that were never configured", "notice"],
  ["unportable-id", "Internal ids that are not portable identity", "notice"],
  ["instance-owned", "Instance state, deliberately not carried as source", "notice"],
];

/**
 * Categories rendered as one entry per OBJECT rather than one per site.
 *
 * A per-site entry is the right unit for a cause a reader acts on individually.
 * It is the wrong unit for a cause that repeats mechanically within one object —
 * every column of a lost table, every statement against a deleted fn — where the
 * count is a property of the object's size rather than of how much went wrong.
 *
 * Coalescing happens in {@link DecodeReport.summarize}, not at the call site, for
 * the same reason severity does: the decoder does not know when it is finished
 * with an object, and a second aggregation living in the CLI could disagree with
 * the README's. {@link DecodeReport.entries} is left untouched, so tooling that
 * wants every site still has it.
 */
const COALESCE_BY_OBJECT: ReadonlySet<ReportCategory> = new Set<ReportCategory>(["blank-binding"]);

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
  /**
   * What the entry is about, in one or two words — `db.query`, `function.run`,
   * `addon "comments"`. Optional, and only meaningful for a category in
   * {@link COALESCE_BY_OBJECT}, which lists the distinct subjects it saw rather
   * than repeating one sentence per site.
   *
   * Carried as a field rather than parsed back out of `detail`: the coalesced
   * line would otherwise be built by regexing prose that exists to be read by a
   * human, and every future rewording of that prose would silently degrade it.
   */
  readonly subject?: string;
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

/**
 * One entry per object, listing the distinct subjects seen within it.
 *
 * The `path` is dropped deliberately: it named a single site, and this entry no
 * longer stands for a single site. The count comes along so a reader can tell
 * one lost binding from twelve without the report printing twelve lines.
 *
 * Order is first-seen, matching the order the decoder walked the object — the
 * rest of this module preserves record order for the same reason, so a report
 * reads in the same sequence as the tree it describes.
 */
function coalesceByObject(entries: readonly ReportEntry[]): ReportEntry[] {
  const byObject = new Map<string, ReportEntry[]>();
  for (const entry of entries) {
    const found = byObject.get(entry.object);
    if (found) found.push(entry);
    else byObject.set(entry.object, [entry]);
  }
  return [...byObject].map(([object, group]) => {
    if (group.length === 1) return group[0]!;
    const subjects = [...new Set(group.map((e) => e.subject).filter((s) => s !== undefined))];
    const named = subjects.length > 0 ? `${subjects.join(", ")} — ` : "";
    return {
      category: group[0]!.category,
      object,
      detail: `${named}${group.length} references in this object are blank upstream, recovered as \`null\`. The targets were deleted, or the bindings were never made. Fix them upstream, or bind them`,
    };
  });
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
    let total = 0;
    for (const [category, label, severity] of CATEGORY_LABELS) {
      const found = this.#entries.filter((e) => e.category === category);
      if (found.length === 0) continue;
      const entries = COALESCE_BY_OBJECT.has(category) ? coalesceByObject(found) : found;
      byCategory.push({ category, label, severity, count: entries.length, entries });
      bySeverity[severity] += entries.length;
      total += entries.length;
    }
    return { total, bySeverity, byCategory };
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
