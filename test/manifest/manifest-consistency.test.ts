import { describe, it, expect } from "vitest";
import { buildManifest } from "../../src/manifest/manifest.js";
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
  statements: 215,
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
