/**
 * Minimal, zero-dependency stderr UI for the CLI's human-facing progress output.
 *
 * Everything here writes to STDERR so stdout stays a clean data channel (a piped
 * bundle from `export`, the import response from `push`). Color is emitted only
 * when stderr is a TTY and the user hasn't opted out — honoring the `NO_COLOR`
 * convention (https://no-color.org) and `FORCE_COLOR` for the opposite — so piped
 * or CI logs stay plain ASCII with no escape-sequence noise.
 */

/** Color-capable iff a real terminal on `isTTY`, not opted out (NO_COLOR), or force-enabled. */
function resolveColor(isTTY: boolean | undefined): boolean {
  return process.env.FORCE_COLOR
    ? process.env.FORCE_COLOR !== "0"
    : !process.env.NO_COLOR && isTTY === true;
}

/** A `style`-shaped ANSI palette whose color is gated on `on`. */
function makePalette(on: boolean) {
  const paint = (code: string, s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    bold: (s: string) => paint("1", s),
    dim: (s: string) => paint("2", s),
    green: (s: string) => paint("32", s),
    red: (s: string) => paint("31", s),
    yellow: (s: string) => paint("33", s),
    cyan: (s: string) => paint("36", s),
  };
}

/** The shape every helper here (and the help renderer) paints through. */
export type Palette = ReturnType<typeof makePalette>;

/**
 * Small ANSI palette for the stderr progress UI (no-ops when color is disabled).
 * Color tracks STDERR, where every helper in this module writes.
 */
export const style = makePalette(resolveColor(process.stderr.isTTY));

/**
 * A palette for a human-facing view written to STDERR — the failure path's help
 * block. Built per call (rather than reusing {@link style}) so a test that flips
 * `NO_COLOR`/`FORCE_COLOR` mid-process sees the change; `style` is resolved once
 * at import time, which is right for the long-lived progress helpers and wrong
 * for a one-shot render.
 */
export function stderrStyle(): Palette {
  return makePalette(resolveColor(process.stderr.isTTY));
}

/**
 * A palette for a human-facing view a command prints to STDOUT (its data
 * channel) — so color tracks stdout's TTY, not stderr's. Built per call because
 * a command may only print to stdout when it detects a TTY there.
 */
export function stdoutStyle(): Palette {
  return makePalette(resolveColor(process.stdout.isTTY));
}

/**
 * Lay out label→value rows as an aligned, indented block (trailing newline
 * included). Labels are dimmed and padded to a common width so values line up;
 * values are passed through verbatim, so callers pre-color them as they like.
 * Padding is applied to the raw label BEFORE dimming, so ANSI codes never skew
 * the alignment.
 */
export function formatFields(rows: Array<[label: string, value: string]>): string {
  const s = stdoutStyle();
  const width = Math.max(0, ...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${s.dim(label.padEnd(width))}  ${value}`).join("\n") + "\n";
}

/** A primary progress step (`→ …`). */
export function step(msg: string): void {
  process.stderr.write(`${style.cyan("→")} ${msg}\n`);
}

/** A successful outcome (`✓ …`, green). */
export function success(msg: string): void {
  process.stderr.write(`${style.green("✓")} ${msg}\n`);
}

/**
 * A fatal outcome (`✗ …`, red). The counterpart to {@link success}: every way
 * the CLI can end now has a glyph, so a failed run reads as a designed state
 * rather than an unstyled sentence.
 */
export function error(msg: string): void {
  process.stderr.write(`${stderrStyle().red("✗")} ${msg}\n`);
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
 * Render an ephemeral expiry (the API serializes it as `"2026-07-24 20:49:15+0000"`,
 * or tolerate a raw unix-epoch number) as a human "in Xh Ym" string, or "expired"
 * once it has passed. Shared by `deploy`, `ephemeral list`, and `ephemeral get`
 * so the countdown reads identically everywhere. Falls back to the raw value if
 * it can't be parsed, and "—" when absent.
 */
export function formatExpiration(expiresAt: string | number | undefined | null): string {
  if (expiresAt === undefined || expiresAt === null || expiresAt === "") return "—";
  const ms = typeof expiresAt === "number" ? expiresAt * 1000 : Date.parse(String(expiresAt).replace(" ", "T"));
  if (Number.isNaN(ms)) return String(expiresAt);
  const diff = (ms - Date.now()) / 1000;
  if (diff <= 0) return "expired";
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  return `in ${hours}h ${minutes}m`;
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
