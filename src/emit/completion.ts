/**
 * `sidestep completion <bash|zsh|fish>` — emit a shell completion script.
 *
 * Generated STATICALLY from the command registry: the script that lands in your
 * shell profile has the command, subcommand, and flag names baked in, so pressing
 * Tab costs nothing. The alternative — a script that shells out to
 * `sidestep __complete` on every keystroke — pays a Node startup (~80ms) per Tab,
 * which is exactly the latency budget completion has to live inside. The tradeoff
 * is that the script goes stale on upgrade; `completion` is cheap to re-run, and
 * the install snippets below pipe it through a file you can regenerate.
 *
 * Pure string building over the registry — no `node:*`, no I/O. Lazily imported
 * by the command layer since almost no run needs it.
 */
import {
  FLAGS,
  flagKey,
  getCommand,
  liveCommandNames,
  liveSubcommandNames,
  type ArgSpec,
  type CommandSpec,
  type FlagSpec,
  type FlagRef,
} from "./commands.js";

/** The shells we emit for. */
export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/** Whether `s` names a shell we can emit for. */
export function isCompletionShell(s: string): s is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(s);
}

/**
 * The completable tokens in a flag spec: `--out, -o <path>` → `--out -o`.
 * Placeholders never match — `<ephemeral|sandbox>`, `KEY=VALUE`, and `<p>` carry
 * no leading dash — so the display string doubles as the token source and there
 * is no second list to keep in sync.
 */
function flagTokens(ref: FlagRef): string[] {
  const spec = FLAGS[flagKey(ref) as keyof typeof FLAGS]?.spec ?? "";
  return spec.match(/-{1,2}[a-z][a-z-]*/g) ?? [];
}

/** Every flag token a command (or one of its verbs) accepts. */
function tokensFor(flags: readonly FlagRef[] | undefined): string[] {
  return (flags ?? []).flatMap(flagTokens);
}

/** Whether this scope's positionals want filesystem paths. */
function wantsPaths(args: readonly ArgSpec[] | undefined): boolean {
  return (args ?? []).some((a) => a.path === true);
}

/**
 * The closed set the FIRST positional accepts, when it has one (`completion
 * <shell>`). Only the first: later positionals are all free-form here, and
 * tracking position across interleaved flags is more machinery than the one
 * command that would use it justifies.
 */
function argValues(args: readonly ArgSpec[] | undefined): string[] {
  return [...(args?.[0]?.values ?? [])];
}

/** `[flag token, allowed values]` for every flag in this scope with a closed set. */
function valuedFlags(flags: readonly FlagRef[] | undefined): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = [];
  for (const ref of flags ?? []) {
    const spec = FLAGS[flagKey(ref) as keyof typeof FLAGS] as FlagSpec | undefined;
    if (!spec || spec.values === undefined) continue;
    for (const token of flagTokens(ref)) out.push([token, [...spec.values]]);
  }
  return out;
}

/** A one-line description safe to embed in any of the three scripts. */
function describe(text: string): string {
  return text
    .replace(/`/g, "")
    .replace(/[:]/g, " -") // zsh's `_describe` treats `:` as the name/description separator
    .replace(/\s+/g, " ")
    .trim();
}

/** Single-quote for POSIX-ish shells, closing and reopening around any quote. */
function sq(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Every scope we complete: the bare command, plus `command sub` for each verb. */
interface Scope {
  /** `deploy`, or `workspace codegen`. */
  readonly key: string;
  readonly flags: string[];
  readonly paths: boolean;
  /** The closed set its first positional accepts, if any. */
  readonly values: string[];
  /** Flags in this scope that accept a closed set of values. */
  readonly valued: Array<[string, string[]]>;
}

function scopes(): Scope[] {
  const out: Scope[] = [];
  for (const name of liveCommandNames()) {
    const spec = getCommand(name)!;
    out.push({
      key: name,
      flags: tokensFor(spec.flags),
      paths: wantsPaths(spec.args),
      values: argValues(spec.args),
      valued: valuedFlags(spec.flags),
    });
    for (const verb of liveSubcommandNames(name)) {
      const sub = spec.subcommands![verb]!;
      out.push({
        key: `${name} ${verb}`,
        flags: tokensFor(sub.flags),
        paths: wantsPaths(sub.args),
        values: argValues(sub.args),
        valued: valuedFlags(sub.flags),
      });
    }
  }
  return out;
}

/** `[name, description]` for every top-level command. */
function commandRows(): Array<[string, string]> {
  return liveCommandNames().map((n) => [n, describe(getCommand(n)!.summary)]);
}

/** `[verb, description]` for a family, or an empty list for a leaf command. */
function subcommandRows(command: string): Array<[string, string]> {
  const spec = getCommand(command) as CommandSpec | undefined;
  return liveSubcommandNames(command).map((v) => [v, describe(spec!.subcommands![v]!.summary)]);
}

// ── bash ────────────────────────────────────────────────────────────────────

function renderBash(): string {
  const commands = liveCommandNames().join(" ");
  const subLines = liveCommandNames()
    .filter((c) => liveSubcommandNames(c).length > 0)
    .map((c) => `    ${c}) echo ${sq(liveSubcommandNames(c).join(" "))} ;;`);
  const flagLines = scopes()
    .filter((s) => s.flags.length > 0)
    .map((s) => `    ${sq(s.key)}) echo ${sq(s.flags.join(" "))} ;;`);
  // `case` alternatives are `|`-separated — a space-separated list parses as one
  // pattern containing spaces and bash rejects it outright.
  const pathLines = scopes()
    .filter((s) => s.paths)
    .map((s) => sq(s.key))
    .join("|");

  const valueLines = scopes()
    .filter((s) => s.values.length > 0)
    .map((s) => `    ${sq(s.key)}) echo ${sq(s.values.join(" "))} ;;`);
  const flagValueLines = scopes()
    .flatMap((s) => s.valued.map(([token, values]) => [`${s.key} ${token}`, values] as const))
    .map(([k, values]) => `    ${sq(k)}) echo ${sq(values.join(" "))} ;;`);

  // bash has no per-candidate descriptions, so this is names only. `compgen -f`
  // handles the path positions; everything else completes from the lists above.
  return `# sidestep completion for bash. Regenerate after upgrading:
#   sidestep completion bash > ~/.sidestep-completion.bash
#   echo 'source ~/.sidestep-completion.bash' >> ~/.bashrc

_sidestep_subcommands() {
  case "$1" in
${subLines.join("\n")}
  esac
}

_sidestep_flags() {
  case "$1" in
${flagLines.join("\n")}
  esac
}

_sidestep_argvalues() {
  case "$1" in
${valueLines.join("\n")}
  esac
}

_sidestep_flagvalues() {
  case "$1" in
${flagValueLines.join("\n")}
  esac
}

_sidestep() {
  local cur cmd sub scope
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmd="\${COMP_WORDS[1]}"
  sub="\${COMP_WORDS[2]}"
  COMPREPLY=()

  # Position 1 is always the command.
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W ${sq(commands)} -- "$cur") )
    return
  fi

  # Position 2 under a noun command is its verb.
  local subs
  subs="$(_sidestep_subcommands "$cmd")"
  if [ "$COMP_CWORD" -eq 2 ] && [ -n "$subs" ]; then
    COMPREPLY=( $(compgen -W "$subs" -- "$cur") )
    return
  fi

  scope="$cmd"
  if [ -n "$subs" ]; then scope="$cmd $sub"; fi

  # A dash starts a flag; anything else is a positional.
  case "$cur" in
    -*)
      COMPREPLY=( $(compgen -W "$(_sidestep_flags "$scope")" -- "$cur") )
      return
      ;;
  esac

  # Directly after a flag that takes a closed set, offer that set.
  local prev values
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  values="$(_sidestep_flagvalues "$scope $prev")"
  if [ -n "$values" ]; then
    COMPREPLY=( $(compgen -W "$values" -- "$cur") )
    return
  fi

  values="$(_sidestep_argvalues "$scope")"
  if [ -n "$values" ]; then
    COMPREPLY=( $(compgen -W "$values" -- "$cur") )
    return
  fi

  case "$scope" in
    ${pathLines || "''"}) COMPREPLY=( $(compgen -f -- "$cur") ) ;;
  esac
}

complete -o default -F _sidestep sidestep
`;
}

// ── zsh ─────────────────────────────────────────────────────────────────────

function renderZsh(): string {
  const commandBlock = commandRows()
    .map(([n, d]) => `    ${sq(`${n}:${d}`)}`)
    .join("\n");

  const familyBlocks = liveCommandNames()
    .filter((c) => liveSubcommandNames(c).length > 0)
    .map((c) => {
      const rows = subcommandRows(c)
        .map(([v, d]) => `        ${sq(`${v}:${d}`)}`)
        .join("\n");
      return `      ${c})\n        _sidestep_verbs=(\n${rows}\n        )\n        ;;`;
    })
    .join("\n");

  const flagBlocks = scopes()
    .filter((s) => s.flags.length > 0)
    .map((s) => `      ${sq(s.key)}) _sidestep_flags=(${s.flags.map(sq).join(" ")}) ;;`)
    .join("\n");

  const pathBlock = scopes()
    .filter((s) => s.paths)
    .map((s) => sq(s.key))
    .join("|");

  const valueBlocks = scopes()
    .filter((s) => s.values.length > 0)
    .map((s) => `      ${sq(s.key)}) compadd ${s.values.map(sq).join(" ")}; return ;;`)
    .join("\n");

  const flagValueBlocks = scopes()
    .flatMap((s) => s.valued.map(([token, values]) => [`${s.key} ${token}`, values] as const))
    .map(([k, values]) => `      ${sq(k)}) compadd ${values.map(sq).join(" ")}; return ;;`)
    .join("\n");

  return `#compdef sidestep
# sidestep completion for zsh. Regenerate after upgrading:
#   sidestep completion zsh > "\${fpath[1]}/_sidestep"
#   # …then restart your shell, or: autoload -U compinit && compinit

_sidestep() {
  local -a _sidestep_commands _sidestep_verbs _sidestep_flags
  local cmd sub scope
  _sidestep_commands=(
${commandBlock}
  )

  if (( CURRENT == 2 )); then
    _describe -t commands 'sidestep command' _sidestep_commands
    return
  fi

  cmd="\${words[2]}"
  case "$cmd" in
${familyBlocks}
  esac

  if (( CURRENT == 3 )) && (( \${#_sidestep_verbs} )); then
    _describe -t subcommands "sidestep $cmd subcommand" _sidestep_verbs
    return
  fi

  scope="$cmd"
  if (( \${#_sidestep_verbs} )); then
    sub="\${words[3]}"
    scope="$cmd $sub"
  fi

  case "$scope" in
${flagBlocks}
  esac

  if [[ "\${words[CURRENT]}" == -* ]]; then
    compadd -a _sidestep_flags
    return
  fi

  # Directly after a flag that takes a closed set, offer that set.
  case "$scope \${words[CURRENT-1]}" in
${flagValueBlocks}
  esac

  case "$scope" in
${valueBlocks}
  esac

  case "$scope" in
    ${pathBlock || "'__none__'"}) _files ;;
  esac
}

_sidestep "$@"
`;
}

// ── fish ────────────────────────────────────────────────────────────────────

function renderFish(): string {
  const lines: string[] = [
    "# sidestep completion for fish. Regenerate after upgrading:",
    "#   sidestep completion fish > ~/.config/fish/completions/sidestep.fish",
    "",
    // Without this, fish offers files at every position.
    "complete -c sidestep -f",
    "",
  ];

  for (const [name, desc] of commandRows()) {
    lines.push(`complete -c sidestep -n __fish_use_subcommand -a ${sq(name)} -d ${sq(desc)}`);
  }

  for (const command of liveCommandNames()) {
    const verbs = subcommandRows(command);
    if (verbs.length === 0) continue;
    lines.push("");
    for (const [verb, desc] of verbs) {
      lines.push(
        `complete -c sidestep -n ${sq(`__fish_seen_subcommand_from ${command}; and not __fish_seen_subcommand_from ${verbs.map(([v]) => v).join(" ")}`)} -a ${sq(verb)} -d ${sq(desc)}`,
      );
    }
  }

  lines.push("");
  for (const scope of scopes()) {
    if (scope.flags.length === 0 && !scope.paths && scope.values.length === 0) continue;
    const words = scope.key.split(" ");
    const condition = `__fish_seen_subcommand_from ${words.join(" ")}`;
    const values = new Map(scope.valued);
    for (const token of scope.flags) {
      // fish wants the flag name without dashes, long vs short split.
      const bare = token.replace(/^-+/, "");
      const which = token.startsWith("--") ? "-l" : "-s";
      const set = values.get(token);
      const suffix = set ? ` -r -a ${sq(set.join(" "))}` : "";
      lines.push(`complete -c sidestep -n ${sq(condition)} ${which} ${sq(bare)}${suffix}`);
    }
    if (scope.values.length > 0) {
      lines.push(`complete -c sidestep -n ${sq(condition)} -a ${sq(scope.values.join(" "))}`);
    }
    if (scope.paths) lines.push(`complete -c sidestep -n ${sq(condition)} -F`);
  }

  return lines.join("\n") + "\n";
}

/** Render the completion script for one shell. */
export function renderCompletion(shell: CompletionShell): string {
  switch (shell) {
    case "bash":
      return renderBash();
    case "zsh":
      return renderZsh();
    case "fish":
      return renderFish();
  }
}

/** The `completion` command: write the script to stdout (it is the requested artifact). */
export function runCompletionCommand(shell: CompletionShell): void {
  process.stdout.write(renderCompletion(shell));
}
