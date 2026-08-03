/**
 * `src/codegen` — the decode direction: Xano bundle JSON → SideStep TypeScript.
 *
 * Decode is a plain function layer, not a `decode()` method on `ObjectKind`
 * (KTD-1): it needs bundle-wide context (the guid index, the current file's
 * imports, the report) rather than the pure unary shape `encode(def)` has, and
 * putting it on the kinds would drag the printer and every decoder into the
 * browser-safe authoring bundle.
 *
 * `decodeBundle` is pure and offline — no network, no filesystem. Writing the
 * tree and fetching a bundle from a live environment are the CLI's job.
 */
import { DecodeContext } from "./context.js";
import { DecodeReport } from "./report.js";
import { RefIndex } from "./ref-index.js";
import { assembleProject } from "./project.js";
import { PAYLOAD_ARRAY_KEYS } from "../workspace/export.js";
import { omissionSeverity, UNSUPPORTED_SECTIONS } from "./omissions.js";

export { DecodeContext, ImportCollector, CORE_MODULE, CODEGEN_MODULE } from "./context.js";
export { DecodeReport } from "./report.js";
export { RefIndex, resolveReference } from "./ref-index.js";
export type { IndexedObject, ResolveOptions } from "./ref-index.js";
export { assembleProject, toSymbol } from "./project.js";
export type { ReportCategory, ReportEntry, ReportGroup, ReportSummary } from "./report.js";
export { printExpr, printModule, id, lit, call, obj, arr, arrow } from "./print.js";
export type { Expr, Stmt, ImportStmt } from "./print.js";

/** One file in the generated tree, at a path relative to the output directory. */
export interface GeneratedFile {
  /** Relative POSIX path, e.g. `functions/signup.ts`. */
  readonly path: string;
  readonly contents: string;
}

/** The result of decoding a bundle: a tree of source files plus what went wrong. */
export interface GeneratedProject {
  readonly files: readonly GeneratedFile[];
  readonly report: DecodeReport;
}

/**
 * Every payload key this decoder knows about — the canonical export key set plus
 * the two scalars that are not object arrays. Derived from the export side rather
 * than restated, so a key added there cannot silently become "unknown" here.
 */
const KNOWN_PAYLOAD_KEYS: ReadonlySet<string> = new Set<string>([
  ...PAYLOAD_ARRAY_KEYS,
  ...Object.keys(UNSUPPORTED_SECTIONS),
  "partial",
  "workspace",
]);

/**
 * Decode a Xano `packageExport` bundle into a tree of SideStep source files.
 *
 * Pure and offline — no network, no filesystem. Writing the tree, fetching a
 * bundle from a live environment, and verifying the round trip are the CLI's job.
 */
export function decodeBundle(bundle: { payload: Record<string, unknown> }): GeneratedProject {
  const ctx = new DecodeContext();
  const payload = bundle.payload ?? {};
  const refs = RefIndex.fromPayload(payload, ctx);

  for (const [section, policy] of Object.entries(UNSUPPORTED_SECTIONS)) {
    const entries = payload[section];
    if (Array.isArray(entries) && entries.length > 0) {
      // Severity comes from the policy's own reason, so the list that decides
      // what is omitted is the list that decides how loudly to say so. Only an
      // `unmodeled` section is a gap in the pull; the rest are correct absences.
      ctx.problem(
        omissionSeverity(policy.reason) === "warning" ? "unsupported-section" : "instance-owned",
        `payload.${section} has ${entries.length} ${
          entries.length === 1 ? "entry that is" : "entries that are"
        } not carried into the generated tree — ${policy.detail}`,
      );
    }
  }

  // A key this SDK has never seen is the "anything Xano ships after this release"
  // case. It cannot be modelled, but it must not read as if the tree were
  // complete either — silence here is exactly the failure R9 exists to prevent.
  for (const [key, value] of Object.entries(payload)) {
    if (KNOWN_PAYLOAD_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    ctx.problem(
      "unsupported-section",
      `payload.${key} is not a payload section this SDK knows; it is not carried into the generated tree`,
    );
  }

  return { files: assembleProject(ctx, refs, payload), report: ctx.report };
}
