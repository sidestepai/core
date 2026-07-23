/**
 * Field-method catalog (`fields/generated/field-methods.generated.ts`) — the
 * per-field-type method-name unions distilled from the engine's column-create
 * schema into `vendor/field-methods.json`. Covers membership, the email→text
 * family alias, and an offline freshness guard (committed generated file must
 * match a fresh build from the committed vendor snapshot — no upstream needed).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { FIELD_METHODS } from "../../src/fields/generated/field-methods.generated.js";

const ROOT = join(import.meta.dirname, "../..");

describe("field-method catalog", () => {
  /** Index helper that asserts the type exists (keeps strict index access happy). */
  const methodsOf = (t: string): Record<string, string> => {
    const set = FIELD_METHODS[t];
    expect(set, `FIELD_METHODS.${t}`).toBeDefined();
    return set!;
  };

  it("text carries the full validator set", () => {
    const text = methodsOf("text");
    expect(Object.keys(text)).toEqual(
      ["alphaOk", "digitOk", "lower", "max", "min", "ok", "pattern", "startsWith", "trim", "upper"],
    );
    expect(text.min).toBe("int"); // colon-form arg type
    expect(text.trim).toBe("bool"); // flag, no arg
  });

  it("numeric types expose only min/max", () => {
    for (const t of ["int", "decimal", "vector", "tableRef"]) {
      expect(Object.keys(methodsOf(t))).toEqual(["max", "min"]);
    }
  });

  it("email exposes only its runtime-resolvable methods, NOT text's full set (#106)", () => {
    // The catalog distills email from text (family alias), but an empirical runtime
    // probe found only `lower`/`trim` resolve on an email field — the rest 500 with
    // `Invalid method for filter`. The reconcile against the empirical allowlist
    // trims email to the real set. See scripts/probe-field-methods.ts.
    expect(methodsOf("email")).toEqual({ lower: "bool", trim: "bool" });
    expect(methodsOf("email")).not.toEqual(methodsOf("text"));
  });

  it("password has its own richer set", () => {
    const password = methodsOf("password");
    expect(Object.keys(password)).toContain("minSymbol");
    // `salt` and vector `min`/`max` were absent from the mvp/xs schema dump but
    // DO resolve at runtime — proof the empirical probe (not the static schema) is
    // authoritative. They are kept.
    expect(password.salt).toBe("text");
  });

  it("every exposed field method is in the empirical runtime allowlist (#106)", () => {
    const { resolvable } = JSON.parse(
      readFileSync(join(ROOT, "vendor/field-methods-resolvable.json"), "utf8"),
    ) as { resolvable: Record<string, string[]> };
    for (const [type, set] of Object.entries(FIELD_METHODS)) {
      const allow = resolvable[type];
      if (!allow) continue; // no probe data for this type → not asserted
      for (const method of Object.keys(set)) expect(allow, `${type}.${method}`).toContain(method);
    }
  });

  it("the committed generated file is fresh vs the vendor snapshot", () => {
    const path = join(ROOT, "src/fields/generated/field-methods.generated.ts");
    const committed = readFileSync(path, "utf8");
    const out = execFileSync("npx", ["tsx", "scripts/codegen-field-methods.ts"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env },
    });
    expect(out).toMatch(/Wrote .*field-methods\.generated\.ts/);
    expect(readFileSync(path, "utf8")).toBe(committed);
  });
});
