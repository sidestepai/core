/**
 * Help rendering, driven entirely by the command registry (`commands.ts`).
 *
 * Every function here RETURNS a string rather than writing one, for two reasons:
 * the same block goes to stdout when help was requested and to stderr when it
 * accompanies a failure, and a returned value is what tests can assert on.
 *
 * Column widths are computed on the RAW strings and the color is applied after
 * padding — ANSI escape codes count as characters to `padEnd`, so coloring first
 * silently skews every column. The rest of the CLI's aligned output does the
 * same thing for the same reason.
 */
import {
  COMMANDS,
  FLAGS,
  HELP_GROUP_ORDER,
  getCommand,
  getSubcommand,
  liveSubcommandNames,
  flagKey,
  flagSummary,
  type ArgSpec,
  type CommandSpec,
  type FlagRef,
  type SubcommandSpec,
} from "./commands.js";
import { stdoutStyle, type Palette } from "./ui.js";

/** Two-column rows, padded on the raw name then dimmed/colored. */
function table(
  rows: ReadonlyArray<readonly [string, string]>,
  s: Palette,
  indent = "  ",
  fixedWidth?: number,
): string[] {
  const width = fixedWidth ?? Math.max(0, ...rows.map(([name]) => name.length));
  return rows.map(([name, desc]) => `${indent}${s.cyan(name.padEnd(width))}  ${s.dim(desc)}`);
}

/** `<file>` when required, `[dir]` when not. */
function renderArgs(args: readonly ArgSpec[] | undefined): string {
  return (args ?? []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
}

/** The `Flags` block for a command or subcommand, or nothing when it takes none. */
function flagSection(flags: readonly FlagRef[] | undefined, s: Palette): string[] {
  if (!flags || flags.length === 0) return [];
  const rows = flags
    .filter((ref) => Object.hasOwn(FLAGS, flagKey(ref)))
    .map((ref) => [FLAGS[flagKey(ref) as keyof typeof FLAGS].spec, flagSummary(ref)] as const);
  if (rows.length === 0) return [];
  return ["", s.bold("Flags"), ...table(rows, s)];
}

/** Trailing example line, or nothing. */
function exampleSection(example: string | undefined, s: Palette): string[] {
  return example ? ["", s.bold("Example"), `  ${s.dim(example)}`] : [];
}

/**
 * The grouped command reference — what bare `sidestep`, `sidestep help`, and
 * `sidestep --help` print. Removed commands and aliases are hidden: this is the
 * menu of what to type, not an inventory.
 */
export function renderGlobalHelp(s: Palette = stdoutStyle(), version = ""): string {
  // Rows per group: the command itself, plus any subcommand that asked to be
  // surfaced in a group of its own (the `codegen` variants under "Pull").
  const byGroup = new Map<string, Array<readonly [string, string]>>();
  const push = (group: string, row: readonly [string, string]) => {
    const rows = byGroup.get(group) ?? [];
    rows.push(row);
    byGroup.set(group, rows);
  };
  for (const [name, spec] of Object.entries(COMMANDS) as Array<[string, CommandSpec]>) {
    if (spec.removed === undefined && spec.aliasOf === undefined) push(spec.group, [spec.display, spec.summary]);
    for (const sub of Object.values(spec.subcommands ?? {})) {
      if (sub.group === undefined || sub.removed !== undefined) continue;
      push(sub.group, [sub.display ?? `${name} ${sub.summary}`, sub.groupSummary ?? sub.summary]);
    }
  }

  // One column width across ALL groups, not per group — the reference reads as
  // a single table broken by headings, which is how it has always rendered.
  const width = Math.max(0, ...[...byGroup.values()].flat().map(([n]) => n.length));
  const lines: string[] = [
    `${s.bold("sidestep")}${version ? ` ${s.dim(`v${version}`)}` : ""} — the AI-first SDK & CLI for Xano backends`,
    "",
    `${s.dim("Usage:")} sidestep ${s.cyan("<command>")} ${s.dim("[options]")}`,
  ];
  for (const group of HELP_GROUP_ORDER) {
    const rows = byGroup.get(group);
    if (!rows || rows.length === 0) continue;
    lines.push("", s.bold(group), ...table(rows, s, "  ", width));
  }
  lines.push(
    "",
    s.dim("Run `sidestep <command> --help` for a command's arguments and flags."),
    s.dim("Docs: https://www.npmjs.com/package/@sidestep/core"),
  );
  return lines.join("\n") + "\n";
}

/**
 * Help for one command: its summary, usage, subcommands (families only), the
 * flags it accepts, and an example. Falls back to global help for a name the
 * registry doesn't know, so a help request never dead-ends.
 */
export function renderCommandHelp(command: string, s: Palette = stdoutStyle()): string {
  const spec = getCommand(command);
  if (!spec) return renderGlobalHelp(s);
  const subs = liveSubcommandNames(command);
  const usage =
    subs.length > 0
      ? `sidestep ${command} <subcommand> ${s.dim("[options]")}`
      : `sidestep ${command}${renderArgs(spec.args) ? ` ${renderArgs(spec.args)}` : ""} ${s.dim("[options]")}`;

  const lines: string[] = [`${s.bold(`sidestep ${command}`)} — ${spec.summary}`, "", `${s.dim("Usage:")} ${usage}`];

  if (subs.length > 0) {
    const rows = subs.map((name) => {
      const sub = getSubcommand(command, name)!;
      const args = renderArgs(sub.args);
      return [args ? `${name} ${args}` : name, sub.summary] as const;
    });
    lines.push("", s.bold("Subcommands"), ...table(rows, s));
  }

  lines.push(...flagSection(spec.flags, s));
  lines.push(...exampleSection(spec.example, s));

  if (subs.length > 0) {
    lines.push("", s.dim(`Run \`sidestep ${command} <subcommand> --help\` for a subcommand's flags.`));
  }
  return lines.join("\n") + "\n";
}

/**
 * Help for one verb under a noun command. Falls back to the parent's help when
 * the verb is unknown — the parent block is what lists the valid ones.
 */
export function renderSubcommandHelp(command: string, sub: string, s: Palette = stdoutStyle()): string {
  const spec: SubcommandSpec | undefined = getSubcommand(command, sub);
  if (!spec || spec.removed !== undefined) return renderCommandHelp(command, s);
  const args = renderArgs(spec.args);
  const lines: string[] = [
    `${s.bold(`sidestep ${command} ${sub}`)} — ${spec.summary}`,
    "",
    `${s.dim("Usage:")} sidestep ${command} ${sub}${args ? ` ${args}` : ""} ${s.dim("[options]")}`,
  ];
  lines.push(...flagSection(spec.flags, s));
  lines.push(...exampleSection(spec.example, s));
  return lines.join("\n") + "\n";
}

/**
 * The block that belongs with a usage failure: subcommand-scoped when a verb was
 * named, command-scoped when only a command was, global otherwise.
 */
export function renderHelpFor(
  target: { command?: string; subcommand?: string } | undefined,
  s: Palette,
  version = "",
): string {
  if (target?.command === undefined) return renderGlobalHelp(s, version);
  if (target.subcommand !== undefined) return renderSubcommandHelp(target.command, target.subcommand, s);
  return renderCommandHelp(target.command, s);
}

/** Indent a rendered block so it sits under an error headline. */
export function indentBlock(text: string, indent = "  "): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? line : indent + line))
    .join("\n");
}
