/**
 * Build-time diagnostics: one place that formats a finding, decides whether it
 * throws or warns, and lets a caller capture the whole set.
 *
 * Guards used to call `console.warn("sidestep: …")` inline at four sites, which
 * made each one individually untestable (spy on the console), inconsistently
 * formatted, and impossible to silence as a group. Every guard now records a
 * {@link Diagnostic} instead:
 *
 * - **error** — the engine rejects this shape 100% of the time, so the only
 *   thing an import can produce is a 500 after provisioning has begun.
 * - **warning** — the shape is usually-wrong (it loses data or disables a guard
 *   under the reading most authors intend) but has legitimate uses, following
 *   the `auth()`-on-a-public-host precedent.
 *
 * A {@link DiagnosticBag} collects a whole `export()` so an author sees *every*
 * violation at once rather than fixing one, re-running, and finding the next.
 */

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  /** Stable slug for the check (e.g. `"table.use-xdo"`), for tests and filtering. */
  readonly code: string;
  /** Author-facing text, WITHOUT the `sidestep:` prefix — {@link formatDiagnostic} adds it. */
  readonly message: string;
}

/** Where warnings go. Replaceable so tests capture them without spying on the console. */
export type DiagnosticSink = (diagnostic: Diagnostic) => void;

const consoleSink: DiagnosticSink = (diagnostic) => {
  console.warn(formatDiagnostic(diagnostic));
};

let sink: DiagnosticSink = consoleSink;

/**
 * Swap the warning sink; returns the previous one so a caller can restore it.
 * Pass nothing to restore the default `console.warn` sink. Passing a no-op is
 * how a caller silences the whole diagnostic set.
 */
export function setDiagnosticSink(next?: DiagnosticSink): DiagnosticSink {
  const previous = sink;
  sink = next ?? consoleSink;
  return previous;
}

/** The single message format every diagnostic shares. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  return `sidestep: ${diagnostic.message}`;
}

/**
 * Emit one diagnostic immediately — for guards that run at *encode* time, where
 * there is no enclosing export to collect into. A warning goes to the sink; an
 * error throws on the spot.
 */
export function emitDiagnostic(diagnostic: Diagnostic): void {
  if (diagnostic.severity === "error") throw new Error(formatDiagnostic(diagnostic));
  sink(diagnostic);
}

/**
 * Collects the diagnostics of one `export()`, then reports them as a set.
 *
 * Errors do not throw when recorded — {@link flush} throws once, listing all of
 * them. Fixing a workspace one export at a time is the failure mode this
 * exists to avoid.
 */
export class DiagnosticBag {
  private readonly items: Diagnostic[] = [];

  add(diagnostic: Diagnostic): void {
    this.items.push(diagnostic);
  }

  error(code: string, message: string): void {
    this.add({ severity: "error", code, message });
  }

  warn(code: string, message: string): void {
    this.add({ severity: "warning", code, message });
  }

  /** Everything recorded so far, in the order it was found. */
  all(): readonly Diagnostic[] {
    return [...this.items];
  }

  /**
   * Emit the warnings, then throw if anything was an error. Warnings are
   * emitted first and unconditionally: an author fixing the error still wants
   * to see the rest of what the build found.
   */
  flush(): void {
    for (const item of this.items) {
      if (item.severity === "warning") sink(item);
    }
    const errors = this.items.filter((item) => item.severity === "error");
    if (errors.length === 0) return;
    if (errors.length === 1) throw new Error(formatDiagnostic(errors[0]!));
    throw new Error(
      `sidestep: export failed with ${errors.length} errors.\n` +
        errors.map((error, i) => `  ${i + 1}. ${error.message}`).join("\n"),
    );
  }
}
