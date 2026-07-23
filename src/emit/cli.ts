/**
 * CLI:
 *   sidestep compile <file> [--out <path>]   — emit one function's JSON (U8)
 *   sidestep export  <file> [--out <path>]   — emit the aggregate workspace
 *                                            bundle from a default-exported
 *                                            `Xano` registry (U12)
 *   sidestep lock <rename|prune|adopt> …     — xano.lock maintenance (see
 *                                            lock-commands.ts)
 *
 * Dynamically imports the module's default export. A `.ts`/`.mts`/`.cts` entry
 * is loaded through `tsx` (the `tsImport` API) when it's installed, so you can
 * point the CLI straight at a TypeScript workspace file; plain `.js`/`.mjs`
 * goes through a normal dynamic `import`. See README.
 *
 * Identity locking: when a `xano.lock` sits beside the entry file (or `--lock`
 * opts into creating one), `export` reads + validates it, seeds the guid
 * override store BEFORE the workspace module loads (references bake guids at
 * authoring time — see lock/store.ts), exports with the lock context, writes
 * the merged lock back atomically, and only THEN emits the bundle — a crash
 * between the two writes must never ship identities the lock hasn't recorded.
 * `compile` seeds from an adjacent lock too, so single-function artifacts
 * agree with locked bundles. The path flag is `--lock=<path>` (the `=` form
 * only — a space-separated path would be ambiguous with the entry-file
 * positional). `--frozen-lock` is the CI guard: fail instead of changing the
 * lock, so canonicals minted in CI are never silently discarded.
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { emit, serializeBundle } from "./emit.js";
import { writeArtifact } from "./write.js";
import { findUnresolvableFilters } from "../validate/filter-names.js";
import type { FunctionDef } from "../function/define.js";
import { Xano } from "../workspace/xano.js";
import {
  createLockContext,
  emptyLock,
  mergeObserved,
  serializeLock,
  validateLockModel,
  WORKSPACE_KEY,
  WORKSPACE_REALTIME_KEY,
  type LockExportContext,
  type LockFile,
} from "../lock/lock.js";
import { readLockFile, writeLockFile } from "../lock/io.js";
import { resetLockOverrides, seedLockOverrides } from "../lock/store.js";
import { warn, info, detail } from "./ui.js";

export interface ParsedArgs {
  command: string | undefined;
  /**
   * The verb of a noun-verb command (`sandbox deploy`, `profile me`): here
   * `command` is the noun and `subcommand` is the verb.
   * Undefined for the single-token verbs (`compile`/`export`/`lock`/…).
   */
  subcommand: string | undefined;
  file: string | undefined;
  out: string | undefined;
  /** All non-flag arguments after the command (file is positionals[0]). */
  positionals: string[];
  /** `--lock` / `--lock=<path>`: opt into creating a lock file. */
  lock: boolean;
  /** The `--lock=<path>` override (default: `xano.lock` beside the entry). */
  lockPath: string | undefined;
  /** `--frozen-lock`: hard-fail if the export would change the lock (CI). */
  frozenLock: boolean;
  /** `--strict`: promote export/deploy warnings (e.g. unresolvable filter names, issue #106) to a hard failure. */
  strict: boolean;
  /** `--yes`/`-y`: confirm destructive lock maintenance non-interactively. */
  yes: boolean;
  /** `push --bundle <path>`: upload an already-exported bundle instead of a file entry. */
  bundle: string | undefined;
  /** `deploy --reset`: full clear (records + sequences) then import — a from-scratch rebuild. */
  reset: boolean;
  /** `deploy --static <dir>`: archive this directory and deploy it to the sandbox's static host. */
  static: string | undefined;
  /**
   * `deploy --static-env KEY=VALUE` (repeatable): public config baked into the
   * static build's `index.html` as `window.<KEY>` globals. The backend URL is
   * wired in automatically as `window.XANO_HOST`; these override/extend it.
   * Served to the browser verbatim — public values only, never secrets.
   */
  staticEnv: Record<string, string>;
  /**
   * `deploy --static-host <name>`: the static-host NAME to deploy the frontend
   * to (default `default`). Give each app a distinct host so deploys don't share
   * and overwrite one `default` host — the shared host is why a first post-deploy
   * load can serve a *previous* app's cached `index.html`.
   */
  staticHost: string | undefined;
  /** `--origin <origin>`: Xano control-plane OAuth host. Default: $XANO_ORIGIN, then https://app.xano.com. */
  authHost: string | undefined;
  /** `--config <path>`: project-local token cache. Default: $XANO_CONFIG, then ./.xano/auth.json. */
  authFile: string | undefined;
  /**
   * `--global`: use the shared `~/.sidestep/auth.json` cache instead of the
   * project-local `./.xano/auth.json`. `login --global` writes there; other
   * commands read it when the project has no local cache (reads always try the
   * project-local cache first, then fall back to the global one).
   */
  global: boolean;
  /** `login --port <n>`: fixed loopback callback port (default: an ephemeral port). */
  port: number | undefined;
  /** `login --scope "<space list>"`: OAuth scopes to request (default: the built-in xano-cli set). */
  scope: string | undefined;
  /** `validate --runtime`: after import + round-trip, run each deployed function and report. */
  runtime: boolean;
  /** `validate --capture`: write each round-tripped function's fetched JSON (candidate fixtures). */
  capture: boolean;
  /** `validate --verbose`: print full diffs / raw engine detail instead of a projected summary. */
  verbose: boolean;
  /** `validate --instance <url>`: override XANO_VALIDATE_INSTANCE for this run. */
  instance: string | undefined;
  /** `validate --workspace <id>`: override XANO_VALIDATE_WORKSPACE_ID for this run. */
  workspace: number | undefined;
  /** `sandbox export --format <json|multidoc>`: which artifact to emit (validated at parse time). */
  format: "json" | "multidoc" | undefined;
  /** `sandbox export --path <p>`: output location (`-` for stdout; a dir or a full file path). */
  path: string | undefined;
  /** `sandbox export --name <n>`: output basename override (default `sandbox`). Also the `init` app name (default: target dir basename). */
  name: string | undefined;
  /**
   * `init --ai <preset>` (repeatable, comma-separated): AI-assistant instruction
   * files to scaffold (`claude`/`codex`/`cursor`/`none`). Empty = prompt in a TTY,
   * else write none. Validated in the init command, not at parse time.
   */
  ai: string[];
  /** `init --force`: scaffold into a non-empty target directory (overwrite our own files). */
  force: boolean;
  /** `init --no-install`: skip the post-scaffold `npm install`. */
  noInstall: boolean;
}

/** Parse a `--port` value, rejecting NaN/out-of-range so `server.listen` never gets `NaN`. */
function parsePort(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`--port must be an integer 0-65535 (got "${raw ?? ""}").`);
  }
  return n;
}

/** Nouns that take a verb as a second token (`sidestep <noun> <verb> …`). */
const NOUN_COMMANDS = new Set(["sandbox", "profile"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...afterCommand] = argv;
  // Noun-verb commands (`sandbox deploy`, `profile me`) peel
  // the verb off before flag parsing so the entry `<file>` stays positionals[0].
  let subcommand: string | undefined;
  let rest = afterCommand;
  if (command !== undefined && NOUN_COMMANDS.has(command)) {
    subcommand = afterCommand[0];
    rest = afterCommand.slice(1);
  }
  let out: string | undefined;
  let lock = false;
  let lockPath: string | undefined;
  let frozenLock = false;
  let strict = false;
  let yes = false;
  let bundle: string | undefined;
  let reset = false;
  let staticDir: string | undefined;
  let staticHost: string | undefined;
  const staticEnv: Record<string, string> = {};
  let authHost: string | undefined;
  let authFile: string | undefined;
  let useGlobal = false;
  let port: number | undefined;
  let scope: string | undefined;
  let runtime = false;
  let capture = false;
  let verbose = false;
  let instance: string | undefined;
  let workspace: number | undefined;
  let format: "json" | "multidoc" | undefined;
  let path: string | undefined;
  let name: string | undefined;
  const ai: string[] = [];
  let force = false;
  let noInstall = false;
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--out" || arg === "-o") {
      out = rest[++i];
    } else if (arg === "--lock") {
      lock = true;
    } else if (arg.startsWith("--lock=")) {
      lock = true;
      lockPath = arg.slice("--lock=".length);
    } else if (arg === "--frozen-lock") {
      frozenLock = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--bundle") {
      bundle = rest[++i];
    } else if (arg.startsWith("--bundle=")) {
      bundle = arg.slice("--bundle=".length);
    } else if (arg === "--reset") {
      reset = true;
    } else if (arg === "--static-env" || arg.startsWith("--static-env=")) {
      const kv = arg === "--static-env" ? rest[++i] : arg.slice("--static-env=".length);
      const eq = kv?.indexOf("=") ?? -1;
      if (kv === undefined || eq <= 0) {
        throw new Error(`--static-env expects KEY=VALUE (got "${kv ?? ""}").`);
      }
      staticEnv[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (arg === "--static-host") {
      staticHost = rest[++i];
    } else if (arg.startsWith("--static-host=")) {
      staticHost = arg.slice("--static-host=".length);
    } else if (arg === "--static") {
      staticDir = rest[++i];
    } else if (arg.startsWith("--static=")) {
      staticDir = arg.slice("--static=".length);
    } else if (arg === "--origin") {
      authHost = rest[++i];
    } else if (arg.startsWith("--origin=")) {
      authHost = arg.slice("--origin=".length);
    } else if (arg === "--config") {
      authFile = rest[++i];
    } else if (arg.startsWith("--config=")) {
      authFile = arg.slice("--config=".length);
    } else if (arg === "--global") {
      useGlobal = true;
    } else if (arg === "--port") {
      port = parsePort(rest[++i]);
    } else if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length));
    } else if (arg === "--scope") {
      scope = rest[++i];
    } else if (arg.startsWith("--scope=")) {
      scope = arg.slice("--scope=".length);
    } else if (arg === "--runtime") {
      runtime = true;
    } else if (arg === "--capture") {
      capture = true;
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--instance") {
      instance = rest[++i];
    } else if (arg.startsWith("--instance=")) {
      instance = arg.slice("--instance=".length);
    } else if (arg === "--workspace") {
      workspace = parseWorkspaceId(rest[++i]);
    } else if (arg.startsWith("--workspace=")) {
      workspace = parseWorkspaceId(arg.slice("--workspace=".length));
    } else if (arg === "--format") {
      format = parseFormat(rest[++i]);
    } else if (arg.startsWith("--format=")) {
      format = parseFormat(arg.slice("--format=".length));
    } else if (arg === "--path") {
      path = rest[++i];
    } else if (arg.startsWith("--path=")) {
      path = arg.slice("--path=".length);
    } else if (arg === "--name") {
      name = rest[++i];
    } else if (arg.startsWith("--name=")) {
      name = arg.slice("--name=".length);
    } else if (arg === "--ai" || arg.startsWith("--ai=")) {
      // Accumulate; accept a comma-separated list too (`--ai claude,codex`).
      const raw = arg === "--ai" ? rest[++i] : arg.slice("--ai=".length);
      for (const p of (raw ?? "").split(",")) {
        const preset = p.trim();
        if (preset !== "") ai.push(preset);
      }
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--no-install") {
      noInstall = true;
    } else if (arg === "--profile" || arg.startsWith("--profile=")) {
      // Removed in the OAuth migration — fail loudly instead of letting the flag
      // (and its value) fall through into positionals and misparse as an entry file.
      throw new Error(
        `\`--profile\` was removed — push now authenticates via OAuth. ` +
          `Run \`sidestep login\` once (or set XANO_REFRESH_TOKEN for CI).`,
      );
    } else if (
      arg === "--prune" ||
      arg === "--confirm-workspace" ||
      arg.startsWith("--confirm-workspace=") ||
      arg === "--adopt-workspace"
    ) {
      // Removed with `workspace deploy` — the sandbox is the only deploy target.
      // Fail loudly (like `--profile`) rather than silently dropping the flag and
      // deploying anyway, which would hide a broken migrated command.
      const flag = arg.split("=")[0];
      throw new Error(
        `\`${flag}\` was removed along with \`sidestep workspace deploy\` — ` +
          `the sandbox is the only deploy target. Use \`sidestep sandbox deploy\` (optionally with \`--reset\`).`,
      );
    } else {
      positionals.push(arg);
    }
  }
  return {
    command,
    subcommand,
    file: positionals[0],
    out,
    positionals,
    lock,
    lockPath,
    frozenLock,
    strict,
    yes,
    bundle,
    reset,
    static: staticDir,
    staticHost,
    staticEnv,
    authHost,
    authFile,
    global: useGlobal,
    port,
    scope,
    runtime,
    capture,
    verbose,
    instance,
    workspace,
    format,
    path,
    name,
    ai,
    force,
    noInstall,
  };
}

/** Parse a `--workspace` value, rejecting non-positive-integers so config never gets NaN. */
function parseWorkspaceId(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--workspace must be a positive integer (got "${raw ?? ""}").`);
  }
  return n;
}

/** Parse a `--format` value, rejecting anything but the two supported artifacts. */
function parseFormat(raw: string | undefined): "json" | "multidoc" {
  if (raw === "json" || raw === "multidoc") return raw;
  throw new Error(`--format must be "json" or "multidoc" (got "${raw ?? ""}").`);
}

/**
 * Import tsx's ESM API, resolving it from the USER's project (the directory of
 * the `.ts` entry) rather than the CLI's own install tree.
 *
 * A bare `import("tsx/esm/api")` resolves against wherever THIS module lives: fine
 * for an `npx`/local-devDependency CLI (it sits in the project's `node_modules`),
 * but a GLOBALLY-installed CLI resolves against the global `node_modules`, which
 * has no tsx — even when the user's project has it. So resolve from the entry file
 * first (matching the tsup "tsx is the consumer's install" design), and fall back
 * to a bare import for the co-located case.
 */
async function importTsxApi(file: string): Promise<{ register: () => () => void }> {
  try {
    const requireFromEntry = createRequire(pathToFileURL(resolve(file)));
    const apiPath = requireFromEntry.resolve("tsx/esm/api");
    return (await import(pathToFileURL(apiPath).href)) as { register: () => () => void };
  } catch {
    return (await import("tsx/esm/api")) as { register: () => () => void };
  }
}

/**
 * Load a `.ts` entry through `tsx` (when installed) for plain-Node invocations.
 *
 * Uses the global `register()` hook rather than the scoped `tsImport()`: the
 * latter resolves nested `.js`→`.ts` specifiers relative to *this* module's
 * location, so when the CLI runs from a symlinked install (`npx`, a `file:` dep)
 * the workspace's own relative imports (e.g. `index.ts` importing
 * `./tables/user.js`) fail to resolve. `register()` installs the loader
 * process-wide, so the whole module graph remaps consistently; we unregister
 * once the entry has loaded.
 */
async function loadViaTsx(url: string, file: string, cause?: unknown): Promise<unknown> {
  let register: () => () => void;
  try {
    ({ register } = await importTsxApi(file));
  } catch {
    // tsx isn't installed (in the project OR beside the CLI), so we can't recover
    // a TS entry bare Node rejected. Chain the original loader failure so a genuine
    // (non-loader) error in the user's module isn't masked by the "install tsx" message.
    throw new Error(
      `Loading a TypeScript entry ("${file}") requires \`tsx\`. ` +
        `Install it in your project (\`npm i -D tsx\`) or precompile the file to .js first.`,
      cause !== undefined ? { cause } : undefined,
    );
  }
  const unregister = register();
  try {
    const mod = (await import(url)) as { default?: unknown };
    return mod.default;
  } finally {
    unregister();
  }
}

export async function loadDefault(file: string): Promise<unknown> {
  const url = pathToFileURL(resolve(file)).href;
  try {
    // A plain dynamic import works whenever a TS loader is already active
    // (vitest, `node --import tsx`, etc.) and keeps a single module instance.
    const mod = await import(url);
    return mod.default;
  } catch (err) {
    if (!/\.[mc]?ts$/.test(file)) throw err;
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    // tsx can recover these two — they're loader/resolution failures, not a
    // module-system mismatch:
    //   • ERR_UNKNOWN_FILE_EXTENSION — older Node with no native `.ts` support.
    //   • ERR_MODULE_NOT_FOUND — Node ≥ 22.6 strips types natively and loads the
    //     entry, but native stripping does NOT remap a `.js` specifier to its
    //     `.ts` source, so a workspace's own relative imports (`./tables/user.js`)
    //     fail. tsx's resolver does the remap.
    if (code === "ERR_UNKNOWN_FILE_EXTENSION" || code === "ERR_MODULE_NOT_FOUND") {
      return loadViaTsx(url, file, err);
    }
    // The entry was pulled into a CommonJS module graph — its nearest
    // package.json is `"type": "commonjs"` (what `npm init -y` writes) — so Node
    // (and tsx, which respects that type) evaluate it as CJS and choke on the
    // ESM `import`. sidestep defs are ESM-only, so no loader can bridge this: the
    // entry itself has to be ESM. Trade the cryptic native SyntaxError for an
    // actionable one.
    if (err instanceof SyntaxError && /import statement outside a module/.test(err.message)) {
      throw new Error(
        `Cannot load "${file}": it is being evaluated as CommonJS, but sidestep ` +
          `workspace files are ES modules. Add \`"type": "module"\` to the nearest ` +
          `package.json, or rename the entry to \`.mts\`.`,
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Resolve this package's version for `sidestep version`. Walks up from the running
 * module to the package root's `package.json` (`dist/cli.js` → `../`, the
 * `src/emit/cli.ts` source → `../../`), matching on the package NAME so a stray
 * ancestor `package.json` can't shadow it. Best-effort: returns `"unknown"` rather
 * than throwing when it can't be located, since a version print must never fail.
 */
export function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const p = join(dir, "package.json");
    if (existsSync(p)) {
      try {
        const pkg = JSON.parse(readFileSync(p, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "@sidestep/core" && typeof pkg.version === "string") return pkg.version;
      } catch {
        /* unreadable or not JSON — keep walking up */
      }
    }
    const up = dirname(dir);
    if (up === dir) break; // reached the filesystem root
    dir = up;
  }
  return "unknown";
}

const USAGE =
  "Usage: sidestep <compile|export> <file> [--out <path>] [--lock[=<path>]] [--frozen-lock] [--strict] | " +
  "sidestep init [<dir>] [--name <name>] [--ai <claude|codex|cursor|none>] [--force] [--no-install] | " +
  "sidestep version | " +
  "sidestep login [--origin <origin>] [--config <path>] [--global] [--port <n>] | " +
  "sidestep logout [--config <path>] [--global] | " +
  "sidestep sandbox deploy <file>|--bundle <path> [--reset] [--static <dir>] [--static-host <name>] [--static-env KEY=VALUE] [--config <path>] [--global] | " +
  "sidestep sandbox export [--format <json|multidoc>] [--path <path>|-] [--name <name>] | " +
  "sidestep sandbox details [--config <path>] [--global] | " +
  "sidestep profile me [--config <path>] [--global] | " +
  "sidestep validate <file>|--bundle <path> [--runtime] [--capture] [--out <dir>] [--instance <url>] [--workspace <id>] [--verbose] | " +
  "sidestep lock <rename|prune|adopt> …";

/** Quote a name for a suggested shell command when it needs it. */
function shellName(name: string): string {
  return /[^\w.@/-]/.test(name) ? JSON.stringify(name) : name;
}

/**
 * Orphan warnings (R6): a lock entry nothing matched is either a rename (the
 * fix-up command keeps the engine-side object alive) or a deletion. Warnings
 * go to STDERR only — stdout may be a piped bundle. Renames are never guessed;
 * newcomers of the same kind are listed as candidates, no more.
 */
function warnOrphans(
  orphans: string[],
  dropped: string[],
  cededCanonicals: string[],
  previous: LockFile,
  observed: Record<string, unknown>,
): void {
  for (const key of orphans) {
    if (key === WORKSPACE_KEY || key === WORKSPACE_REALTIME_KEY) {
      warn(
        `xano.lock entry "${key}" matched nothing this export (no workspace canonical emitted). ` +
          `Run \`sidestep lock prune\` if that is intentional.`,
      );
      continue;
    }
    const sep = key.indexOf(":");
    const payloadKey = key.slice(0, sep);
    const name = key.slice(sep + 1);
    const newcomers = Object.keys(observed)
      .filter((k) => k.startsWith(`${payloadKey}:`) && !(k in previous.objects))
      .map((k) => k.slice(payloadKey.length + 1));
    const hint = newcomers.length > 0 ? ` (new ${payloadKey} names this export: ${newcomers.join(", ")})` : "";
    warn(
      `xano.lock entry "${key}" matches no exported object — if this was a rename, the next sync ` +
        `would delete+create unless the entry moves with it.`,
    );
    detail(`renamed? run: sidestep lock rename ${payloadKey} ${shellName(name)} <new-name>${hint}`);
    detail("deleted? run: sidestep lock prune");
  }
  for (const key of dropped) {
    warn(
      `Dropped stale lock entry "${key}" — its identity reappeared under a live name (a reverted rename).`,
    );
  }
  for (const key of cededCanonicals) {
    warn(
      `Lock entry "${key}" kept its guid but ceded its canonical to a live object that now emits it ` +
        `(an explicit in-code canonical). If "${key}" was renamed, run the \`sidestep lock rename\` fix-up shown above.`,
    );
  }
}

export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const { command, out } = args;

  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }
  if (command === "init") {
    // Node-only (node:fs + child_process for install + a readline prompt);
    // lazily imported like the other Node-only commands so the browser-safe
    // authoring bundle never pulls it in.
    const { runInitCommand } = await import("./init-command.js");
    return runInitCommand(args);
  }
  if (command === "lock") {
    const { runLockCommand } = await import("./lock-commands.js");
    return runLockCommand(args);
  }
  if (command === "login") {
    // OAuth login is Node-only (node:http/node:crypto/child_process); lazily
    // imported like `push`/`lock` so `compile`/`export`/the browser-safe bundle
    // never pull it in.
    const { runLoginCommand } = await import("./login-command.js");
    return runLoginCommand(args);
  }
  if (command === "logout") {
    // Node-only (OAuth revoke + file removal); lazily imported like `login`.
    const { runLogoutCommand } = await import("./logout-command.js");
    return runLogoutCommand(args);
  }
  if (command === "sandbox") {
    if (args.subcommand === "deploy") {
      // The deploy core lives in its own (Node-only) module so the bin's other
      // commands never pay its import cost.
      const { runDeployCommand } = await import("./deploy-command.js");
      return runDeployCommand(args);
    }
    if (args.subcommand === "details") {
      // Lazily imported like the other Node-only commands so the browser-safe
      // authoring bundle never pulls in the OAuth stack.
      const { runSandboxDetailsCommand } = await import("./sandbox-details-command.js");
      return runSandboxDetailsCommand(args);
    }
    if (args.subcommand === "export") {
      // Node-only (fetch/fs + OAuth); lazily imported like the sibling sandbox commands.
      const { runSandboxExportCommand } = await import("./sandbox-export-command.js");
      return runSandboxExportCommand(args);
    }
    throw new Error(
      `Unknown sandbox subcommand "${args.subcommand ?? ""}". ` +
        `Did you mean \`sidestep sandbox deploy\`, \`sidestep sandbox export\`, or \`sidestep sandbox details\`? ${USAGE}`,
    );
  }
  if (command === "workspace") {
    throw new Error(
      `\`sidestep workspace deploy\` was removed — the sandbox is the only deploy target. ` +
        `Use \`sidestep sandbox deploy\`. ${USAGE}`,
    );
  }
  if (command === "profile") {
    if (args.subcommand !== "me") {
      throw new Error(`Unknown profile subcommand "${args.subcommand ?? ""}". Did you mean \`sidestep profile me\`? ${USAGE}`);
    }
    const { runProfileCommand } = await import("./profile-command.js");
    return runProfileCommand(args);
  }
  if (command === "push") {
    throw new Error(
      `\`sidestep push\` was removed — use \`sidestep sandbox deploy\` (same behavior against the sandbox, new name). ${USAGE}`,
    );
  }
  if (command === "validate") {
    // Node-only (fetch/fs/env + the validate stack); lazily imported like the
    // other Node-only commands so the browser-safe authoring bundle stays clean.
    const { runValidateCommand } = await import("./validate-command.js");
    return runValidateCommand(args);
  }
  if (command !== "compile" && command !== "export") {
    throw new Error(`Unknown command "${command ?? ""}". ${USAGE}`);
  }
  if (!args.file) {
    throw new Error(`Missing input file. ${USAGE}`);
  }

  if (command === "compile") {
    return runCompile(args);
  }

  // export
  const json = await exportBundleJson(args);
  if (out) {
    writeFileSync(out, json + "\n", "utf8");
    process.stdout.write(`Wrote ${out}\n`);
  } else {
    process.stdout.write(json + "\n");
  }
}

/**
 * Resolve the lock path for an entry file: `--lock=<path>` wins, else
 * `xano.lock` beside the entry (matching `export`/`compile` defaults).
 */
function resolveLockPath(args: ParsedArgs, file: string): string {
  return args.lockPath !== undefined
    ? resolve(args.lockPath)
    : join(dirname(resolve(file)), "xano.lock");
}

async function runCompile(args: ParsedArgs): Promise<void> {
  const file = args.file!;
  const lockPath = resolveLockPath(args, file);
  // Always reset before (maybe) seeding: a run in a process that previously
  // seeded a different lock must not inherit its stale overrides.
  resetLockOverrides();
  // Seed from an adjacent lock so a single-function artifact carries the same
  // reference guids a locked bundle would. Compile never writes the lock.
  if (existsSync(lockPath)) {
    seedLockOverrides(readLockFile(lockPath));
  }
  const def = await loadDefault(file);
  if (!def || typeof def !== "object" || typeof (def as FunctionDef).name !== "string") {
    throw new Error(`Module "${file}" must default-export a FunctionDef (got: ${typeof def}).`);
  }
  const fn = def as FunctionDef;
  if (args.out) {
    writeArtifact(fn, args.out);
    process.stdout.write(`Wrote ${args.out}\n`);
  } else {
    process.stdout.write(emit(fn) + "\n");
  }
}

/**
 * Run the full `export` pipeline (lock seed → load → export → lock merge/write)
 * and return the serialized bundle JSON — WITHOUT writing it anywhere. `export`
 * writes it to `--out`/stdout; `push` streams it to the sandbox endpoint. The
 * lock is written to disk here as a side effect, exactly as `export` does, so
 * `push <file>` freezes identities identically to an `export`.
 */
export async function exportBundleJson(args: ParsedArgs): Promise<string> {
  const file = args.file!;
  // Resolve the lock BEFORE importing the workspace module: references bake
  // guids the moment defs are evaluated, so seeding must come first. An invalid
  // lock is a hard error here (R11) — never degrade to a silent unlocked run.
  const lockPath = resolveLockPath(args, file);
  const lockExists = existsSync(lockPath);
  // Always reset before (maybe) seeding: an unlocked run in a process that
  // previously seeded a different lock must not inherit its stale overrides.
  resetLockOverrides();

  let lockCtx: LockExportContext | undefined;
  let originalSerialized: string | undefined;
  if (lockExists || args.lock) {
    const lockModel = lockExists ? readLockFile(lockPath) : emptyLock();
    if (lockExists) originalSerialized = serializeLock(lockModel);
    seedLockOverrides(lockModel);
    lockCtx = createLockContext(lockModel);
  } else if (args.frozenLock) {
    throw new Error(
      `--frozen-lock: no xano.lock found at ${lockPath}. Create one with \`sidestep export --lock\` ` +
        `and commit it.`,
    );
  } else {
    info(
      `Exporting without xano.lock — identities derive from names, so a rename becomes delete+create ` +
        `on sync. Pass --lock to freeze them.`,
    );
  }

  const def = await loadDefault(file);
  if (!Xano.isXano(def)) {
    throw new Error(`Module "${file}" must default-export a Xano registry for \`export\`.`);
  }
  const bundle = def.export(lockCtx ? { lock: lockCtx } : {});

  if (lockCtx) {
    const { lock: merged, orphans, dropped, cededCanonicals } = mergeObserved(
      lockCtx.lock,
      lockCtx.observed,
    );
    // Never persist a lock the next run's parseLock would reject (duplicate
    // explicit canonicals in code, etc.) — fail the export instead.
    validateLockModel(merged, lockPath);
    const changed = originalSerialized === undefined || serializeLock(merged) !== originalSerialized;
    if (args.frozenLock && changed) {
      throw new Error(
        `--frozen-lock: this export would ${lockExists ? "change" : "create"} ${lockPath}. ` +
          `Run \`sidestep export\` locally, commit the updated xano.lock, and retry — a canonical ` +
          `minted here would be discarded, permanently diverging public URLs.`,
      );
    }
    // Lock lands BEFORE the bundle: never ship identities the lock hasn't
    // durably recorded (a crash in between must not orphan minted canonicals).
    writeLockFile(lockPath, merged);
    warnOrphans(orphans, dropped, cededCanonicals, lockCtx.lock, lockCtx.observed);
  }

  checkFilterNames(bundle, args.strict);

  return serializeBundle(bundle);
}

/**
 * Filter-name preflight (issue #106): a `filter(name, …)` the engine can't
 * resolve exports clean, then 500s (`Unable to locate func entry`) on the first
 * live request. Warn per occurrence (STDERR — stdout may be a piped bundle),
 * pointing at the likely intended name; `--strict` promotes it to a hard failure.
 */
function checkFilterNames(bundle: unknown, strict: boolean): void {
  const findings = findUnresolvableFilters(bundle);
  if (findings.length === 0) return;
  for (const f of findings) {
    const hint = f.suggestions.length ? ` — did you mean ${f.suggestions.map((s) => `\`${s}\``).join(" or ")}?` : "";
    warn(`Filter "${f.name}" (in ${f.location}) is not engine-resolvable and will 500 at runtime${hint}`);
  }
  if (strict) {
    throw new Error(
      `--strict: ${findings.length} unresolvable filter name(s). Replace them with resolvable names ` +
        `(see \`fl.*\` / llms.txt) or drop the raw \`filter()\` call.`,
    );
  }
}

// NOTE: this module is the CLI *library* (it exports `run`/`parseArgs`/
// `loadDefault` for programmatic and test use). The process is driven by the
// dedicated `bin.ts` executable, which calls `run()` unconditionally. Earlier
// this file self-invoked via an `import.meta.url === process.argv[1]` guard,
// but the bundler code-splits shared code into a chunk — moving `import.meta.url`
// off the bin file — so the guard was always false and the published CLI did
// nothing. Keep execution in `bin.ts`; never reintroduce self-detection here.
