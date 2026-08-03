/**
 * Decode context — the per-run state every decoder plugs into.
 *
 * Decoding is not the mirror of `encode(def)`: a decoder deep inside a value
 * chain needs to record that the file being written now imports `fl`, and to
 * report a problem tagged with the object and stack path it is standing in.
 * Threading that through every signature would be noise, so it lives here.
 */
import type { ImportStmt } from "./print.js";
import { DecodeReport, type ReportCategory } from "./report.js";
import { noteDecline, takePendingDecline } from "./prove-diff.js";

/** The browser-safe authoring entry generated files import from. */
export const CORE_MODULE = "@sidestep/core";

/** The codegen entry `raw()` comes from — see KTD-10. */
export const CODEGEN_MODULE = "@sidestep/core/codegen";

/**
 * Import specifiers sort bare-first, then relative, each alphabetically — so a
 * file's import block is stable no matter what order decoders discovered symbols in.
 */
function moduleOrder(a: string, b: string): number {
  const relative = (m: string) => (m.startsWith(".") ? 1 : 0);
  return relative(a) - relative(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Accumulates the symbols one generated file imports. */
export class ImportCollector {
  readonly #value = new Map<string, Set<string>>();
  readonly #type = new Map<string, Set<string>>();

  /** Record a value import. Returns the symbol so callers can use it inline. */
  use(module: string, symbol: string): string {
    let symbols = this.#value.get(module);
    if (!symbols) this.#value.set(module, (symbols = new Set()));
    symbols.add(symbol);
    return symbol;
  }

  /** Record a type-only import. Returns the symbol. */
  useType(module: string, symbol: string): string {
    let symbols = this.#type.get(module);
    if (!symbols) this.#type.set(module, (symbols = new Set()));
    symbols.add(symbol);
    return symbol;
  }

  /** Fold this collector's symbols into another (used to commit an attempt). */
  mergeInto(target: ImportCollector): void {
    for (const [module, symbols] of this.#value) {
      for (const symbol of symbols) target.use(module, symbol);
    }
    for (const [module, symbols] of this.#type) {
      for (const symbol of symbols) target.useType(module, symbol);
    }
  }

  /** The file's import block, deduplicated and deterministically ordered. */
  toStatements(): ImportStmt[] {
    const out: ImportStmt[] = [];
    for (const module of [...this.#value.keys()].sort(moduleOrder)) {
      out.push({ kind: "import", module, symbols: [...this.#value.get(module)!].sort() });
    }
    for (const module of [...this.#type.keys()].sort(moduleOrder)) {
      out.push({
        kind: "import",
        module,
        symbols: [...this.#type.get(module)!].sort(),
        typeOnly: true,
      });
    }
    return out;
  }
}

/** The label report entries carry outside any object scope. */
const BUNDLE_SCOPE = "(bundle)";

/** Per-run decode state: the report, the current file's imports, and location. */
export class DecodeContext {
  readonly report = new DecodeReport();

  /** The import block of the file currently being generated. */
  imports = new ImportCollector();

  #object = BUNDLE_SCOPE;
  #path: string[] = [];

  /** Start a fresh import block. Called once per generated file. */
  beginFile(): ImportCollector {
    this.imports = new ImportCollector();
    return this.imports;
  }

  /** Record a symbol the current file imports. Returns the symbol. */
  use(module: string, symbol: string): string {
    return this.imports.use(module, symbol);
  }

  /**
   * Run a decode attempt whose result may be discarded.
   *
   * Dispatch tries several forms and keeps the first that provably re-encodes,
   * so a losing attempt must leave nothing behind — an unused import in a
   * generated file is dead weight at best, and a report entry describing an
   * attempt that was thrown away is simply false. Imports and problems are
   * buffered and merged only when `fn` returns a result.
   */
  speculate<T>(fn: () => T | null): T | null {
    const outerImports = this.imports;
    const mark = this.report.mark();
    this.imports = new ImportCollector();
    let result: T | null = null;
    try {
      result = fn();
      return result;
    } finally {
      const attempted = this.imports;
      this.imports = outerImports;
      if (result === null) this.report.rewind(mark);
      else attempted.mergeInto(this.imports);
    }
  }

  /** Record a type-only symbol the current file imports. Returns the symbol. */
  useType(module: string, symbol: string): string {
    return this.imports.useType(module, symbol);
  }

  /** Run `fn` with report entries attributed to `label` (e.g. `function:signup`). */
  inObject<T>(label: string, fn: () => T): T {
    const previousObject = this.#object;
    const previousPath = this.#path;
    this.#object = label;
    this.#path = [];
    try {
      return fn();
    } finally {
      // Restored in `finally` so a throwing decoder cannot leave later entries
      // mislabelled with a scope that is no longer in force.
      this.#object = previousObject;
      this.#path = previousPath;
    }
  }

  /** Run `fn` with `segment` appended to the reported path (e.g. `stack[2]`). */
  at<T>(segment: string, fn: () => T): T {
    this.#path.push(segment);
    try {
      return fn();
    } finally {
      this.#path.pop();
    }
  }

  /**
   * Record why this decode declined; last writer wins.
   *
   * Reserved for declines with a KNOWN, stable cause. A decoder that declined
   * because something surprised it should stay silent rather than guess.
   *
   * The note itself lives in `prove-diff`, because the other writer — a guard
   * several frames down inside a shared helper — has no context to reach. See
   * {@link noteDecline} for why there is exactly one store.
   */
  declined(why: string): null {
    return noteDecline(why);
  }

  /** Read and clear the pending decline note. */
  takeDeclineNote(): string | undefined {
    return takePendingDecline();
  }

  /**
   * Record a problem at the current object/path scope.
   *
   * `subject` names what the entry is about in a word or two, for the categories
   * the report coalesces per object. Optional everywhere else and ignored there.
   */
  problem(category: ReportCategory, detail: string, subject?: string): void {
    this.report.add({
      category,
      object: this.#object,
      ...(this.#path.length > 0 ? { path: this.#path.join(".") } : {}),
      detail,
      ...(subject !== undefined ? { subject } : {}),
    });
  }
}
