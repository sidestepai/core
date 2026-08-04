/**
 * `UsageError` — a failure the user can fix by typing something different.
 *
 * The distinction that matters at the process boundary: a UsageError means the
 * CLI never got far enough to try, so printing the relevant help block is
 * useful. Every other error means the command ran and failed, where a wall of
 * usage text is noise. `bin.ts` renders the two differently on that basis.
 *
 * Thrown (not printed) so `run()` stays a library function — the exported entry
 * that tests drive directly — with rendering and exit codes owned by the bin.
 * The renderer lives here too ({@link reportFailure}) rather than in `bin.ts`,
 * which is unimportable from a test: it calls `run()` at module scope.
 */
import { error, detail, stderrStyle } from "./ui.js";
import { renderHelpFor, indentBlock } from "./help.js";
import { getCommand, getSubcommand, liveCommandNames, liveSubcommandNames, suggest } from "./commands.js";

/**
 * Which help block belongs with this failure. An empty object means the global
 * command reference; omitting `helpFor` entirely means no block at all, for the
 * failures whose message already says everything useful.
 */
export interface HelpTarget {
  command?: string;
  subcommand?: string;
}

export class UsageError extends Error {
  override readonly name = "UsageError";
  /** The help block to print under the message. */
  readonly helpFor: HelpTarget | undefined;
  /** A closest-match hint (`Did you mean: details`), when one is close enough. */
  readonly suggestion: string | undefined;

  constructor(message: string, opts: { helpFor?: HelpTarget; suggestion?: string } = {}) {
    super(message);
    this.helpFor = opts.helpFor;
    this.suggestion = opts.suggestion;
  }
}

/** Narrow an unknown catch binding. */
export function isUsageError(err: unknown): err is UsageError {
  return err instanceof UsageError;
}

// ── Constructors ────────────────────────────────────────────────────────────
//
// Every unknown-* failure is built here, from the registry. Nothing downstream
// hand-writes a list of valid commands or verbs, so a list can never go stale
// against the dispatch it describes.

/** `sidestep <not-a-command>` — or a command that once existed and no longer does. */
export function unknownCommand(name: string): UsageError {
  const removed = getCommand(name)?.removed;
  if (removed !== undefined) return new UsageError(removed, { helpFor: {} });
  return new UsageError(`Unknown command "${name}".`, {
    helpFor: {},
    suggestion: suggest(name, liveCommandNames()),
  });
}

/** `sidestep <noun> <not-a-verb>` — the family's help block lists the real ones. */
export function unknownSubcommand(command: string, sub: string | undefined): UsageError {
  const removed = sub !== undefined ? getSubcommand(command, sub)?.removed : undefined;
  if (removed !== undefined) return new UsageError(removed, { helpFor: { command } });
  const what = sub === undefined || sub === "" ? "no subcommand given" : `unknown subcommand "${sub}"`;
  return new UsageError(`\`sidestep ${command}\`: ${what}.`, {
    helpFor: { command },
    suggestion: sub !== undefined ? suggest(sub, liveSubcommandNames(command)) : undefined,
  });
}

/** A verb that was deliberately retired — the message explains where it went. */
export function removedSubcommand(command: string, sub: string): UsageError {
  const removed = getSubcommand(command, sub)?.removed;
  return new UsageError(removed ?? `\`sidestep ${command} ${sub}\` was removed.`, { helpFor: { command } });
}

/** A required positional the invocation didn't supply. */
export function missingArgument(
  arg: string,
  target: { command: string; subcommand?: string },
): UsageError {
  const where = target.subcommand ? `${target.command} ${target.subcommand}` : target.command;
  return new UsageError(`\`sidestep ${where}\`: missing required <${arg}>.`, { helpFor: target });
}

/**
 * Render any failure to STDERR in the CLI's own vocabulary: the `✗` headline,
 * a did-you-mean line when there is one, and — for a UsageError only — the help
 * block that lists what WOULD have worked.
 *
 * Everything lands on stderr, including the help block, so a failed run never
 * writes to the data channel a caller may be piping. Requested help goes to
 * stdout; help shown because something broke does not.
 */
export function reportFailure(err: unknown, version = ""): void {
  const s = stderrStyle();
  error(err instanceof Error ? err.message : String(err));
  if (!isUsageError(err)) return;
  if (err.suggestion !== undefined) {
    process.stderr.write("\n");
    detail(`Did you mean: ${s.cyan(err.suggestion)}`);
  }
  if (err.helpFor === undefined) return;
  process.stderr.write("\n" + indentBlock(renderHelpFor(err.helpFor, s, version)));
}
