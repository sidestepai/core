import { describe, it, expect } from "vitest";
import {
  buildManifest,
  ENGINE_OBJECT_KINDS,
  PUBLISHED_AUTHOR_FACTORIES,
} from "../../src/manifest/manifest.js";
import { COMMANDS, liveCommandNames, liveSubcommandNames } from "../../src/emit/commands.js";
import { registeredKinds } from "../../src/kinds/kind.js";

/**
 * Consistency guards for `manifest.json`, the exhaustive-reference tier.
 *
 * Two jobs.
 *
 * **CLI coverage.** `manifest.json`'s `cli` array and `sidestep <cmd> --help` are
 * now the ONLY two descriptions of the CLI — `llms.txt` documents authoring and
 * points at them. Both are derived from the `COMMANDS`/`FLAGS` registry, so they
 * cannot disagree; these tests pin that they cannot silently stop being derived
 * either. The hand-maintained array they replaced had drifted badly: `init` and
 * `validate` missing outright, `deploy` short six flags, and a `--static`
 * description that was wrong on the default code path.
 *
 * **No-shrink.** The reference tier's whole job is exhaustiveness, so a slimming
 * pass on `llms.txt` must never take entries out of `manifest.json`. The counts
 * below are the floor as of the audit; they may rise as the SDK grows, never fall.
 */
const m = buildManifest({ version: "test" });

/** Floor as of the 2026-08 AI-docs audit. May rise; must never fall. */
const FLOOR = {
  filters: 225,
  typedFilters: 129,
  // 215 until `placeholder` was withdrawn (#235). The engine has no statement
  // class for `mvp:placeholder` — it writes one where it could not resolve a
  // statement and then refuses the same bytes on import — so the surface only
  // ever produced un-deployable workspaces. It is decoded, never authored; see
  // `test/statements/decode-only.test.ts`. This is the deliberate exception the
  // no-shrink rule is worded against, not a slimming pass.
  statements: 214,
  objectKindsImplemented: 16,
  valueConstructors: 20,
  fieldTypes: 15,
} as const;

describe("manifest.json cli covers the real CLI surface", () => {
  const entries = new Set(m.cli.map((c) => c.command));

  it("has an entry for every live top-level command with no subcommands", () => {
    const missing = liveCommandNames()
      .filter((name) => liveSubcommandNames(name).length === 0)
      .filter((name) => !entries.has(name));
    expect(missing, `commands absent from manifest.cli: ${missing.join(", ")}`).toHaveLength(0);
  });

  it("has an entry for every live subcommand, keyed `<command> <sub>`", () => {
    const missing: string[] = [];
    for (const name of liveCommandNames()) {
      for (const sub of liveSubcommandNames(name)) {
        if (!entries.has(`${name} ${sub}`)) missing.push(`${name} ${sub}`);
      }
    }
    expect(missing, `subcommands absent from manifest.cli: ${missing.join(", ")}`).toHaveLength(0);
  });

  it("invents nothing the registry does not define", () => {
    const unknown = [...entries].filter((cmd) => {
      const [head, sub] = cmd.split(" ");
      if (!(head! in COMMANDS)) return true;
      return sub !== undefined && !liveSubcommandNames(head!).includes(sub);
    });
    expect(unknown, `manifest.cli entries with no registry command: ${unknown.join(", ")}`).toHaveLength(0);
  });

  it("omits removed verbs — they exist only to fail loudly", () => {
    const removed = Object.entries(COMMANDS)
      .filter(([, spec]) => (spec as { removed?: string }).removed !== undefined)
      .map(([name]) => name);
    const leaked = removed.filter((name) => entries.has(name));
    expect(leaked, `removed commands leaked into manifest.cli: ${leaked.join(", ")}`).toHaveLength(0);
  });

  it("gives `init` and `validate` real entries (both were missing when hand-maintained)", () => {
    for (const cmd of ["init", "validate"]) {
      expect(entries.has(cmd), `manifest.cli is missing \`${cmd}\``).toBe(true);
    }
  });

  it("carries deploy's full flag set, including the six the hand-written table dropped", () => {
    const deploy = m.cli.find((c) => c.command === "deploy");
    expect(deploy, "no deploy entry").toBeDefined();
    const flags = (deploy!.flags ?? []).map((f) => f.flag);
    for (const expected of ["--bundle", "--reset", "--lock", "--frozen-lock", "--strict", "--origin"]) {
      expect(
        flags.some((f) => f.startsWith(expected)),
        `deploy is missing ${expected} — flags: ${flags.join(", ")}`,
      ).toBe(true);
    }
  });

  it("describes --static as destination-dependent, not always the parent workspace", () => {
    const flag = m.cli
      .find((c) => c.command === "deploy")!
      .flags!.find((f) => f.flag.startsWith("--static "))!;
    // The bug this replaced said the frontend always lands on the parent
    // workspace. It lands on the EPHEMERAL under the default --dest.
    expect(flag.description).not.toMatch(/^Archive a built frontend directory and deploy it to your \(parent\) workspace/);
  });
});

describe("manifest.json stays exhaustive", () => {
  it("keeps every filter", () => {
    expect(m.filters.length).toBeGreaterThanOrEqual(FLOOR.filters);
    expect(m.filters.filter((f) => f.typed).length).toBeGreaterThanOrEqual(FLOOR.typedFilters);
  });

  it("keeps every statement surface", () => {
    expect(m.statements.length).toBeGreaterThanOrEqual(FLOOR.statements);
  });

  it("keeps every value constructor and field type", () => {
    expect(m.values.constructors.length).toBeGreaterThanOrEqual(FLOOR.valueConstructors);
    expect(m.fieldTypes.length).toBeGreaterThanOrEqual(FLOOR.fieldTypes);
  });

  it("keeps coverage honest", () => {
    expect(m.coverage.objectKinds.implemented).toBeGreaterThanOrEqual(FLOOR.objectKindsImplemented);
    expect(m.coverage.objectKinds.implemented).toBeLessThanOrEqual(m.coverage.objectKinds.total);
  });

  it("every filter and statement entry carries the fields a targeted lookup needs", () => {
    for (const f of m.filters) {
      expect(f.name, "filter with no name").toBeTruthy();
      expect(f.fl, `filter ${f.name} has no \`fl\` surface`).toBeTruthy();
    }
    for (const s of m.statements) {
      expect(s.surface, "statement with no surface").toBeTruthy();
      expect(s.sPath, `statement ${s.surface} has no sPath`).toBeTruthy();
    }
  });
});

describe("manifest.json object kinds resolve", () => {
  it("every kind reported implemented is actually registered", () => {
    const registered = new Set(registeredKinds().map((k) => k.name));
    const unresolved = m.objectKinds
      .filter((k) => k.registered)
      .map((k) => k.kind)
      .filter((kind) => !registered.has(kind));
    expect(unresolved, `reported implemented but not registered: ${unresolved.join(", ")}`).toHaveLength(0);
  });

  it("every implemented kind's payloadKey matches the registered kind's", () => {
    const byName = new Map(registeredKinds().map((k) => [k.name, k.payloadKey]));
    const mismatched = m.objectKinds
      .filter((k) => k.registered && byName.has(k.kind))
      .filter((k) => byName.get(k.kind) !== k.payloadKey)
      .map((k) => `${k.kind}: manifest=${k.payloadKey} registry=${byName.get(k.kind)}`);
    expect(mismatched, mismatched.join("; ")).toHaveLength(0);
  });
});

/**
 * The engine catalog is the coverage denominator, so a factory named there that
 * no descriptor publishes would inflate the numerator, and a published factory
 * missing from the catalog would deflate it. Pinning both directions is what
 * makes the ratio a measurement instead of a claim.
 */
describe("the engine kind catalog and the SDK descriptors pin each other", () => {
  it("every factory the catalog maps to is a published author factory", () => {
    const unknown = ENGINE_OBJECT_KINDS.filter(
      (k) => k.authorFactory !== null && !PUBLISHED_AUTHOR_FACTORIES.has(k.authorFactory),
    ).map((k) => `${k.kind} -> ${k.authorFactory}`);
    expect(unknown, `catalog names a factory no kind publishes: ${unknown.join(", ")}`).toHaveLength(0);
  });

  it("every published author factory appears in the engine catalog", () => {
    const mapped = new Set(
      ENGINE_OBJECT_KINDS.map((k) => k.authorFactory).filter((f): f is string => f !== null),
    );
    const orphaned = [...PUBLISHED_AUTHOR_FACTORIES].filter((f) => !mapped.has(f));
    expect(orphaned, `published but not in the engine catalog: ${orphaned.join(", ")}`).toHaveLength(0);
  });

  it("every unmapped kind says why it is absent", () => {
    const silent = ENGINE_OBJECT_KINDS.filter((k) => k.authorFactory === null && !k.absence).map(
      (k) => k.kind,
    );
    expect(silent, `absent with no reason: ${silent.join(", ")}`).toHaveLength(0);
  });

  it("names each engine kind exactly once", () => {
    const names = ENGINE_OBJECT_KINDS.map((k) => k.kind);
    expect(new Set(names).size).toBe(names.length);
  });
});
