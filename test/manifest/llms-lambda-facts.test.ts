import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LAMBDA_BINDINGS, LAMBDA_CODE_FILTERS, LAMBDA_MODULE_GLOBALS } from "../../src/index.js";
import { FILTER_SPECS } from "../../src/values/generated/filters.generated.js";

/**
 * Fact inventory for `## Lambda bodies` (issue #221).
 *
 * The contract was documented NOWHERE before this: not in the `fl.*` JSDoc, not
 * in the statement JSDoc, not in `llms.txt`, not in the sandbox. That is what
 * made `$acc` the predictable outcome — a model emitting plausible JavaScript
 * against a contract it could not see. These assert that the one canonical
 * statement of it stays on the model's learn-from path, and stays complete as
 * the surface grows.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const llms = readFileSync(join(ROOT, "llms.txt"), "utf8");

describe("llms.txt lambda facts", () => {
  it("Covers #221: names $result as reduce's accumulator", () => {
    expect(llms).toMatch(/`\$result` is `reduce`'s ACCUMULATOR/);
  });

  it("Covers #221: says there is no $acc, and never presents one as a binding", () => {
    expect(llms).toContain("there is no `$acc`");
    // The only mentions of `$acc` are the two that say it does not exist.
    const mentions = llms.match(/\$acc/g) ?? [];
    expect(mentions.length).toBe(2);
  });

  it("distinguishes $this in fl.lambda from $parent in the iterating filters", () => {
    expect(llms).toMatch(/piped value in `fl\.lambda`/);
    expect(llms).toMatch(/`\$parent` is the whole array/);
  });

  it("states that a stack variable is only reachable as $var.name", () => {
    expect(llms).toMatch(/NOT also injected as a bare `\$name`/);
  });

  it("states the error-as-value hazard with its mitigation", () => {
    expect(llms).toMatch(/diagnostic\s+TEXT as the value with HTTP 200/);
    expect(llms).toMatch(/Validate before/);
  });

  it("states the module-syntax and console hazards", () => {
    expect(llms).toMatch(/top-level `import`\/`export` is a syntax error/);
    expect(llms).toMatch(/request LOG, not stdout/);
  });

  /**
   * Covers #265. `llms.txt` used to answer "how do I reach a dependency?" with
   * dynamic `import()`, full stop. That is true only on an instance that
   * transpiles the body and resolves the specifier when the `import()` runs; an
   * instance that BUNDLES the body first resolves every literal specifier ahead
   * of time against a filesystem none of them are on, and the author gets
   * `Could not resolve "node:crypto"` back as the VALUE with HTTP 200. So the
   * one form the doc prescribed was the one that could fail, past the globals
   * that never do. These assert the doc names the portable route and keeps the
   * qualifier on the other one.
   */
  it("Covers #265: names the preloaded globals as the dependency route", () => {
    const section = llms.slice(llms.indexOf("## Lambda bodies"), llms.indexOf("## Statements"));
    expect(section).toMatch(/PRELOADED globals/);
    for (const g of LAMBDA_MODULE_GLOBALS) expect(section, g).toContain(`\`${g}\``);
  });

  it("Covers #265: never presents a literal import()/require() specifier as portable", () => {
    const section = llms.slice(llms.indexOf("## Lambda bodies"), llms.indexOf("## Statements"));
    expect(section).not.toMatch(/Reach a dependency with dynamic/);
    expect(section).toMatch(/LITERAL specifier is not\s+portable/);
    expect(section).toMatch(/Could not resolve/);
  });

  it("points at lam.fn as the way to write a body", () => {
    expect(llms).toMatch(/`lam\.fn`/);
    expect(llms).toMatch(/lam\.raw/);
    expect(llms).toMatch(/lam\.file/);
  });

  /**
   * The completeness guard. A newly distilled lambda filter must appear in the
   * table, or it ships with its bindings undocumented — which is exactly the
   * state #221 was reported from.
   */
  it("lists every code-taking surface the SDK knows about", () => {
    const surfaces = [
      ...Object.keys(LAMBDA_CODE_FILTERS).map((n) => `fl.${n}`),
      "s.lambda",
    ];
    const section = llms.slice(llms.indexOf("## Lambda bodies"), llms.indexOf("## Statements"));
    for (const surface of surfaces) expect(section, surface).toContain(`\`${surface}\``);
  });

  it("lists every binding of every surface", () => {
    const section = llms.slice(llms.indexOf("## Lambda bodies"), llms.indexOf("## Statements"));
    for (const bindings of Object.values(LAMBDA_BINDINGS)) {
      for (const binding of bindings) expect(section, binding).toContain(`\`${binding}\``);
    }
  });

  it("keeps the per-filter notes naming the bindings, where the author is looking", () => {
    // The section is canonical, but the line an author actually reads is the
    // filter's own. Both, or the note is one indirection away from useless.
    expect(llms).toMatch(/`fl\.reduce\(initial_value: int, code: text[^)]*\)[^\n]*ACCUMULATOR is `\$result`/);
    expect(llms).toMatch(/`fl\.lambda\(code: text[^)]*\)[^\n]*binds as `\$this`/);
  });

  it("corrects the s.array.map note so it does not imply a shared contract", () => {
    expect(llms).toMatch(/not the JavaScript lambda contract/);
  });

  it("says initial_value is required on reduce, and why", () => {
    expect(llms).toMatch(/`initial_value` is REQUIRED/);
    expect(FILTER_SPECS.reduce?.args?.[0]?.optional).toBeUndefined();
  });
});
