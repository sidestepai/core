import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lam } from "../../src/node.js";
import { lam as isomorphicLam } from "../../src/index.js";
import { c } from "../../src/index.js";

/**
 * `lam.file` — a lambda body in its own type-checked module (issue #221).
 *
 * The fixtures in `./lambdas/` are real modules: they are inside the repo's
 * tsconfig, so they type-check on every run, which is the property the file form
 * exists for.
 */

describe("lam.file", () => {
  it("extracts a block body to the same text as the equivalent lam.fn", () => {
    const fromFile = lam.file("./lambdas/order-total.ts", { surface: "reduce" });
    const inline = lam.fn(({ $result, $this }) => {
      const line = $this.qty * $this.price;
      return $result + line;
    });
    expect(fromFile.value).toBe(inline.value);
  });

  it("extracts a concise body as a return statement", () => {
    expect(lam.file("./lambdas/concise.ts", { surface: "map" })).toEqual(c.text("return $this * 2;"));
  });

  it("keeps the file's own bytes — no transpile step in between", () => {
    const source = readFileSync(join(import.meta.dirname, "lambdas/order-total.ts"), "utf8");
    const body = lam.file("./lambdas/order-total.ts", { surface: "reduce" }).value ?? "";
    for (const line of ["const line = $this.qty * $this.price;", "return $result + line;"]) {
      expect(source).toContain(line);
      expect(body).toContain(line);
    }
  });

  it("resolves a relative path against the calling module, not the process cwd", () => {
    // Nothing named `lambdas/` exists at the repo root, so a cwd-relative
    // resolution could not have found this file.
    expect(() => lam.file("./lambdas/concise.ts", { surface: "map" })).not.toThrow();
    expect(process.cwd()).not.toBe(import.meta.dirname);
  });

  it("accepts an absolute path unchanged", () => {
    const abs = join(import.meta.dirname, "lambdas/concise.ts");
    expect(lam.file(abs, { surface: "map" })).toEqual(c.text("return $this * 2;"));
  });

  it("names the resolved absolute path when the file is missing", () => {
    let message = "";
    try {
      lam.file("./lambdas/nope.ts");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(join(import.meta.dirname, "lambdas/nope.ts"));
  });

  it("refuses a module with no default export, and says what the shape is", () => {
    expect(() => lam.file("./lambdas/no-default.ts", { surface: "map" })).toThrow(/export default/);
  });

  it("refuses a default export that is not a function", () => {
    expect(() => lam.file("./lambdas/not-a-function.ts", { surface: "map" })).toThrow(/not a function/);
  });

  it("refuses a helper declared beside the default export — it would be undefined at runtime", () => {
    let message = "";
    try {
      lam.file("./lambdas/extra-top-level.ts", { surface: "map" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("double");
    expect(message).toContain("Move it inside");
  });

  it("runs the same binding guard, and names the file", () => {
    let message = "";
    try {
      lam.file("./lambdas/illegal-binding.ts", { surface: "reduce" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("$acc");
    expect(message).toContain("$result");
    expect(message).toContain("illegal-binding.ts");
  });

  it("emits the capture prelude the other forms emit", () => {
    const v = lam.file("./lambdas/concise.ts", { surface: "map", capture: { rate: 0.2 } });
    expect(v.value).toBe("const rate = 0.2;\nreturn $this * 2;");
  });
});

describe("the entrypoint split", () => {
  it("carries lam.file on the node entry", () => {
    expect(typeof lam.file).toBe("function");
  });

  it("does not type it on the isomorphic entry — a frontend bundle cannot read a file", () => {
    // @ts-expect-error -- lam.file is node-only; import it from "@sidestep/core/node"
    expect(typeof isomorphicLam.file).toBe("function");
  });

  it("directs a loosely-typed isomorphic call to the node entry instead of `not a function` (#257)", () => {
    // The reported failure: `lam.file` reached through a position types didn't
    // guard, off the isomorphic entry, saying only "lam.file is not a function".
    const loose = isomorphicLam as unknown as { file: (p: string) => unknown };
    expect(typeof loose.file).toBe("function");
    expect(() => loose.file("./lambdas/concise.ts")).toThrow(/@sidestep\/core\/node/);
  });

  it("keeps fn and raw identical across both entries", () => {
    expect(lam.fn).toBe(isomorphicLam.fn);
    expect(lam.raw).toBe(isomorphicLam.raw);
  });
});

/**
 * Regressions from the branch's own code review. Each of these was a way for a
 * legal module to produce a wrong body — silently, which is the failure mode
 * this whole surface exists to remove.
 */
describe("lam.file — module shapes that used to slip through", () => {
  it("does not swallow a declaration that follows the default export", () => {
    const body = lam.file("./lambdas/trailing-type.ts", { surface: "map" }).value ?? "";
    expect(body).toBe("const row: Row = $this;\nreturn row.n * 2;");
    expect(body).not.toContain("type Row");
  });

  it("refuses a second export, which would be undefined at runtime", () => {
    let message = "";
    try {
      lam.file("./lambdas/named-export.ts", { surface: "map" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("besides its default");
    expect(message).toContain("export default");
  });

  // #265: the message points at the preloaded globals, not at dynamic `import()`
  // — whose literal specifier does not resolve on every instance.
  it("refuses a value import and points at the preloaded globals", () => {
    let message = "";
    try {
      lam.file("./lambdas/value-import.ts", { surface: "s.lambda" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("import type");
    expect(message).toContain("PRELOADED globals");
    expect(message).not.toMatch(/dynamic `import\(\)`/);
  });

  it("keeps a type-only import, which costs the engine nothing", () => {
    expect(() => lam.file("./lambdas/concise.ts", { surface: "map" })).not.toThrow();
  });

  it("accepts a body that declares its own $-prefixed locals", () => {
    const body = lam.file("./lambdas/local-dollar.ts", { surface: "map" }).value ?? "";
    expect(body).toContain("$tally");
  });
});
