/**
 * U11 — the decoder drift guard.
 *
 * This is the mitigation for codegen's one compounding cost: every hand-written
 * *encoder* now needs a hand-written twin, and the two registries evolve
 * independently. Left alone, decode drifts behind by default and degrades into
 * `raw()` output one statement at a time — a regression that produces no failing
 * test, no error, and no report entry a reviewer would notice, because a `raw()`
 * fallback is by design a *successful* round trip.
 *
 * So a new encoder without a decoder is a red test here rather than a quiet loss
 * of readability. Both directions are checked: an encoder with no inverse, and an
 * inverse pointing at an encoder that no longer exists.
 *
 * Encoders are found by scanning source for `registerStatement("…")` rather than
 * by importing a list. A list would have to be maintained, which is exactly the
 * maintenance this guard exists to make unnecessary.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import "../../src/index.js"; // load every statement registration
import { SPECIAL_DECODERS } from "../../src/codegen/specials/index.js";
import { GENERATED_SPECS } from "../../src/statements/generated/specs.generated.js";
import { KIND_DECODERS_BY_NAME } from "../../src/codegen/kinds/index.js";
import { registeredKinds } from "../../src/kinds/kind.js";

const STATEMENTS_DIR = fileURLToPath(new URL("../../src/statements/", import.meta.url));

/** Every `.ts` under `src/statements/`, one directory deep. */
function statementSources(): Array<{ file: string; source: string }> {
  const out: Array<{ file: string; source: string }> = [];
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // `generated/` is the declarative catalog — covered by the spec arm, not
        // by hand decoders — and `schema-dsl/` is the interpreter itself.
        if (entry.name === "generated" || entry.name === "schema-dsl") continue;
        visit(join(dir, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      out.push({
        file: `${prefix}${entry.name}`,
        source: readFileSync(join(dir, entry.name), "utf8"),
      });
    }
  };
  visit(STATEMENTS_DIR, "");
  return out;
}

/**
 * Stored name → the module that hand-registers its encoder.
 *
 * Two call shapes are in use — a string literal (`registerStatement("mvp:dbo_add",
 * …)`) and a module constant (`registerStatement(SET_VAR, …)`) — so the constant
 * is resolved from its own file. Matching only literals would silently miss four
 * statements, and a guard that under-reports is worse than no guard.
 */
function handWrittenEncoders(): Map<string, string> {
  const out = new Map<string, string>();
  for (const { file, source } of statementSources()) {
    // `statement.ts` defines `registerStatement`; it registers nothing itself.
    if (file === "statement.ts") continue;
    const constants = new Map<string, string>();
    for (const match of source.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*"(mvp:[^"]+)"/g)) {
      constants.set(match[1]!, match[2]!);
    }
    for (const match of source.matchAll(/registerStatement\(\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))/g)) {
      const name = match[1] ?? constants.get(match[2]!);
      if (name !== undefined) out.set(name, file);
    }
  }
  return out;
}

/** Names the declarative catalog covers, which the spec-inverse arm handles generically. */
const SPEC_NAMES: ReadonlySet<string> = new Set(GENERATED_SPECS.map((spec) => spec.name));

/**
 * Hand-written encoders that deliberately have no hand-written decoder, with why.
 *
 * Reviewed exemptions, not a backlog. Anything not listed here and not covered by
 * the spec arm is a gap.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    "mvp:switch_case",
    "never stands alone — it is only ever a child of `mvp:switch`, and the switch decoder reads its cases directly",
  ],
  [
    "mvp:conditional_elif",
    "never stands alone — an `elif` branch is read by the conditional decoder",
  ],
]);

describe("decoder drift guard — statements", () => {
  const encoders = handWrittenEncoders();

  it("finds the hand-written encoder registry it is supposed to be guarding", () => {
    // If the scan silently matched nothing, every assertion below would pass
    // vacuously — which is the one failure mode a drift guard must not have.
    expect(encoders.size).toBeGreaterThan(50);
    expect(encoders.get("mvp:dbo_view")).toBe("special/db.ts");
    expect(encoders.get("mvp:set_var")).toBe("set-var.ts");
  });

  it("gives every hand-written encoder a decoder, a spec, or a reviewed exemption", () => {
    const gaps: string[] = [];
    for (const [name, file] of encoders) {
      if (SPECIAL_DECODERS.has(name)) continue;
      // A hand encoder that ALSO has a declarative spec (e.g. `mvp:debug_log`,
      // `mvp:die`) is decoded generically by the spec-inverse arm — the hand
      // encoder exists for a nicer authoring signature, not a different shape.
      if (SPEC_NAMES.has(name)) continue;
      if (EXEMPT.has(name)) continue;
      gaps.push(`${name} (${file})`);
    }
    expect(
      gaps,
      "these statements would silently decode to raw(); add a decoder in src/codegen/specials/ or an exemption with a reason",
    ).toEqual([]);
  });

  it("has no decoder pointing at an encoder that no longer exists", () => {
    // The other drift direction: a renamed or deleted statement leaves a decoder
    // that can never fire, and looks like coverage while providing none.
    const orphans = [...SPECIAL_DECODERS.keys()].filter((name) => !encoders.has(name));
    expect(orphans).toEqual([]);
  });

  it("exempts nothing that already has a decoder", () => {
    // A stale exemption hides real coverage and invites the next person to skip
    // writing a decoder "because that one is exempt too".
    for (const name of EXEMPT.keys()) {
      expect(SPECIAL_DECODERS.has(name), `${name} is exempt but has a decoder`).toBe(false);
      expect(handWrittenEncoders().has(name), `${name} is exempt but has no encoder`).toBe(true);
    }
  });

  it("states a real reason for every exemption", () => {
    for (const [name, reason] of EXEMPT) {
      expect(reason.length, `${name}`).toBeGreaterThan(20);
    }
  });
});

describe("decoder drift guard — kinds", () => {
  it("gives every registered kind a decoder", () => {
    // A kind added to the encode registry without a decode twin would silently
    // drop every object of that kind out of a pulled tree.
    const missing = registeredKinds()
      .map((kind) => kind.name)
      .filter((name) => !KIND_DECODERS_BY_NAME.has(name));
    expect(missing).toEqual([]);
  });

  it("has no kind decoder without a registered kind", () => {
    const known = new Set(registeredKinds().map((kind) => kind.name));
    const orphans = [...KIND_DECODERS_BY_NAME.keys()].filter((name) => !known.has(name));
    expect(orphans).toEqual([]);
  });
});
