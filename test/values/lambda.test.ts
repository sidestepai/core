import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { c, lam, LAMBDA_BINDINGS, LAMBDA_GLOBALS, assertLambdaBody } from "../../src/index.js";
import type { LambdaSurface } from "../../src/index.js";

/**
 * `lam.*` — the typed lambda authoring surface (issue #221).
 *
 * Two things are under test: that an authored function extracts to exactly the
 * text a hand-written `c.text(...)` would have carried (so this is an authoring
 * layer and nothing more), and that a body which cannot work at its surface
 * fails HERE rather than as a wrong value in a live response.
 */

describe("the binding table", () => {
  /**
   * The table in `src` and the live-probed record in `vendor` are the same claim
   * written twice — the guard reads one, the engine agreed with the other. If
   * they drift, the guard is enforcing something the engine does not do.
   */
  it("matches the live-probed contract byte for byte", () => {
    const probed = JSON.parse(readFileSync(join(process.cwd(), "vendor/lambda-bindings.json"), "utf8")) as {
      agreed: boolean;
      ambient: string[];
      contract: Record<string, string[]>;
    };
    expect(probed.agreed).toBe(true);

    // `console`/`crypto` are globals rather than `$`-bindings, so they ride a
    // separate list here; the probe records them alongside the rest.
    const sorted = (xs: readonly string[]): string[] => [...xs].sort();
    for (const [surface, bindings] of Object.entries(probed.contract)) {
      const ours = [...(LAMBDA_BINDINGS[surface as LambdaSurface] ?? []), ...LAMBDA_GLOBALS];
      expect(sorted(ours), surface).toEqual(sorted(bindings));
    }
    expect(sorted(Object.keys(LAMBDA_BINDINGS))).toEqual(sorted(Object.keys(probed.contract)));
  });

  it("names $result — and never $acc — as reduce's accumulator", () => {
    expect(LAMBDA_BINDINGS.reduce).toContain("$result");
    for (const bindings of Object.values(LAMBDA_BINDINGS)) expect(bindings).not.toContain("$acc");
  });
});

describe("lam.fn body extraction", () => {
  it("emits the concise-expression body as a return statement", () => {
    const v = lam.fn(({ $result, $this }) => $result + $this);
    expect(v).toEqual(c.text("return $result + $this;"));
  });

  it("emits a block body verbatim", () => {
    const v = lam.fn(({ $result, $this }) => {
      return $result + $this;
    });
    expect(v.value).toBe("return $result + $this;");
  });

  it("gives the block and concise forms of the same lambda the same text", () => {
    const concise = lam.fn(({ $this }) => $this * 2, { surface: "map" });
    const block = lam.fn(({ $this }) => {
      return $this * 2;
    }, { surface: "map" });
    expect(concise).toEqual(block);
  });

  it("is byte-identical to the hand-written c.text form", () => {
    const authored = lam.fn(({ $result, $this }) => $result + $this);
    expect(authored).toEqual(c.text("return $result + $this;"));
    expect(authored.tag).toBe("const");
    expect(authored.filters).toEqual([]);
  });

  it("extracts a multi-statement block body", () => {
    const v = lam.fn(({ $parent }) => {
      const total = $parent.reduce((a: number, b: number) => a + b, 0);
      return total / $parent.length;
    }, { surface: "map" });
    expect(v.value).toContain("const total =");
    expect(v.value).toContain("return total / $parent.length;");
  });

  it("extracts a function-expression body", () => {
    const v = lam.fn(function ({ $this }) {
      return $this;
    }, { surface: "map" });
    expect(v.value).toBe("return $this;");
  });

  it("refuses a function with no readable source", () => {
    expect(() => lam.fn(Math.max as never)).toThrow(/no readable source/);
  });
});

describe("the binding guard", () => {
  it("Covers #221: destructuring $acc does not type-check", () => {
    // The primary enforcement is the parameter type: the binding set IS the
    // parameter, so the wrong name never reaches the runtime guard at all. The
    // `@ts-expect-error` fails the build if this ever starts compiling.
    // @ts-expect-error -- $acc is not a binding; reduce's accumulator is $result
    expect(() => lam.fn(({ $acc }) => $acc + 1, { surface: "reduce" })).toThrow();
  });

  it("Covers #221: rejects a $acc body at build time, naming $result", () => {
    let message = "";
    try {
      // The same mistake through the untyped door — a body assembled as text, or
      // a JS caller the parameter type cannot reach.
      lam.raw("return $acc + $this", { surface: "reduce" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("$acc");
    expect(message).toContain("$result");
    expect(message).toContain("issue #221");
  });

  it("rejects the other accumulator names an author reaches for", () => {
    for (const name of ["$carry", "$memo", "$accumulator"]) {
      expect(() => lam.raw(`return ${name} + $this`, { surface: "reduce" })).toThrow(/\$result/);
    }
  });

  it("rejects $this at the statement surface but allows it at reduce", () => {
    expect(() => lam.raw("return $this", { surface: "s.lambda" })).toThrow(/\$this/);
    expect(() => lam.raw("return $this", { surface: "reduce" })).not.toThrow();
  });

  it("rejects $result at the map surface", () => {
    let message = "";
    try {
      lam.raw("return $result", { surface: "map" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("$result");
    expect(message).toContain("reduce");
  });

  it("rejects $parent in fl.lambda, where the piped value is $this", () => {
    expect(() => lam.raw("return $parent", { surface: "fl.lambda" })).toThrow(/\$parent/);
    expect(() => lam.raw("return $this", { surface: "fl.lambda" })).not.toThrow();
  });

  it("names the surface and its whole legal set in the message", () => {
    let message = "";
    try {
      lam.raw("return $nope", { surface: "map" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("`map`");
    for (const binding of LAMBDA_BINDINGS.map) expect(message).toContain(binding);
    expect(message).toContain("$var.name");
  });

  it("accepts the ambient bindings at every surface", () => {
    for (const surface of Object.keys(LAMBDA_BINDINGS) as LambdaSurface[]) {
      expect(() => lam.raw("return [$env, $input, $var, $auth]", { surface })).not.toThrow();
    }
  });

  it("accepts the console and crypto globals", () => {
    expect(() => lam.raw("console.log(crypto); return 1", { surface: "s.lambda" })).not.toThrow();
  });
});

describe("the scan sees code, not text", () => {
  it("ignores a $-token inside a double-quoted string", () => {
    expect(() => lam.raw('return "$acc"', { surface: "reduce" })).not.toThrow();
  });

  it("ignores a $-token inside a single-quoted string", () => {
    expect(() => lam.raw("return '$acc'", { surface: "reduce" })).not.toThrow();
  });

  it("ignores a $-token inside a line comment", () => {
    expect(() => lam.raw("// $acc was the guess\nreturn 1", { surface: "reduce" })).not.toThrow();
  });

  it("ignores a $-token inside a block comment", () => {
    expect(() => lam.raw("/* $acc\n   $memo */\nreturn 1", { surface: "reduce" })).not.toThrow();
  });

  it("ignores a $-token inside template-literal text but reads its substitutions", () => {
    expect(() => lam.raw("return `literal $acc text`", { surface: "reduce" })).not.toThrow();
    expect(() => lam.raw("return `x=${$var.x}`", { surface: "reduce" })).not.toThrow();
    expect(() => lam.raw("return `x=${$acc}`", { surface: "reduce" })).toThrow(/\$acc/);
  });

  it("reads a nested template substitution", () => {
    expect(() => lam.raw("return `a${`b${$acc}`}c`", { surface: "reduce" })).toThrow(/\$acc/);
    expect(() => lam.raw("return `a${`b${$this}`}c`", { surface: "reduce" })).not.toThrow();
  });

  it("ignores a $ anchor inside a regex literal", () => {
    expect(() => lam.raw("return /^x$/.test($this)", { surface: "reduce" })).not.toThrow();
    expect(() => lam.raw("return /[$acc]/.test($this)", { surface: "reduce" })).not.toThrow();
  });

  it("does not read a property access as a binding", () => {
    expect(() => lam.raw("return $var.$acc", { surface: "reduce" })).not.toThrow();
  });

  it("still reads a binding written after a division", () => {
    expect(() => lam.raw("return $this / 2 + $acc", { surface: "reduce" })).toThrow(/\$acc/);
  });
});

describe("module syntax", () => {
  it("rejects a top-level import and points at dynamic import()", () => {
    let message = "";
    try {
      lam.raw('import x from "y";\nreturn x', { surface: "s.lambda" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("import()");
    expect(message).toContain("function body");
  });

  it("rejects a top-level export", () => {
    expect(() => lam.raw("export const x = 1;\nreturn x", { surface: "s.lambda" })).toThrow(/export/);
  });

  it("allows dynamic import()", () => {
    expect(() => lam.raw('const m = await import("node:path");\nreturn typeof m.join', { surface: "s.lambda" })).not.toThrow();
  });

  it("allows the word import inside a string", () => {
    expect(() => lam.raw('return "import x from y"', { surface: "s.lambda" })).not.toThrow();
  });
});

describe("capture", () => {
  it("emits a const prelude ahead of the body", () => {
    const rate = 0.2;
    const v = lam.fn(({ $this }, { rate: r }) => $this * r, { surface: "map", capture: { rate } });
    expect(v.value).toBe("const rate = 0.2;\nreturn $this * r;");
  });

  it("serializes an object capture as JSON", () => {
    const v = lam.raw("return limits.max", { surface: "s.lambda", capture: { limits: { max: 5 } } });
    expect(v.value).toBe('const limits = {"max":5};\nreturn limits.max');
  });

  it("refuses a function capture, which cannot cross the boundary", () => {
    expect(() =>
      lam.raw("return f()", { surface: "s.lambda", capture: { f: (() => 1) as never } }),
    ).toThrow(/function/);
  });

  it("refuses a capture key that is not an identifier", () => {
    expect(() => lam.raw("return 1", { surface: "s.lambda", capture: { "not-an-id": 1 } })).toThrow(/identifier/);
  });
});

describe("lam.raw", () => {
  it("rejects the same body lam.fn would, with the same guidance", () => {
    expect(() => lam.raw("return $acc + $this", { surface: "reduce" })).toThrow(/\$result/);
  });

  it("passes a valid body through unchanged", () => {
    expect(lam.raw("return $result + $this", { surface: "reduce" })).toEqual(c.text("return $result + $this"));
  });
});

describe("empty bodies", () => {
  it("refuses an empty lam.raw body", () => {
    expect(() => lam.raw("", { surface: "s.lambda" })).toThrow(/empty/);
  });

  it("refuses a whitespace-only body", () => {
    expect(() => lam.raw("   \n  ", { surface: "s.lambda" })).toThrow(/empty/);
  });
});

describe("assertLambdaBody", () => {
  it("is reusable on a hand-written body, and names the caller in the message", () => {
    expect(() => assertLambdaBody("return $acc", "reduce", "s.lambda")).toThrow(/s\.lambda/);
  });

  it("accepts a body that is legal at the surface", () => {
    expect(() => assertLambdaBody("return $result + $this", "reduce")).not.toThrow();
  });
});
