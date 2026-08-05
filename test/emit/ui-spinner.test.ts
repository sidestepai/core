import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spinner, withSpinner } from "../../src/emit/ui.js";

/**
 * The spinner exists so a multi-minute poll (a provisioning ephemeral,
 * microservices coming up) doesn't read as a hung CLI. Two behaviours matter and
 * are asserted here: it animates in place on a terminal and erases itself, and it
 * degrades to a single static line everywhere else so piped/CI logs never
 * accumulate frames.
 */
describe("spinner", () => {
  let out: string[];
  let isTTY: boolean | undefined;

  beforeEach(() => {
    out = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    isTTY = process.stderr.isTTY;
  });

  afterEach(() => {
    Object.defineProperty(process.stderr, "isTTY", { value: isTTY, configurable: true, writable: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const setTTY = (on: boolean) =>
    Object.defineProperty(process.stderr, "isTTY", { value: on, configurable: true, writable: true });

  describe("without a terminal (pipe, CI, tests)", () => {
    beforeEach(() => setTTY(false));

    it("prints the label once as a detail line and never animates", () => {
      vi.useFakeTimers();
      const spin = spinner("Waiting for microservices…");
      expect(out).toEqual(["  Waiting for microservices…\n"]);

      // Nothing accumulates: no frames, and no re-print on update or stop.
      vi.advanceTimersByTime(5_000);
      spin.update("Waiting for microservices… (1/2 ready)");
      spin.stop();
      expect(out).toHaveLength(1);
    });

    it("emits no cursor-control escapes", () => {
      spinner("Working…").stop();
      expect(out.join("")).not.toContain("\x1b[2K");
    });
  });

  describe("on a terminal", () => {
    beforeEach(() => {
      setTTY(true);
      vi.useFakeTimers();
    });

    it("renders a frame immediately and keeps animating in place", () => {
      const spin = spinner("Working…");
      // Each render clears the line first, so frames overwrite rather than stack.
      expect(out.join("")).toBe("\r\x1b[2K⠋ Working…");

      out.length = 0;
      vi.advanceTimersByTime(240);
      expect(out.join("")).toBe("\r\x1b[2K⠙ Working…\r\x1b[2K⠹ Working…\r\x1b[2K⠸ Working…");
      spin.stop();
    });

    it("shows the new label after update, without printing a second line", () => {
      const spin = spinner("Waiting for microservices…");
      spin.update("Waiting for microservices… (1/2 ready)");
      out.length = 0;
      vi.advanceTimersByTime(80);
      expect(out.join("")).toContain("(1/2 ready)");
      expect(out.join("")).not.toContain("\n");
      spin.stop();
    });

    it("reports elapsed seconds once the wait is worth timing", () => {
      const spin = spinner("Working…");
      expect(out.join("")).not.toContain("(0s)");
      out.length = 0;
      vi.advanceTimersByTime(3_000);
      expect(out.join("")).toContain("(3s)");
      spin.stop();
    });

    it("erases the line on stop and stops animating", () => {
      const spin = spinner("Working…");
      spin.stop();
      expect(out.at(-1)).toBe("\r\x1b[2K");

      out.length = 0;
      vi.advanceTimersByTime(1_000);
      expect(out).toEqual([]);
    });

    it("is safe to stop twice and to update after stopping", () => {
      const spin = spinner("Working…");
      spin.stop();
      out.length = 0;
      spin.stop();
      spin.update("later");
      vi.advanceTimersByTime(1_000);
      expect(out).toEqual([]);
    });
  });
});

describe("withSpinner", () => {
  let out: string[];

  beforeEach(() => {
    out = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true, writable: true });
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns the work's value and erases the line", async () => {
    const value = await withSpinner("Working…", async () => 42);
    expect(value).toBe(42);
    expect(out.at(-1)).toBe("\r\x1b[2K");
  });

  it("erases the line when the work throws, so no frame survives the failure", async () => {
    await expect(withSpinner("Working…", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(out.at(-1)).toBe("\r\x1b[2K");
  });
});
