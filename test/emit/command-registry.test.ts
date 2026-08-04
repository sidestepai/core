/**
 * Structural guards on the command registry (src/emit/commands.ts).
 *
 * The registry is the single source of truth for help, dispatch validation, and
 * unknown-* error text. These tests hold the invariants the type system can't:
 * that no entry ships without a description, that no command references a flag
 * key that doesn't exist, and that no flag is documented but unreachable.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  COMMANDS,
  FLAGS,
  HELP_GROUP_ORDER,
  flagKey,
  flagSummary,
  getCommand,
  getSubcommand,
  isCommand,
  liveCommandNames,
  liveSubcommandNames,
  suggest,
  type CommandSpec,
} from "../../src/emit/commands.js";

const entries = Object.entries(COMMANDS) as Array<[string, CommandSpec]>;

describe("command registry", () => {
  it("every command carries a summary, a display name, and a known group", () => {
    for (const [name, spec] of entries) {
      expect(spec.summary, `${name}.summary`).toBeTruthy();
      expect(spec.display, `${name}.display`).toBeTruthy();
      expect(HELP_GROUP_ORDER, `${name}.group`).toContain(spec.group);
    }
  });

  it("every subcommand carries a summary", () => {
    for (const [name, spec] of entries) {
      for (const [sub, subSpec] of Object.entries(spec.subcommands ?? {})) {
        expect(subSpec.summary, `${name} ${sub}.summary`).toBeTruthy();
      }
    }
  });

  it("every flag key a command references exists in FLAGS", () => {
    for (const [name, spec] of entries) {
      for (const ref of spec.flags ?? []) {
        expect(FLAGS, `${name} references unknown flag "${flagKey(ref)}"`).toHaveProperty(flagKey(ref));
      }
      for (const [sub, subSpec] of Object.entries(spec.subcommands ?? {})) {
        for (const ref of subSpec.flags ?? []) {
          expect(FLAGS, `${name} ${sub} references unknown flag "${flagKey(ref)}"`).toHaveProperty(flagKey(ref));
        }
      }
    }
  });

  it("every documented flag is referenced by at least one command", () => {
    const referenced = new Set<string>();
    for (const [, spec] of entries) {
      for (const ref of spec.flags ?? []) referenced.add(flagKey(ref));
      for (const subSpec of Object.values(spec.subcommands ?? {})) {
        for (const ref of subSpec.flags ?? []) referenced.add(flagKey(ref));
      }
    }
    const orphans = Object.keys(FLAGS).filter((k) => !referenced.has(k));
    expect(orphans, "FLAGS entries no command accepts").toEqual([]);
  });

  it("a command-specific flag summary overrides the shared one", () => {
    // `--force` skips a confirmation for `ephemeral delete` but overwrites files
    // for `init`; a scoped help page must describe the one that applies.
    const del = getSubcommand("ephemeral", "delete")!.flags!.find((f) => flagKey(f) === "force")!;
    expect(flagSummary(del)).toMatch(/confirmation/);
    const init = COMMANDS.init.flags.find((f) => flagKey(f) === "force")!;
    expect(flagSummary(init)).toBe(FLAGS.force.summary);
    expect(flagSummary("name")).toBe(FLAGS.name.summary);
  });

  it("every FLAGS entry has a spec and a summary", () => {
    for (const [key, spec] of Object.entries(FLAGS)) {
      expect(spec.spec, `${key}.spec`).toMatch(/^-/);
      expect(spec.summary, `${key}.summary`).toBeTruthy();
    }
  });

  it("`routes` is declared as an alias of `paths` and shares its shape", () => {
    expect(COMMANDS.routes.aliasOf).toBe("paths");
    expect(COMMANDS.routes.args).toEqual(COMMANDS.paths.args);
    expect(COMMANDS.routes.flags).toEqual(COMMANDS.paths.flags);
  });

  it("removed commands and subcommands carry an explanation, not a bare flag", () => {
    expect(COMMANDS.push.removed).toMatch(/sidestep deploy/);
    expect(getSubcommand("sandbox", "deploy")?.removed).toMatch(/--dest sandbox/);
    expect(getSubcommand("workspace", "deploy")?.removed).toMatch(/FULL REPLACE/);
  });

  it("live command names exclude removed commands and aliases", () => {
    const live = liveCommandNames();
    expect(live).toContain("deploy");
    expect(live).not.toContain("push");
    expect(live).not.toContain("routes");
  });

  it("live subcommand names exclude removed verbs", () => {
    expect(liveSubcommandNames("workspace")).toEqual(["details", "export", "codegen"]);
    expect(liveSubcommandNames("sandbox")).not.toContain("deploy");
    expect(liveSubcommandNames("compile")).toEqual([]);
  });

  it("lookups agree with membership", () => {
    expect(isCommand("deploy")).toBe(true);
    expect(isCommand("frobnicate")).toBe(false);
    expect(getCommand("frobnicate")).toBeUndefined();
    expect(getSubcommand("workspace", "details")).toBeDefined();
    expect(getSubcommand("workspace", "list")).toBeUndefined();
    expect(getSubcommand("deploy", "anything")).toBeUndefined();
  });

  describe("suggest", () => {
    it("corrects a one- and two-character typo", () => {
      expect(suggest("detials", liveSubcommandNames("workspace"))).toBe("details");
      expect(suggest("mee", ["me"])).toBe("me");
      expect(suggest("deply", liveCommandNames())).toBe("deploy");
    });

    it("returns undefined when nothing is close", () => {
      expect(suggest("xyzzy", liveSubcommandNames("ephemeral"))).toBeUndefined();
      expect(suggest("laksdjf", liveCommandNames())).toBeUndefined();
    });

    it("prefers an unambiguous prefix match", () => {
      expect(suggest("work", liveCommandNames())).toBe("workspace");
    });

    it("returns undefined for an empty input", () => {
      expect(suggest("", liveCommandNames())).toBeUndefined();
    });
  });

  it("every live registry command is named somewhere in the dispatch chain", () => {
    // The inverse of the test below: a command declared here that `run()` never
    // mentions would render in help and then fail as "unknown".
    const src = readFileSync(fileURLToPath(new URL("../../src/emit/cli.ts", import.meta.url)), "utf8");
    const undispatched = liveCommandNames().filter((c) => !src.includes(`"${c}"`));
    expect(undispatched, "registry commands cli.ts never dispatches").toEqual([]);
  });

  it("each family's registry verbs match the verbs its handler dispatches", () => {
    // Families dispatch in three different shapes — a `switch` in their own
    // module, an `if` chain in cli.ts, a `!==` guard — so this asserts the
    // weaker but shape-independent property: every live verb is named in the
    // module that handles it, and every `case "verb":` there is in the registry.
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(`../../src/emit/${rel}`, import.meta.url)), "utf8");
    const handlers: Array<[family: string, source: string]> = [
      ["workspace", read("workspace-command.ts")],
      ["ephemeral", read("ephemeral-command.ts")],
      ["lock", read("lock-commands.ts")],
      ["sandbox", read("cli.ts")],
      ["profile", read("cli.ts")],
    ];
    for (const [family, source] of handlers) {
      for (const verb of liveSubcommandNames(family)) {
        expect(source.includes(`"${verb}"`), `${family} ${verb} is not dispatched`).toBe(true);
      }
      // `switch`-shaped handlers additionally get the reverse check.
      const cases = [...source.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]!);
      if (cases.length === 0) continue;
      const spec = COMMANDS[family as keyof typeof COMMANDS] as CommandSpec;
      const registryVerbs = new Set(Object.keys(spec.subcommands ?? {}));
      const unlisted = cases.filter((c) => !registryVerbs.has(c));
      expect(unlisted, `${family} dispatches verbs the registry doesn't list`).toEqual([]);
    }
  });

  it("registry keys cover every command the dispatch chain compares against", () => {
    // The lazy `await import(...)` chain in cli.ts is written separately from the
    // registry (so the browser-safe bundle stays clean). This pins the two
    // together: every `command === "x"` literal must have a registry entry.
    const src = readFileSync(fileURLToPath(new URL("../../src/emit/cli.ts", import.meta.url)), "utf8");
    // `(?<![A-Za-z])` so `args.subcommand === "details"` isn't mistaken for a
    // top-level command; leading-dash tokens are flag aliases (`--help`, `-v`)
    // resolved before dispatch, not registry entries.
    const dispatched = new Set<string>();
    for (const m of src.matchAll(/(?<![A-Za-z])command === "([a-z-]+)"/g)) {
      if (!m[1]!.startsWith("-")) dispatched.add(m[1]!);
    }
    expect(dispatched.size).toBeGreaterThan(10); // the regex still matches something
    const missing = [...dispatched].filter((c) => !isCommand(c));
    expect(missing, "commands dispatched by cli.ts with no registry entry").toEqual([]);
  });
});
