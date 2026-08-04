/**
 * Shell completion scripts, generated from the command registry.
 *
 * The load-bearing test here is the last one: the generated bash and zsh scripts
 * are handed to the real shell's parser. Everything else checks that the right
 * names made it in; only the shell can tell us the quoting is right, and a
 * completion script that fails to parse silently disables completion rather than
 * erroring where anyone would notice.
 */
import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCompletion, isCompletionShell, COMPLETION_SHELLS } from "../../src/emit/completion.js";
import { run } from "../../src/emit/cli.js";
import { UsageError } from "../../src/emit/errors.js";
import { liveCommandNames, liveSubcommandNames } from "../../src/emit/commands.js";

/** Whether a shell binary is on PATH (fish usually isn't, on macOS or CI). */
function hasShell(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("completion scripts", () => {
  it("renders for every supported shell", () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = renderCompletion(shell);
      expect(script.length, shell).toBeGreaterThan(500);
      expect(script, shell).toContain("sidestep");
    }
  });

  it("offers every live command, in every shell", () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = renderCompletion(shell);
      for (const cmd of liveCommandNames()) {
        expect(script, `${shell} is missing "${cmd}"`).toContain(cmd);
      }
    }
  });

  // Completion is generated, so a new command joins it for free — this holds the
  // other direction: nothing in the script may name something the registry lost.
  it("offers nothing the registry does not declare", () => {
    const declared = new Set([...liveCommandNames(), ...liveCommandNames().flatMap(liveSubcommandNames)]);
    const bash = renderCompletion("bash");
    const offered = [...bash.matchAll(/^ {4}'([a-z]+)(?: ([a-z]+))?'\)/gm)].flatMap((m) =>
      [m[1], m[2]].filter((x): x is string => x !== undefined),
    );
    expect(offered.length).toBeGreaterThan(20);
    expect([...new Set(offered.filter((o) => !declared.has(o)))]).toEqual([]);
  });

  it("never offers a removed command or an alias", () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = renderCompletion(shell);
      expect(script, `${shell} offers push`).not.toMatch(/(^|[\s'])push([\s'|)]|$)/m);
      expect(script, `${shell} offers routes`).not.toMatch(/(^|[\s'])routes([\s'|)]|$)/m);
    }
  });

  it("offers each family's verbs", () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = renderCompletion(shell);
      for (const verb of liveSubcommandNames("ephemeral")) {
        expect(script, `${shell} is missing ephemeral ${verb}`).toContain(verb);
      }
    }
  });

  it("scopes flags to the command that accepts them", () => {
    const bash = renderCompletion("bash");
    // `--dest` belongs to deploy; `--all-workspaces` to `ephemeral list`.
    expect(bash).toMatch(/'deploy'\) echo '[^']*--dest/);
    expect(bash).toMatch(/'ephemeral list'\) echo '[^']*--all-workspaces/);
    // …and not to each other.
    expect(bash).not.toMatch(/'ephemeral list'\) echo '[^']*--dest/);
  });

  it("carries short aliases alongside their long forms", () => {
    const bash = renderCompletion("bash");
    expect(bash).toMatch(/'compile'\) echo '[^']*--out -o/);
    expect(bash).toMatch(/'lock prune'\) echo '[^']*--yes -y/);
  });

  it("offers the closed value sets", () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = renderCompletion(shell);
      expect(script, `${shell}: --dest values`).toMatch(/ephemeral sandbox|'ephemeral' 'sandbox'/);
      expect(script, `${shell}: --format values`).toMatch(/json multidoc|'json' 'multidoc'/);
      expect(script, `${shell}: shell values`).toMatch(/bash zsh fish|'bash' 'zsh' 'fish'/);
    }
  });

  it("has no unbalanced single quotes (the failure mode quoting bugs produce)", () => {
    for (const shell of COMPLETION_SHELLS) {
      const quotes = (renderCompletion(shell).match(/'/g) ?? []).length;
      expect(quotes % 2, `${shell} has an odd number of single quotes`).toBe(0);
    }
  });

  it("parses in the real shell", () => {
    const dir = mkdtempSync(join(tmpdir(), "sidestep-completion-"));
    try {
      let checked = 0;
      for (const shell of ["bash", "zsh"] as const) {
        if (!hasShell(shell)) continue;
        const file = join(dir, `sidestep.${shell}`);
        writeFileSync(file, renderCompletion(shell));
        // `-n` parses without executing — exactly the check we want, since
        // executing a completion script's `complete`/`compdef` needs a live
        // interactive shell.
        expect(() => execFileSync(shell, ["-n", file], { stdio: "pipe" }), shell).not.toThrow();
        checked++;
      }
      expect(checked, "no shell was available to parse-check against").toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("`sidestep completion` command", () => {
  const captureStdout = async (argv: string[]) => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await run(argv);
      return spy.mock.calls.map((c) => String(c[0])).join("");
    } finally {
      spy.mockRestore();
    }
  };

  it("writes the script to stdout (it is the requested artifact)", async () => {
    expect(await captureStdout(["completion", "zsh"])).toContain("#compdef sidestep");
    expect(await captureStdout(["completion", "bash"])).toContain("complete -o default -F _sidestep sidestep");
    expect(await captureStdout(["completion", "fish"])).toContain("complete -c sidestep");
  });

  it("rejects a missing shell with the command's own help", async () => {
    await expect(run(["completion"])).rejects.toMatchObject({
      name: "UsageError",
      helpFor: { command: "completion" },
    });
  });

  /** The UsageError `run(argv)` throws, or a failure if it resolved. */
  const usageError = async (argv: string[]): Promise<UsageError> => {
    try {
      await run(argv);
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      return err as UsageError;
    }
    throw new Error(`\`sidestep ${argv.join(" ")}\` resolved but should have failed`);
  };

  it("rejects an unsupported shell, naming the ones that work", async () => {
    expect((await usageError(["completion", "powershell"])).message).toMatch(/bash, zsh, fish/);
  });

  it("suggests the closest shell for a typo", async () => {
    expect((await usageError(["completion", "bahs"])).suggestion).toBe("bash");
  });

  it("`completion --help` documents it rather than generating anything", async () => {
    const out = await captureStdout(["completion", "--help"]);
    expect(out).toContain("sidestep completion <shell>");
    // The closed set belongs on the page, not only in the summary line.
    expect(out).toMatch(/Arguments[\s\S]*<shell>\s+bash, zsh, fish/);
    expect(out).not.toContain("_sidestep()");
  });

  it("isCompletionShell agrees with the supported list", () => {
    for (const shell of COMPLETION_SHELLS) expect(isCompletionShell(shell)).toBe(true);
    expect(isCompletionShell("powershell")).toBe(false);
  });
});
