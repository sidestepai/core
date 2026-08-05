import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, renderLlmsTxt, OVERRIDDEN_SURFACES, KIND_DESCRIPTORS } from "../../src/manifest/manifest.js";
import { s } from "../../src/statements/s.js";
import { GENERATED_SPECS } from "../../src/statements/generated/specs.generated.js";
import { registeredKinds } from "../../src/kinds/kind.js";
import { TAGS } from "../../src/types/xdo.js";
import { TOTAL_STATEMENTS } from "../../src/statements/surfaces.js";
import { FILTER_NAMES } from "../../src/values/generated/filters.generated.js";
import { c, sys } from "../../src/values/value.js";
import { realtimeTrigger } from "../../src/kinds/trigger.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };

/** Collect every callable leaf path under `s` (dotted), matching the manifest's sPath. */
function walkLeaves(node: unknown, path: string[], out: Set<string>): void {
  for (const k of Object.keys(node as Record<string, unknown>)) {
    const v = (node as Record<string, unknown>)[k];
    const p = [...path, k];
    if (typeof v === "function") {
      out.add(p.join("."));
      // A function node can also be a namespace (e.g. cloud.job has .await/.status).
      for (const ck of Object.keys(v)) {
        const cv = (v as unknown as Record<string, unknown>)[ck];
        if (typeof cv === "function" || (cv && typeof cv === "object")) walkLeaves({ [ck]: cv }, p, out);
      }
    } else if (v && typeof v === "object") {
      walkLeaves(v, p, out);
    }
  }
}

describe("manifest", () => {
  const m = buildManifest({ version: pkg.version });

  it("covers every statement surface with no duplicates", () => {
    expect(m.statements).toHaveLength(TOTAL_STATEMENTS);
    const surfaces = m.statements.map((x) => x.surface);
    expect(new Set(surfaces).size).toBe(surfaces.length);
  });

  it("reports honest coverage", () => {
    expect(m.coverage.statements).toEqual({ implemented: TOTAL_STATEMENTS, total: TOTAL_STATEMENTS });
    // 24 of the engine's 30 object kinds. Counted over the ENGINE catalog, where
    // each trigger type is its own kind — counting SDK kinds instead reported 16,
    // because one `trigger` kind answers for seven engine kinds.
    expect(m.coverage.objectKinds.implemented).toBe(24);
    expect(m.coverage.objectKinds.total).toBe(30);
    expect(m.coverage.objectKinds.unmodeled.map((k) => k.kind)).toEqual([
      "branch",
      "market_item",
      "realtime_channel",
      "run.job",
      "run.service",
      "tablemap",
    ]);
  });

  it("every statement sPath resolves to a real callable leaf under s", () => {
    const leaves = new Set<string>();
    walkLeaves(s, [], leaves);
    for (const stmt of m.statements) {
      expect(leaves.has(stmt.sPath), `${stmt.surface} → s.${stmt.sPath}`).toBe(true);
    }
    // And the manifest accounts for every reachable leaf.
    expect(new Set(m.statements.map((x) => x.sPath)).size).toBe(leaves.size);
  });

  it("declarative entries carry a field schema; specials do not", () => {
    const specNames = new Set(GENERATED_SPECS.map((x) => x.name));
    for (const stmt of m.statements) {
      if (stmt.declarative) {
        expect(specNames.has(stmt.storedName)).toBe(true);
        expect(stmt.fields).toBeDefined();
        expect(typeof stmt.output).toBe("boolean");
      } else {
        expect(stmt.fields).toBeUndefined();
      }
    }
    // Unique declarative stored names == the generated spec catalog, minus the
    // surfaces whose public `s.` factory is a hand-authored typed override (their
    // generated field signature is deliberately suppressed — see OVERRIDDEN_SURFACES).
    const declNames = new Set(m.statements.filter((x) => x.declarative).map((x) => x.storedName));
    const expectedDecl = new Set([...specNames].filter((n) => !OVERRIDDEN_SURFACES.has(n)));
    expect(declNames).toEqual(expectedDecl);
  });

  it("object-kind descriptors match the live kind registry", () => {
    const registered = new Map(registeredKinds().map((k) => [k.name, k.payloadKey]));
    for (const k of m.objectKinds) {
      expect(k.registered).toBe(true);
      expect(registered.get(k.kind)).toBe(k.payloadKey);
    }
    // The published catalog plus the withheld descriptors must together account
    // for every registered kind — that is what keeps the drift guard meaningful
    // while a kind is unpublished. A kind registered with NO descriptor at all
    // still fails here.
    const withheld = KIND_DESCRIPTORS.filter((d) => d.unpublished);
    expect(m.objectKinds.length + withheld.length).toBe(registered.size);
    for (const d of withheld) {
      expect(registered.has(d.kind), `withheld kind ${d.kind} is not registered`).toBe(true);
    }
  });

  it("withholds nothing, and publishes the whole realtime family", () => {
    // The guard on the release gate itself, now pointed the other way: the
    // realtime kinds shipped, so an accidental *re*-withholding shows up here
    // rather than as a silently missing primitive in llms.txt. Any future kind
    // that lands behind the gate also fails here until this list says so.
    const withheld = KIND_DESCRIPTORS.filter((d) => d.unpublished).map((d) => d.kind);
    expect(withheld).toEqual([]);

    const llms = renderLlmsTxt(m);
    const published = JSON.stringify(m) + llms;
    for (const factory of [
      "realtimeServer",
      "realtimeChannel",
      "realtimeMessage",
      "realtimeServerTrigger",
      "realtimeChannelTrigger",
    ]) {
      expect(published, `${factory} must reach the published surface`).toContain(factory);
    }
    for (const method of ["registerRealtimeServers", "registerRealtimeChannels", "registerRealtimeMessages"]) {
      expect(published).toContain(method);
    }
  });

  it("names legacy constructors in the Legacy index and nowhere an agent picks from", () => {
    // The legacy split has to hold in BOTH directions, and each direction fails
    // a different way. Leaking into `## Values` puts a superseded paradigm in
    // the list an agent builds from; dropping out of `## Legacy` entirely leaves
    // an agent unable to recognize it in pulled code, which is how a working
    // decoded value gets "fixed" into a broken one.
    const legacy = m.values.constructors.filter((v) => v.legacy);
    expect(legacy.map((v) => v.name)).toEqual(["c.expressionLegacy"]);

    const llms = renderLlmsTxt(m);
    const valuesSection = llms.slice(llms.indexOf("## Values"), llms.indexOf("## Fields"));
    const legacySection = llms.slice(llms.indexOf("## Legacy"));
    for (const v of legacy) {
      expect(valuesSection, `${v.name} must not be selectable`).not.toContain(v.name);
      expect(legacySection, `${v.name} must stay recognizable`).toContain(v.name);
      // Named, never specified — a signature is an invitation to call it.
      expect(legacySection).not.toContain(`${v.name}${v.signature}`);
    }
    // It stays a real export regardless — codegen emits it for pulled workspaces.
    expect(typeof c.expressionLegacy).toBe("function");
  });

  it("holds the same legacy split for the superseded realtime trigger and statement", () => {
    // The realtime pair is why the legacy index stopped being values-only: the
    // same superseded paradigm surfaces as a trigger FACTORY and as a STATEMENT,
    // and naming only one leaves the other looking current. Worse than for
    // values, because the two realtime generations reuse the words "realtime" and
    // "channel" for different objects — an agent that sees both in one catalog
    // mixes them, and a mixed workspace fails at runtime, not at compile.
    const llms = renderLlmsTxt(m);
    const legacySection = llms.slice(llms.indexOf("## Legacy"));
    // `## Legacy` is the last section, so everything before it is what an agent
    // picks from — a wider net than the per-section slices the values test uses,
    // and the right one here: these two leaked through the trigger PROSE, not the
    // catalog, so a catalog-only slice would have passed while the leak shipped.
    const selectable = llms.slice(llms.indexOf("## Object kinds"), llms.indexOf("## Legacy"));
    const statementsSection = llms.slice(llms.indexOf("## Statements"), llms.indexOf("## Legacy"));
    expect(selectable.length).toBeGreaterThan(0);
    expect(legacySection.length).toBeGreaterThan(0);

    const legacyFactories = m.objectKinds.flatMap((k) => (k.subKinds ?? []).filter((s) => s.legacy));
    expect(legacyFactories.map((s) => s.authorFactory)).toEqual(["realtimeTrigger"]);
    const legacyStatements = m.statements.filter((s) => s.legacy);
    expect(legacyStatements.map((s) => s.sPath)).toEqual(["api.realtime_event"]);

    for (const f of legacyFactories) {
      expect(selectable, `${f.authorFactory} must not be selectable`).not.toContain(
        f.authorFactory,
      );
      expect(legacySection, `${f.authorFactory} must stay recognizable`).toContain(f.authorFactory);
    }
    for (const s of legacyStatements) {
      expect(statementsSection, `s.${s.sPath} must not be selectable`).not.toContain(s.sPath);
      expect(legacySection, `s.${s.sPath} must stay recognizable`).toContain(s.sPath);
    }

    // The trigger-authoring PROSE is a separate hand-written block from the
    // catalog, and it listed the legacy factory by name in two places (the
    // factory-set line and its own bullet). Both had to go, or the split leaks
    // through the part an agent actually reads first.
    const triggerProse = llms.slice(llms.indexOf("### Triggers"), llms.indexOf("### Responses"));
    expect(triggerProse).not.toContain("realtimeTrigger");
    expect(triggerProse).toContain("realtimeChannelTrigger");

    // Both stay real exports — codegen emits them for pulled workspaces.
    expect(typeof realtimeTrigger).toBe("function");
    expect(typeof s.api.realtime_event).toBe("function");
  });

  it("every object kind carries a non-empty description, rendered into the llms.txt catalog", () => {
    const llms = renderLlmsTxt(m);
    for (const k of m.objectKinds) {
      // A blank description would silently ship an uninformative catalog line —
      // the golden-file snapshot alone would not catch it.
      expect(k.description.trim().length).toBeGreaterThan(0);
      if (k.subKinds && k.subKinds.length > 0) {
        // A fan-out kind (trigger) renders one root-level line per sub-kind,
        // each with its own rich description and stored obj_type.
        for (const sub of k.subKinds) {
          expect(sub.authorFactory.length).toBeGreaterThan(0);
          expect(sub.objType.length).toBeGreaterThan(0);
          expect(sub.description.trim().length).toBeGreaterThan(0);
          // A legacy sub-kind is described too, but its description lands in
          // `## Legacy` rather than the catalog — the catalog is the list an agent
          // picks from. Where it renders is asserted by the legacy-split test.
          if (!sub.legacy) expect(llms).toContain(`\`${sub.authorFactory}\``);
          expect(llms).toContain(`— ${sub.description}`);
        }
      } else {
        // The `## Object kinds` catalog line must actually surface the descriptor.
        expect(llms).toContain(`— ${k.description}`);
      }
    }
  });

  it("exposes the full tag catalog", () => {
    expect(m.values.tags).toEqual(TAGS);
  });

  it("sys.* catalog entry names every live sys accessor", () => {
    // Drift guard: the hand-written `Accessors: …` prose in the sys.* constructor
    // entry must list every `Object.keys(sys)` name, so adding an accessor without
    // updating the catalog fails here rather than shipping a stale published list.
    const entry = m.values.constructors.find((c) => c.name === "sys.*");
    expect(entry).toBeDefined();
    for (const accessor of Object.keys(sys)) {
      expect(entry!.description).toContain(accessor);
    }
  });

  it("catalogs every value-pipeline filter with honest typed coverage", () => {
    expect(m.filters.map((f) => f.name)).toEqual([...FILTER_NAMES]);
    expect(m.coverage.filters.total).toBe(FILTER_NAMES.length);
    expect(m.coverage.filters.typed).toBe(m.filters.filter((f) => f.typed).length);
    expect(m.coverage.filters.typed).toBeGreaterThan(0);
    // Typed entries carry args; the fl accessor is always present.
    for (const f of m.filters) {
      expect(f.fl).toBe(`fl.${f.name}`);
      if (f.typed) expect(f.args && f.args.length).toBeGreaterThan(0);
      else expect(f.args).toBeUndefined();
    }
  });

  // #145 (Ask #1): output-bearing statements carry a machine-readable result
  // descriptor (`as` var name + type) so the manifest answers "what does this
  // bind?" without falling back to prose. Curated, not exhaustive.
  it("statements carry a curated result descriptor for the tester's flagship + db family (#145)", () => {
    const bySurface = new Map(m.statements.map((x) => [x.surface, x]));
    // The exact case the feedback named: security.check_password → boolean.
    expect(bySurface.get("security.check_password")?.result).toMatchObject({ name: "as", type: "boolean" });
    expect(bySurface.get("security.check_password")?.result?.note).toMatch(/input\.password/);
    // db.* mirrors InferResponse / the curated Runtime behavior prose.
    expect(bySurface.get("db.get")?.result?.type).toBe("InferRow<T> | null");
    expect(bySurface.get("db.add")?.result?.type).toBe("InferRow<T>");
    expect(bySurface.get("db.has")?.result?.type).toBe("boolean");
    expect(bySurface.get("db.query")?.result?.type).toBe("InferRow<T>[]");
    // A clearly-typed declarative op.
    expect(bySurface.get("math.add")?.result?.type).toBe("number");
    // Absent from the curated map ⇒ no result descriptor (field is optional).
    expect(bySurface.get("db.truncate")?.result).toBeUndefined();
  });

  it("renderLlmsTxt surfaces the result binding inline in the statement catalog (#145)", () => {
    const txt = renderLlmsTxt(m);
    expect(txt).toContain("s.security.check_password");
    // The `→ as: <type>` suffix rides the catalog line.
    expect(txt).toMatch(/s\.security\.check_password.*→ as: boolean/);
    expect(txt).toMatch(/s\.db\.get.*→ as: InferRow<T> \| null/);
  });

  // #145 (Trap B): the input.password → check_password double-hash footgun (#109)
  // is guarded only by prose (a static/runtime rejection is infeasible — the value
  // at the check_password call site is an unbranded inp("password")). Pin the
  // Gotchas coverage so a future regen can't silently drop the warning or its
  // input.text + f.password workaround.
  it("llms.txt keeps the input.password double-hash gotcha and its workaround (#145/#109)", () => {
    const txt = renderLlmsTxt(m);
    expect(txt).toContain("input.password");
    expect(txt).toMatch(/double-hash/i);
    expect(txt).toContain("check_password");
    // The workaround: input.text + the column-side hash-on-write.
    expect(txt).toContain("input.text");
    expect(txt).toContain("f.password");
  });

  it("committed manifest.json is up to date (run `npm run manifest`)", () => {
    const committed = readFileSync(join(ROOT, "manifest.json"), "utf8");
    expect(committed).toBe(JSON.stringify(m, null, 2) + "\n");
  });

  it("committed llms.txt is up to date (run `npm run manifest`)", () => {
    const committed = readFileSync(join(ROOT, "llms.txt"), "utf8");
    expect(committed).toBe(renderLlmsTxt(m));
  });
});
