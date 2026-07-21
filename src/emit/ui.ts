/**
 * Minimal, zero-dependency stderr UI for the CLI's human-facing progress output.
 *
 * Everything here writes to STDERR so stdout stays a clean data channel (a piped
 * bundle from `export`, the import response from `push`). Color is emitted only
 * when stderr is a TTY and the user hasn't opted out — honoring the `NO_COLOR`
 * convention (https://no-color.org) and `FORCE_COLOR` for the opposite — so piped
 * or CI logs stay plain ASCII with no escape-sequence noise.
 */

/** Whether to emit ANSI color: a real terminal, not opted out, or force-enabled. */
const useColor =
  process.env.FORCE_COLOR
    ? process.env.FORCE_COLOR !== "0"
    : !process.env.NO_COLOR && process.stderr.isTTY === true;

function paint(code: string, s: string): string {
  return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}

/** Small ANSI palette (no-ops when color is disabled). */
export const style = {
  bold: (s: string) => paint("1", s),
  dim: (s: string) => paint("2", s),
  green: (s: string) => paint("32", s),
  red: (s: string) => paint("31", s),
  yellow: (s: string) => paint("33", s),
  cyan: (s: string) => paint("36", s),
};

/** A primary progress step (`→ …`). */
export function step(msg: string): void {
  process.stderr.write(`${style.cyan("→")} ${msg}\n`);
}

/** A successful outcome (`✓ …`, green). */
export function success(msg: string): void {
  process.stderr.write(`${style.green("✓")} ${msg}\n`);
}

/** A non-fatal warning (`! …`, yellow). */
export function warn(msg: string): void {
  process.stderr.write(`${style.yellow("!")} ${msg}\n`);
}

/**
 * An informational FYI (`i …`, cyan) — guidance, not a problem. Distinct from
 * {@link warn}'s yellow `!` so a clean run's advisories don't scan as warnings
 * in CI logs. Still on stderr, so stdout stays a clean data channel.
 */
export function info(msg: string): void {
  process.stderr.write(`${style.cyan("i")} ${msg}\n`);
}

/** A dim, indented detail line under the preceding step/outcome. */
export function detail(msg: string): void {
  process.stderr.write(`  ${style.dim(msg)}\n`);
}

/**
 * A highlighted, indented URL under the preceding outcome — bold cyan so the
 * deploy's payoff (the backend + static-host URLs you'll actually open) stands
 * out from the dim {@link detail} lines around it.
 */
export function link(url: string): void {
  process.stderr.write(`  ${style.bold(style.cyan(url))}\n`);
}

/** A blank separator line. */
export function blank(): void {
  process.stderr.write("\n");
}

/**
 * A human-friendly label for an origin: drop the scheme (and any trailing slash)
 * so `https://app.xano.com/` reads as `app.xano.com`. Falls back to the raw
 * string if it isn't a parseable URL.
 */
export function hostLabel(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}
