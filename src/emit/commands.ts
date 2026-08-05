/**
 * The CLI's command registry — the single source of truth for what `sidestep`
 * accepts.
 *
 * Three consumers read this table and nothing else:
 *   • `help.ts`  renders global and command-scoped help from it,
 *   • `cli.ts`   validates the command/subcommand a user typed against it,
 *   • the unknown-* errors list valid verbs from it (never a hand-written string).
 *
 * The dispatch chain in `cli.ts` still owns the lazy `await import(...)` per
 * command — deliberately, so the browser-safe authoring bundle never pulls in
 * the Node-only OAuth/deploy stack. A drift test pins the registry's keys to the
 * commands that chain actually compares against, so the two cannot diverge
 * silently even though they are written twice.
 *
 * Keep this module free of `node:*` imports for the same bundling reason.
 */

/** A flag's rendered spec plus its one-line description. */
export interface FlagSpec {
  /** How the flag is written, e.g. `--dest <sandbox|ephemeral>`. */
  readonly spec: string;
  readonly summary: string;
  /** The closed set this flag accepts, when it has one — shell completion offers these. */
  readonly values?: readonly string[];
}

/**
 * A command's reference to a flag: the {@link FLAGS} key, or the key plus a
 * summary that replaces the shared one. Several flags genuinely mean different
 * things per command — `--force` skips a confirmation for `ephemeral delete` but
 * overwrites a non-empty directory for `init` — and a scoped help page that
 * describes the wrong one is worse than no help at all.
 */
export type FlagRef = string | { readonly key: string; readonly summary: string };

/** A positional argument in a usage line. */
export interface ArgSpec {
  readonly name: string;
  readonly required: boolean;
  /** This argument names a file or directory — shell completion offers paths for it. */
  readonly path?: boolean;
  /** The closed set this argument accepts, when it has one — shell completion offers these. */
  readonly values?: readonly string[];
}

/** A verb under a noun command (`workspace details`, `ephemeral list`). */
export interface SubcommandSpec {
  readonly summary: string;
  readonly args?: readonly ArgSpec[];
  /** Keys into {@link FLAGS}, optionally with a command-specific summary. */
  readonly flags?: readonly FlagRef[];
  readonly example?: string;
  /** Set when the verb once existed and now fails loudly with this explanation. */
  readonly removed?: string;
  /**
   * Surface this verb as its own row in a global-help group. The three live
   * `codegen` variants earn a line in "Pull" even though their parents live
   * under "Environments" — pulling a workspace is the task you go looking for,
   * not the noun you'd think to type first.
   */
  readonly group?: HelpGroup;
  /** The name column for that row (required whenever `group` is set). */
  readonly display?: string;
  /** A one-line summary for that row, when the verb's own reads oddly out of context. */
  readonly groupSummary?: string;
}

/** A top-level command. */
export interface CommandSpec {
  /** Which global-help group it renders under. */
  readonly group: HelpGroup;
  readonly summary: string;
  /** The name column in global help, e.g. `deploy <file>`. */
  readonly display: string;
  readonly args?: readonly ArgSpec[];
  /** Keys into {@link FLAGS}, optionally with a command-specific summary. */
  readonly flags?: readonly FlagRef[];
  readonly subcommands?: Readonly<Record<string, SubcommandSpec>>;
  readonly example?: string;
  /** Set when the command once existed and now fails loudly with this explanation. */
  readonly removed?: string;
  /** Hidden from global help (aliases). Still resolvable for `--help` and dispatch. */
  readonly aliasOf?: string;
}

/** Global-help group titles, in render order. */
export const HELP_GROUP_ORDER = [
  "Author",
  "Deploy",
  "Pull",
  "Environments",
  "Account",
  "Maintenance",
] as const;

export type HelpGroup = (typeof HELP_GROUP_ORDER)[number];

/**
 * Every flag the CLI parses, described once. Commands reference these by key so
 * the shared ones (`--lock`, `--origin`, `--config`, `--local`) read identically
 * everywhere they appear.
 */
export const FLAGS = {
  out: { spec: "--out, -o <path>", summary: "Write the artifact to this path instead of stdout" },
  lock: { spec: "--lock[=<path>]", summary: "Use (and create) xano.lock — default: beside the entry file" },
  "frozen-lock": { spec: "--frozen-lock", summary: "CI guard: fail instead of changing the lock" },
  strict: { spec: "--strict", summary: "Promote export warnings (unresolvable filters) to a hard failure" },
  yes: { spec: "--yes, -y", summary: "Confirm a destructive action non-interactively" },
  bundle: { spec: "--bundle <path>", summary: "Use an already-exported bundle instead of an entry file" },
  reset: { spec: "--reset", summary: "Accepted but redundant — every deploy is a full replace" },
  dest: {
    spec: "--dest <ephemeral|sandbox>",
    summary: "Which environment to import into (default: ephemeral)",
    values: ["ephemeral", "sandbox"],
  },
  "expires-hours": { spec: "--expires-hours <n>", summary: "Ephemeral TTL at create time, 1–72 (default: 1)" },
  static: { spec: "--static <dir>", summary: "Archive this built frontend and deploy it to the static host" },
  "static-env": { spec: "--static-env KEY=VALUE", summary: "Public config baked in as window.<KEY> (repeatable; never secrets)" },
  "static-host": { spec: "--static-host <name>", summary: "Static-host name to deploy to (default: default)" },
  "no-verify": { spec: "--no-verify", summary: "Skip the post-deploy liveness checks (static host, microservices)" },
  origin: { spec: "--origin <origin>", summary: "Xano control-plane OAuth host (default: $XANO_ORIGIN)" },
  config: { spec: "--config <path>", summary: "Explicit credential file (default: $XANO_CONFIG)" },
  local: { spec: "--local", summary: "Use the project-local ./.xano/auth.json instead of the shared cache" },
  "all-workspaces": { spec: "--all-workspaces", summary: "Enumerate across every workspace, not just the token's" },
  guest: { spec: "--guest, -g", summary: "Mint a read-only guest session (browse only)" },
  "url-only": { spec: "--url-only, -u", summary: "Print the dashboard URL instead of opening a browser" },
  port: { spec: "--port <n>", summary: "Fixed loopback callback port (default: ephemeral)" },
  scope: { spec: "--scope \"<list>\"", summary: "OAuth scopes to request (default: the built-in set)" },
  runtime: { spec: "--runtime", summary: "After the round-trip, run each deployed function and report" },
  capture: { spec: "--capture", summary: "Write each round-tripped function's fetched JSON" },
  verbose: { spec: "--verbose", summary: "Print full diffs and raw engine detail" },
  instance: { spec: "--instance <url>", summary: "Override XANO_VALIDATE_INSTANCE for this run" },
  format: { spec: "--format <json|multidoc>", summary: "Which artifact to emit", values: ["json", "multidoc"] },
  path: { spec: "--path <p>", summary: "Output location — `-` for stdout, a dir, or a file path" },
  name: { spec: "--name <n>", summary: "Name for what this command produces" },
  ai: {
    spec: "--ai <preset>",
    summary: "AI instruction files to scaffold: claude, codex, cursor, none",
    values: ["claude", "codex", "cursor", "none"],
  },
  force: { spec: "--force", summary: "Scaffold into a non-empty directory (overwriting our own files)" },
  "no-install": { spec: "--no-install", summary: "Skip the post-scaffold npm install" },
} as const satisfies Record<string, FlagSpec>;

export type FlagKey = keyof typeof FLAGS;

/** Flags every authenticated command accepts, via `getAccessToken`. */
const AUTH = ["origin", "config", "local"] as const;

/** Flags every command that compiles an entry file accepts, via `compileBundle`. */
const COMPILE = ["lock", "frozen-lock", "strict"] as const;

/** Flags the scaffold-writing commands (`init`, `codegen`) share. */
const SCAFFOLD = [
  { key: "name", summary: "Project name (default: the target directory's basename)" },
  "ai",
  "force",
  "no-install",
] as const satisfies readonly FlagRef[];

/**
 * Every command `sidestep` accepts. Order within a group is the render order;
 * groups render in {@link HELP_GROUP_ORDER}.
 */
export const COMMANDS = {
  // ── Author ──────────────────────────────────────────────────────────────
  compile: {
    group: "Author",
    display: "compile <file>",
    summary: "Type-check and compile a workspace to XanoScript",
    args: [{ name: "file", required: true, path: true }],
    flags: ["out", "lock"],
    example: "sidestep compile ./xano/query/public/health_GET.ts",
  },
  export: {
    group: "Author",
    display: "export <file>",
    summary: "Compile and write the deployable JSON bundle",
    args: [{ name: "file", required: true, path: true }],
    flags: ["out", ...COMPILE],
    example: "sidestep export ./index.ts --out bundle.json",
  },
  paths: {
    group: "Author",
    display: "paths <file>",
    summary: "List each query's verb + resolved api:<canonical>/<name>",
    args: [{ name: "file", required: true, path: true }],
    flags: ["lock"],
    example: "sidestep paths ./index.ts",
  },
  routes: {
    group: "Author",
    display: "routes <file>",
    summary: "Alias for `paths`",
    aliasOf: "paths",
    args: [{ name: "file", required: true, path: true }],
    flags: ["lock"],
  },
  init: {
    group: "Author",
    display: "init [dir]",
    summary: "Scaffold a new sidestep project",
    args: [{ name: "dir", required: false, path: true }],
    flags: [...SCAFFOLD],
    example: "sidestep init my-app --ai claude",
  },

  // ── Deploy ──────────────────────────────────────────────────────────────
  deploy: {
    group: "Deploy",
    display: "deploy <file>",
    summary: "Ship to a live ephemeral env (or --dest sandbox) → URL",
    args: [{ name: "file", required: true, path: true }],
    flags: [
      "dest",
      "expires-hours",
      { key: "name", summary: "Display name for the ephemeral env (default: the workspace name)" },
      "bundle",
      "static",
      "static-host",
      "static-env",
      "no-verify",
      "reset",
      ...COMPILE,
      ...AUTH,
    ],
    example: "sidestep deploy ./index.ts --static ./dist",
  },
  release: {
    group: "Deploy",
    display: "release <file>",
    summary: "Promote to your instance workspace (coming soon)",
    args: [{ name: "file", required: true, path: true }],
    flags: [
      "yes",
      { key: "force", summary: "Skip the replace-my-workspace confirmation (same as --yes)" },
      "static",
      "static-host",
      "static-env",
      "no-verify",
      ...COMPILE,
      ...AUTH,
    ],
    example: "sidestep release ./index.ts",
  },
  validate: {
    group: "Deploy",
    display: "validate <file>",
    summary: "Deploy to a throwaway tenant and verify the round-trip",
    args: [{ name: "file", required: true, path: true }],
    flags: ["runtime", "capture", "verbose", "instance", "out", ...COMPILE],
    example: "sidestep validate ./index.ts --runtime",
  },

  // ── Pull ────────────────────────────────────────────────────────────────
  codegen: {
    group: "Pull",
    display: "codegen <bundle> <path>",
    summary: "A bundle JSON file → a runnable SideStep project (offline)",
    args: [
      { name: "bundle.json", required: true, path: true },
      { name: "path", required: true, path: true },
    ],
    flags: [...SCAFFOLD, "no-verify"],
    example: "sidestep codegen ./bundle.json ./app",
  },

  // ── Environments ────────────────────────────────────────────────────────
  workspace: {
    group: "Environments",
    display: "workspace",
    summary: "Read your real workspace — details, export, codegen",
    subcommands: {
      details: {
        summary: "Which instance and workspace am I bound to?",
        flags: [...AUTH],
        example: "sidestep workspace details",
      },
      export: {
        summary: "Write its bundle JSON",
        flags: ["path", { key: "name", summary: "Output basename (default: `workspace`)" }, ...AUTH],
        example: "sidestep workspace export --path -",
      },
      codegen: {
        summary: "Decode it into a runnable SideStep project",
        args: [{ name: "path", required: true, path: true }],
        flags: [...SCAFFOLD, "no-verify", ...AUTH],
        example: "sidestep workspace codegen ./app",
        group: "Pull",
        display: "workspace codegen <path>",
        groupSummary: "Your real workspace → a runnable SideStep project",
      },
      deploy: {
        summary: "Removed — SideStep never writes back to your real workspace",
        removed:
          "`sidestep workspace deploy` does not exist — the only import path is a FULL REPLACE of the " +
          "target workspace, so SideStep never writes back to your real one. Use `sidestep deploy` " +
          "(`--dest ephemeral` by default, or `--dest sandbox`).",
      },
    },
  },
  ephemeral: {
    group: "Environments",
    display: "ephemeral",
    summary: "Manage ephemeral envs — list, get, delete, export, codegen, impersonate",
    subcommands: {
      list: {
        summary: "List the ephemeral envs under your workspace",
        flags: ["all-workspaces", ...AUTH],
        example: "sidestep ephemeral list",
      },
      get: {
        summary: "Show one env's URL, status, and expiry",
        args: [{ name: "name", required: true }],
        flags: [...AUTH],
      },
      delete: {
        summary: "Tear an env down now instead of waiting for its TTL",
        args: [{ name: "name", required: true }],
        flags: ["yes", { key: "force", summary: "Skip the destroy-this-env confirmation (same as --yes)" }, ...AUTH],
      },
      export: {
        summary: "Write an env's bundle JSON",
        args: [{ name: "name", required: true }],
        flags: ["format", "path", { key: "name", summary: "Output basename (default: the env name)" }, ...AUTH],
      },
      codegen: {
        summary: "Decode an env into a runnable SideStep project",
        args: [
          { name: "name", required: true },
          { name: "path", required: true, path: true },
        ],
        flags: [...SCAFFOLD, "no-verify", ...AUTH],
        example: "sidestep ephemeral codegen my-env ./app",
        group: "Pull",
        display: "ephemeral codegen <env> <path>",
        groupSummary: "An ephemeral env → a runnable SideStep project",
      },
      impersonate: {
        summary: "Open the env's dashboard as a scoped session",
        args: [{ name: "name", required: true }],
        flags: ["guest", "url-only", ...AUTH],
      },
    },
  },
  sandbox: {
    group: "Environments",
    display: "sandbox",
    summary: "Export, inspect, or codegen your throwaway sandbox",
    subcommands: {
      details: {
        summary: "Print the sandbox tenant, headlined by its URL",
        flags: [...AUTH],
        example: "sidestep sandbox details",
      },
      export: {
        summary: "Write the sandbox workspace as JSON or multidoc XanoScript",
        flags: ["format", "path", { key: "name", summary: "Output basename (default: `sandbox`)" }, "bundle", ...COMPILE, ...AUTH],
        example: "sidestep sandbox export --format multidoc",
      },
      codegen: {
        summary: "Decode the sandbox into a runnable SideStep project",
        args: [{ name: "path", required: true, path: true }],
        flags: [...SCAFFOLD, "no-verify", ...AUTH],
        example: "sidestep sandbox codegen ./app",
        group: "Pull",
        display: "sandbox codegen <path>",
        groupSummary: "Your sandbox → a runnable SideStep project",
      },
      deploy: {
        summary: "Removed — unified under `sidestep deploy --dest sandbox`",
        removed:
          "`sidestep sandbox deploy` was removed — use `sidestep deploy --dest sandbox` " +
          "(same behavior against the singleton sandbox, unified under `deploy`).",
      },
    },
  },

  // ── Account ─────────────────────────────────────────────────────────────
  login: {
    group: "Account",
    display: "login",
    summary: "OAuth sign-in — shared cache, or --local per project",
    flags: ["local", "port", "scope", "origin", "config"],
    example: "sidestep login --local",
  },
  logout: {
    group: "Account",
    display: "logout",
    summary: "Revoke the refresh token and clear the cache",
    flags: ["local", "origin", "config"],
  },
  profile: {
    group: "Account",
    display: "profile me",
    summary: "Show the signed-in user and instance URL",
    subcommands: {
      me: {
        summary: "Print the scoped user and the instance URL",
        flags: [...AUTH],
        example: "sidestep profile me",
      },
    },
  },

  // ── Maintenance ─────────────────────────────────────────────────────────
  lock: {
    group: "Maintenance",
    display: "lock",
    summary: "Maintain xano.lock identities — rename, prune, adopt",
    subcommands: {
      rename: {
        summary: "Move an entry keeping its identity, so the next export renames in place",
        args: [
          { name: "kind", required: true },
          { name: "old", required: true },
          { name: "new", required: true },
        ],
        flags: ["lock"],
        example: "sidestep lock rename table users members",
      },
      prune: {
        summary: "Drop orphaned entries (all, or just the named keys)",
        args: [
          { name: "entry-file", required: true, path: true },
          { name: "keys…", required: false },
        ],
        flags: ["yes", "lock"],
        example: "sidestep lock prune ./index.ts --yes",
      },
      adopt: {
        summary: "Seed the lock from a live engine packageExport",
        args: [{ name: "bundle.json", required: true, path: true }],
        flags: ["yes", "lock"],
        example: "sidestep lock adopt ./packageExport.json",
      },
    },
  },
  completion: {
    group: "Maintenance",
    display: "completion <shell>",
    summary: "Print a shell completion script (bash, zsh, fish)",
    args: [{ name: "shell", required: true, values: ["bash", "zsh", "fish"] }],
    example: "sidestep completion zsh > \"${fpath[1]}/_sidestep\"",
  },
  version: {
    group: "Maintenance",
    display: "version",
    summary: "Print the CLI version",
  },
  help: {
    group: "Maintenance",
    display: "help",
    summary: "Show this help",
    args: [{ name: "command", required: false }],
    example: "sidestep help deploy",
  },

  // ── Removed (kept so the failure is explanatory, not a typo guess) ───────
  push: {
    group: "Deploy",
    display: "push",
    summary: "Removed — use `sidestep deploy`",
    removed:
      "`sidestep push` was removed — use `sidestep deploy` (`--dest ephemeral` by default, " +
      "or `--dest sandbox`).",
  },
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof COMMANDS;

/** Whether `name` is a command the CLI knows (including removed and alias entries). */
export function isCommand(name: string): name is CommandName {
  return Object.hasOwn(COMMANDS, name);
}

/** Look up a command spec, or undefined when the name is unknown. */
export function getCommand(name: string): CommandSpec | undefined {
  return isCommand(name) ? (COMMANDS[name] as CommandSpec) : undefined;
}

/** Look up a subcommand spec under a command, or undefined. */
export function getSubcommand(command: string, sub: string): SubcommandSpec | undefined {
  const subs = getCommand(command)?.subcommands;
  return subs && Object.hasOwn(subs, sub) ? subs[sub] : undefined;
}

/**
 * Command names offered in global help and in did-you-mean suggestions: the
 * live ones only, so a typo is never "corrected" to a removed command or an
 * alias that duplicates its target.
 */
export function liveCommandNames(): string[] {
  return Object.entries(COMMANDS)
    .filter(([, spec]) => (spec as CommandSpec).removed === undefined && (spec as CommandSpec).aliasOf === undefined)
    .map(([name]) => name);
}

/** The key a flag reference points at. */
export function flagKey(ref: FlagRef): string {
  return typeof ref === "string" ? ref : ref.key;
}

/** The summary to render for a flag reference — the command's override, else the shared one. */
export function flagSummary(ref: FlagRef): string {
  if (typeof ref !== "string") return ref.summary;
  return FLAGS[ref as FlagKey].summary;
}

/** Live subcommand names under a command (removed verbs excluded). */
export function liveSubcommandNames(command: string): string[] {
  const subs = getCommand(command)?.subcommands;
  if (!subs) return [];
  return Object.entries(subs)
    .filter(([, spec]) => spec.removed === undefined)
    .map(([name]) => name);
}

/** Levenshtein distance, capped-free (inputs here are short command names). */
function distance(a: string, b: string): number {
  // Single-row DP: row[j] is the distance from a[0..i) to b[0..j).
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(next[j - 1]! + 1, row[j]! + 1, row[j - 1]! + cost);
    }
    row = next;
  }
  return row[b.length]!;
}

/**
 * The closest candidate to `input`, or undefined when nothing is close enough.
 * A prefix match wins outright (`work` → `workspace`); otherwise an edit
 * distance of 2 or less, which catches real typos without "correcting" a word
 * the user meant literally (`list` stays unsuggested under `workspace`).
 */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
  if (input === "") return undefined;
  const lower = input.toLowerCase();
  const prefix = candidates.filter((c) => c.startsWith(lower));
  if (prefix.length === 1) return prefix[0];
  let best: string | undefined;
  let bestDistance = 3; // exclusive bound — only 0/1/2 qualify
  for (const c of candidates) {
    const d = distance(lower, c);
    if (d < bestDistance) {
      bestDistance = d;
      best = c;
    }
  }
  return best;
}
