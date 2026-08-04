/**
 * The help renderer (src/emit/help.ts) and the `--help` resolution in `run()`.
 *
 * Two things are under test: the rendered blocks themselves (shape, content,
 * color gating, column alignment), and that a help request anywhere in argv is
 * answered as help rather than resolved as an entry file — the failure mode
 * issue #173 reported, where `sidestep deploy --help` died inside Node's module
 * loader trying to import a file named `--help`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderGlobalHelp, renderCommandHelp, renderSubcommandHelp } from "../../src/emit/help.js";
import { parseArgs, run } from "../../src/emit/cli.js";
import { stdoutStyle } from "../../src/emit/ui.js";

/** Capture everything `run` writes to stdout. */
async function captureStdout(argv: string[]): Promise<string> {
  const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await run(argv);
    return spy.mock.calls.map((c) => String(c[0])).join("");
  } finally {
    spy.mockRestore();
  }
}

// eslint-disable-next-line no-control-regex -- matching ANSI escapes is the point
const ANSI = /\x1b\[[0-9;]*m/g;

afterEach(() => {
  delete process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
});

describe("global help", () => {
  it("keeps the tagline, every group title, and a row from each group", () => {
    const out = renderGlobalHelp(stdoutStyle(), "9.9.9");
    expect(out).toMatch(/the AI-first SDK & CLI for Xano/);
    expect(out).toContain("v9.9.9");
    for (const group of ["Author", "Deploy", "Pull", "Environments", "Account", "Maintenance"]) {
      expect(out, `group ${group}`).toContain(group);
    }
    for (const cmd of ["compile", "deploy", "codegen", "workspace", "login", "lock", "version", "help"]) {
      expect(out, `command ${cmd}`).toContain(cmd);
    }
  });

  it("hides removed commands and aliases from the menu", () => {
    const out = renderGlobalHelp(stdoutStyle(), "");
    expect(out).not.toMatch(/^\s*push\s/m);
    expect(out).not.toMatch(/^\s*routes\s/m);
  });

  it("surfaces the live codegen variants under Pull, not only the offline one", () => {
    const out = renderGlobalHelp(stdoutStyle(), "");
    for (const row of ["workspace codegen <path>", "sandbox codegen <path>", "ephemeral codegen <env> <path>"]) {
      expect(out, row).toContain(row);
    }
  });

  it("uses one description column across every group", () => {
    process.env.FORCE_COLOR = "1";
    const plain = renderGlobalHelp(stdoutStyle(), "1.0.0").replace(ANSI, "");
    const starts = plain
      .split("\n")
      .filter((l) => /^ {2}\S/.test(l))
      .map((l) => /^ {2}.*? {2,}(?=\S)/.exec(l)?.[0].length)
      .filter((n): n is number => n !== undefined);
    expect(starts.length).toBeGreaterThan(15);
    expect(new Set(starts).size).toBe(1);
  });

  it("points at per-command help", () => {
    expect(renderGlobalHelp(stdoutStyle(), "")).toContain("sidestep <command> --help");
  });
});

describe("command-scoped help", () => {
  it("lists deploy's flags", () => {
    const out = renderCommandHelp("deploy", stdoutStyle());
    for (const flag of ["--dest", "--static", "--expires-hours", "--no-verify", "--static-host"]) {
      expect(out, flag).toContain(flag);
    }
    expect(out).toContain("sidestep deploy <file>");
  });

  it("lists a family's live subcommands and not its removed ones", () => {
    const out = renderCommandHelp("workspace", stdoutStyle());
    expect(out).toContain("details");
    expect(out).toContain("export");
    expect(out).toContain("codegen <path>");
    expect(out).not.toMatch(/^\s*deploy\s/m);
    expect(out).toContain("sidestep workspace <subcommand> --help");
  });

  it("renders subcommand-scoped help with the verb's own args and flags", () => {
    const out = renderSubcommandHelp("workspace", "codegen", stdoutStyle());
    expect(out).toContain("sidestep workspace codegen <path>");
    expect(out).toContain("--ai");
    expect(out).toContain("--no-install");
    // Not the family listing — this is the verb's page.
    expect(out).not.toContain("Subcommands");
  });

  it("omits the Flags heading for a command that takes none", () => {
    expect(renderCommandHelp("version", stdoutStyle())).not.toContain("Flags");
  });

  it("falls back to the parent page for an unknown verb, and global for an unknown command", () => {
    expect(renderSubcommandHelp("workspace", "nope", stdoutStyle())).toContain("Subcommands");
    expect(renderCommandHelp("frobnicate", stdoutStyle())).toMatch(/the AI-first SDK & CLI/);
  });
});

describe("color and alignment", () => {
  it("emits no escape codes under NO_COLOR", () => {
    process.env.NO_COLOR = "1";
    for (const out of [
      renderGlobalHelp(stdoutStyle(), "1.0.0"),
      renderCommandHelp("deploy", stdoutStyle()),
      renderSubcommandHelp("lock", "prune", stdoutStyle()),
    ]) {
      expect(out).not.toContain("\x1b[");
    }
  });

  it("aligns descriptions at one column once ANSI is stripped", () => {
    process.env.FORCE_COLOR = "1";
    const plain = renderCommandHelp("deploy", stdoutStyle()).replace(ANSI, "");
    // Flag rows are `  <spec padded>  <summary>`; every summary must start at
    // the same column, which is only true if padding ran before coloring.
    // The description column is the end of the first 2+-space run after the
    // flag spec — i.e. the padding padEnd wrote, plus the two-space gutter.
    const starts = plain
      .split("\n")
      .filter((l) => /^ {2}--/.test(l))
      .map((l) => /^ {2}.*? {2,}(?=\S)/.exec(l)![0].length);
    expect(new Set(starts).size, `varied summary columns: ${starts.join(",")}`).toBe(1);
  });
});

describe("`--help` anywhere resolves to help (issue #173)", () => {
  it("bare forms still print global help", async () => {
    for (const argv of [[], ["help"], ["--help"], ["-h"]]) {
      expect(await captureStdout(argv), JSON.stringify(argv)).toMatch(/the AI-first SDK & CLI/);
    }
  });

  it("every entry-file command answers `--help` instead of importing it", async () => {
    for (const cmd of ["compile", "export", "paths", "routes", "deploy", "release", "validate", "codegen", "init"]) {
      const out = await captureStdout([cmd, "--help"]);
      expect(out, cmd).toContain(`sidestep ${cmd}`);
      expect(out, cmd).toContain("Usage:");
    }
  });

  it("`-h` is accepted wherever `--help` is", async () => {
    expect(await captureStdout(["compile", "-h"])).toContain("sidestep compile");
  });

  it("noun families answer `--help` with their subcommand list", async () => {
    for (const noun of ["workspace", "sandbox", "ephemeral", "profile", "lock"]) {
      const out = await captureStdout([noun, "--help"]);
      expect(out, noun).toContain(`sidestep ${noun}`);
      expect(out, noun).toContain("Subcommands");
    }
  });

  it("a verb's `--help` is verb-scoped, not family-scoped", async () => {
    const out = await captureStdout(["workspace", "codegen", "--help"]);
    expect(out).toContain("sidestep workspace codegen");
    expect(out).not.toContain("Subcommands");
  });

  it("`help <command>` and `help <command> <verb>` match the flag forms", async () => {
    expect(await captureStdout(["help", "deploy"])).toContain("sidestep deploy <file>");
    expect(await captureStdout(["help", "workspace", "codegen"])).toContain("sidestep workspace codegen");
  });

  it("beats an unrelated flag error — the pre-pass runs before flag parsing", async () => {
    // `--profile` was removed and throws from parseArgs; a help request must not
    // die on it.
    expect(await captureStdout(["deploy", "--profile", "x", "--help"])).toContain("sidestep deploy");
  });

  it("does not load the entry file when one is also present", async () => {
    const out = await captureStdout(["deploy", "./definitely-not-a-real-entry.ts", "--help"]);
    expect(out).toContain("sidestep deploy");
  });

  it("degrades to global help for an unknown command rather than erroring", async () => {
    const out = await captureStdout(["frobnicate", "--help"]);
    expect(out).toMatch(/the AI-first SDK & CLI/);
  });

  it("a leading-dash token never becomes the entry file", () => {
    expect(parseArgs(["deploy", "--help"]).file).not.toBe("--help");
    expect(parseArgs(["deploy", "-h"]).file).not.toBe("-h");
  });
});
