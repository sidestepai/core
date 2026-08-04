/**
 * Usage failures: what is thrown, and how it renders.
 *
 * Two layers under test. `run()` throws a `UsageError` carrying the help target
 * and a did-you-mean — never a hand-written list of valid verbs, so a list can't
 * drift from the dispatch it describes. `reportFailure()` renders any error in
 * the CLI's own vocabulary (`✗`, then the block), entirely on stderr so a failed
 * run never writes to the data channel a caller may be piping.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { run } from "../../src/emit/cli.js";
import { UsageError, reportFailure } from "../../src/emit/errors.js";
import { liveSubcommandNames } from "../../src/emit/commands.js";

/** The UsageError `run(argv)` throws, or a failure if it resolved/threw otherwise. */
async function usageError(argv: string[]): Promise<UsageError> {
  try {
    await run(argv);
  } catch (err) {
    expect(err, `${argv.join(" ")} threw a non-UsageError: ${String(err)}`).toBeInstanceOf(UsageError);
    return err as UsageError;
  }
  throw new Error(`\`sidestep ${argv.join(" ")}\` resolved but should have failed`);
}

/** Capture both streams around a render. */
function capture(fn: () => void): { out: string; err: string } {
  const outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    fn();
    return {
      out: outSpy.mock.calls.map((c) => String(c[0])).join(""),
      err: errSpy.mock.calls.map((c) => String(c[0])).join(""),
    };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

afterEach(() => {
  delete process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
});

describe("unknown commands", () => {
  it("names the input and targets global help", async () => {
    const err = await usageError(["laksdjf"]);
    expect(err.message).toContain('"laksdjf"');
    expect(err.helpFor).toEqual({});
    expect(err.suggestion).toBeUndefined();
  });

  it("suggests the closest command for a typo", async () => {
    expect((await usageError(["deply", "x.ts"])).suggestion).toBe("deploy");
  });

  it("explains a removed command instead of guessing at a typo", async () => {
    const err = await usageError(["push", "x.ts"]);
    expect(err.message).toMatch(/sidestep deploy/);
    expect(err.suggestion).toBeUndefined();
  });
});

describe("unknown subcommands", () => {
  it("targets the family's help and suggests nothing when nothing is close", async () => {
    const err = await usageError(["workspace", "list"]);
    expect(err.message).toContain('"list"');
    expect(err.helpFor).toEqual({ command: "workspace" });
    expect(err.suggestion).toBeUndefined();
  });

  it("suggests the closest verb for a typo", async () => {
    expect((await usageError(["workspace", "detials"])).suggestion).toBe("details");
    expect((await usageError(["profile", "mee"])).suggestion).toBe("me");
  });

  it("handles an omitted verb", async () => {
    const err = await usageError(["workspace"]);
    expect(err.message).toMatch(/no subcommand given/);
    expect(err.helpFor).toEqual({ command: "workspace" });
  });

  it("does not suggest anything for a genuinely unrelated word", async () => {
    expect((await usageError(["ephemeral", "xyzzy"])).suggestion).toBeUndefined();
  });

  it("covers every noun family, including lock's positional verb", async () => {
    for (const noun of ["workspace", "sandbox", "ephemeral", "profile", "lock"]) {
      const err = await usageError([noun, "zzzznope"]);
      expect(err.helpFor, noun).toEqual({ command: noun });
    }
  });

  it("explains a removed verb and still shows the family", async () => {
    const sandbox = await usageError(["sandbox", "deploy", "x.ts"]);
    expect(sandbox.message).toMatch(/--dest sandbox/);
    expect(sandbox.helpFor).toEqual({ command: "sandbox" });

    const workspace = await usageError(["workspace", "deploy", "x.ts"]);
    expect(workspace.message).toMatch(/FULL REPLACE/);
    expect(workspace.helpFor).toEqual({ command: "workspace" });
  });
});

describe("missing arguments", () => {
  it("names the argument and targets the command's help", async () => {
    for (const cmd of ["compile", "export", "paths"]) {
      const err = await usageError([cmd]);
      expect(err.message, cmd).toContain("<file>");
      expect(err.helpFor, cmd).toEqual({ command: cmd });
    }
  });

  it("targets the verb's help for a lock subcommand", async () => {
    const err = await usageError(["lock", "rename"]);
    expect(err.message).toContain("<kind>");
    expect(err.helpFor).toEqual({ command: "lock", subcommand: "rename" });
  });
});

describe("removed flags", () => {
  it("render inside the frame, scoped to the command they were passed to", async () => {
    const err = await usageError(["deploy", "x.ts", "--profile", "p"]);
    expect(err.message).toMatch(/`--profile` was removed/);
    expect(err.helpFor).toEqual({ command: "deploy" });
  });

  it("do not attach a help block when the command itself is unrecognizable", async () => {
    const err = await usageError(["frobnicate", "--workspace", "1"]);
    expect(err.helpFor).toBeUndefined();
  });
});

describe("reportFailure", () => {
  it("writes the ✗ headline, the suggestion, and the help block — all to stderr", () => {
    const err = new UsageError('`sidestep workspace`: unknown subcommand "list".', {
      helpFor: { command: "workspace" },
      suggestion: "details",
    });
    const { out, err: stderr } = capture(() => reportFailure(err, "1.2.3"));
    expect(stderr).toContain("✗");
    expect(stderr).toContain('unknown subcommand "list"');
    expect(stderr).toContain("Did you mean: details");
    expect(stderr).toContain("Subcommands");
    for (const verb of liveSubcommandNames("workspace")) expect(stderr, verb).toContain(verb);
    expect(out).toBe("");
  });

  it("renders a plain Error with the frame and no help block", () => {
    const { err: stderr } = capture(() => reportFailure(new Error("the engine said no")));
    expect(stderr).toContain("✗");
    expect(stderr).toContain("the engine said no");
    expect(stderr).not.toContain("Usage:");
  });

  it("renders a non-Error throw without leaking `undefined`", () => {
    const { err: stderr } = capture(() => reportFailure("just a string"));
    expect(stderr).toContain("just a string");
    expect(stderr).not.toContain("undefined");
  });

  it("omits the block for a UsageError that asked for none", () => {
    const { err: stderr } = capture(() => reportFailure(new UsageError("bad flag")));
    expect(stderr).toContain("✗ bad flag");
    expect(stderr).not.toContain("Usage:");
  });

  it("emits no escape codes under NO_COLOR", () => {
    process.env.NO_COLOR = "1";
    const err = new UsageError("nope", { helpFor: {}, suggestion: "deploy" });
    const { err: stderr } = capture(() => reportFailure(err, "1.0.0"));
    expect(stderr).toContain("✗");
    expect(stderr).not.toContain("\x1b[");
  });
});
