import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { measureLlms } from "../../scripts/measure-llms.js";

/**
 * Fact inventory for the `## Gotchas`, `## Deploy`, and `## Quickstart` prose.
 *
 * Gotchas is the highest-signal region in the doc — every bullet is a rule an agent
 * gets wrong without it — so compression there is bounded by an explicit roster:
 * every bullet must still be present afterward, keyed by its bold lead phrase, and
 * the count is asserted so one cannot quietly vanish or appear.
 *
 * Deploy was cut down to the authoring-relevant half when the CLI surface moved out
 * of this doc. `sidestep <cmd> --help` documents every command and flag from the
 * same registry that fills `manifest.json`'s `cli` array, so duplicating it here
 * bought nothing but drift — and it HAD drifted: the `--static` description claimed
 * the frontend always lands on the parent workspace, which is true only under
 * `--dest sandbox`.
 *
 * What stayed is what `--help` cannot carry: the ephemeral-vs-sandbox targeting
 * split (it changes where the frontend lands and how redeploys behave), the
 * full-replace blast radius, and the `window.XANO_HOST` contract the frontend's own
 * code must honor. Three further facts were PROMOTED into Gotchas rather than
 * dropped, because they constrain how you author rather than how you invoke: the
 * non-interactive auth path, the sandbox no-fire rule, and how to read a pulled
 * tree. The roster below covers them.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const llms = readFileSync(join(ROOT, "llms.txt"), "utf8");

/** The bold lead phrase of every `## Gotchas` bullet. Roster — none may vanish. */
const GOTCHA_BULLETS = [
  "No callback builder.",
  "Foreign key is `f.tableRef(table)`, not `ref`.",
  "Reference-helper picker:",
  "Drilling into a maybe-null `db.get` result 500s",
  "DB reads are field-match, not `where`-expr.",
  "Single-field only — no composite match.",
  "System columns are auto-injected.",
  "Seed a table's starting rows with `table({ seed })`.",
  "`use_xdo` storage mode.",
  "Self-referencing tables",
  "Same-name siblings collide.",
  "`export()` vs `emitBundle()` vs `writeBundle()`:",
  "Client bundle size / tree-shaking.",
  "Intra-workspace imports use `.js` specifiers",
  "Verifying a def outside a bundler.",
  "Block specials nest a `body`, not a `stack`.",
  "MCP servers & agents are distinct root kinds",
  "`task.schedule` is an array",
  "`get_input`/`get_raw_input` read the whole payload",
  // #224/#231-C3. The broken `auth/login` recipe is copied verbatim into nearly
  // every project, and the fix used to live ~220 lines away on the `s.db.get`
  // signature — where nobody is standing when they declare the column.
  "`f.password()` defaults to `access: \"internal\"`, so `db.get` does NOT return it.",
  "Build regex-filter patterns with `c.regex(body, flags?)`, never `c.text`.",
  'Declare inputs with `input.<type>()`, read them with `inp("name")`.',
  "Don't take a password through `input.password` on login — it double-hashes.",
  // Promoted from the old `## Deploy` prose when the CLI surface moved to `--help`.
  "Agents authenticate with env vars — never `sidestep login`.",
  "Event-driven objects fire on an EPHEMERAL, not in the sandbox.",
  "Reading a pulled tree.",
];

type Fact = { name: string; needs: RegExp[] };

const GOTCHA_FACTS: Fact[] = [
  {
    name: "input.password double-hashes; take the submission as input.text() on both signup and login",
    needs: [/input\.password/, /double-hash/i, /input\.text\(\)/, /check_password/],
  },
  {
    name: "a bare c.text regex pattern matches nothing for every input",
    needs: [/c\.regex\(/, /c\.text\(/, /matches \*?nothing\*?/i, /delimiter-wrapped/],
  },
  {
    name: "the safe-ref opt-in avoids the 500 on a null base",
    needs: [/\{ safe: true \}/, /500/, /Unable to locate var/],
  },
  {
    name: "db reads match exactly one field — no composite form",
    needs: [/fieldName/, /fieldValue/, /composite/i, /ANDed/],
  },
  {
    name: "seed rows auto-number for an int PK and mixing explicit/omitted id throws",
    needs: [/seed/, /auto-number|auto-numbers/i, /All-or-nothing|all-or-nothing/i],
  },
  {
    name: "task.schedule is a ScheduleDef[] of ISO-8601 strings, not epoch numbers",
    needs: [/ScheduleDef\[\]/, /ISO-8601/, /not epoch/i],
  },
  {
    name: "self-referencing tables need the bare-name form",
    needs: [/Self-referencing/, /used before declaration/],
  },
];

const DEPLOY_FACTS: Fact[] = [
  {
    name: "deploy is a FULL REPLACE that clears objects AND records",
    needs: [/FULL REPLACE/, /objects\s+AND records/],
  },
  {
    name: "deploy defaults to --dest ephemeral",
    needs: [/--dest\s*\n?\s*ephemeral|--dest ephemeral/, /auto-expiring/],
  },
  {
    name: "event-driven objects fire on an ephemeral but not in the sandbox",
    needs: [
      /fire on an EPHEMERAL/i,
      /DEFAULT destination/i,
      /--dest sandbox/,
      /NEVER execute/i,
      /`task`/, /`mcpServer`/, /tableTrigger/,
    ],
  },
  {
    name: "the sandbox workaround is to factor the body into a callable function",
    needs: [/defineFunction/, /s\.function\.run/],
  },
  {
    name: "agents authenticate with the refresh-token env pair and must not run `sidestep login`",
    needs: [/\$XANO_REFRESH_TOKEN/, /\$XANO_CLIENT_ID/, /never `sidestep login`/, /browser consent/],
  },
  {
    name: "the static deploy injects window.XANO_HOST before the app bundle",
    needs: [/window\.XANO_HOST/, /index\.html/, /before the app bundle/],
  },
  {
    name: "injected static config is PUBLIC — secrets go in backend env",
    needs: [/PUBLIC/, /never secrets/i, /env\(name\)/],
  },
  {
    name: "a pulled tree is secret-bearing",
    needs: [/secret-bearing/],
  },
  {
    name: "--static target follows --dest: ephemeral hosts it, sandbox falls back to the parent workspace",
    needs: [/ON THE EPHEMERAL/, /OWN \(parent\) workspace/, /does\s*\n?\s*not serve static hosting|not serve static hosting/],
  },
  {
    name: "an ephemeral refreshes in place on redeploy; the URL is unchanged",
    needs: [/REFRESHES it/, /URL is unchanged/, /\.xano\/ephemeral\.json/],
  },
  {
    name: "the CLI surface is reachable from --help and manifest.json, not duplicated here",
    needs: [/sidestep <command> --help/, /`cli` array/],
  },
];

const QUICKSTART_FACTS: Fact[] = [
  {
    name: "the entry must be an ES module and npm init -y breaks it",
    needs: [/ES module/i, /"type": "module"/, /npm init -y/],
  },
  {
    name: "guids derive from (type, name), so renames change identity",
    needs: [/guids? derive from/i, /renames change identity/],
  },
  {
    name: "seedLockOverrides must run BEFORE importing any def module",
    needs: [/seedLockOverrides/, /BEFORE importing/, /silent no-op/],
  },
  {
    name: "system columns are auto-injected in the quickstart table",
    needs: [/auto-injected/, /don't declare them/],
  },
];

function assertFacts(group: string, facts: Fact[]): void {
  describe(group, () => {
    for (const { name, needs } of facts) {
      it(name, () => {
        const missing = needs.filter((re) => !re.test(llms)).map(String);
        expect(missing, `missing from llms.txt: ${missing.join(", ")}`).toHaveLength(0);
      });
    }
  });
}

describe("every Gotchas bullet survives", () => {
  for (const lead of GOTCHA_BULLETS) {
    it(`keeps: ${lead.slice(0, 55)}`, () => {
      expect(llms, `Gotchas bullet dropped: ${lead}`).toContain(`**${lead}`);
    });
  }

  it("has exactly the roster, and nothing silently added without review", () => {
    const section = llms.slice(llms.indexOf("## Gotchas"), llms.indexOf("## Object kinds"));
    const found = [...section.matchAll(/^- \*\*/gm)];
    expect(found).toHaveLength(GOTCHA_BULLETS.length);
  });
});

assertFacts("llms.txt Gotchas facts", GOTCHA_FACTS);
assertFacts("llms.txt Deploy facts", DEPLOY_FACTS);
assertFacts("llms.txt Quickstart facts", QUICKSTART_FACTS);

/**
 * Section ceilings, set from the measured floor after de-narration.
 *
 * Deploy carried the most narration in the doc and was expected to have real
 * headroom. It had less than it looked: every removable phrase — "the primary
 * loop", "call this out to agents", "ideal for headless agents", "just works", the
 * redundant "typical agent flow" worked example, and the restatement around FULL
 * REPLACE — came to ~340 tokens against a 3,380-token section. What remains is CLI
 * contract: flags, paths, destructive-operation warnings, the two credential
 * shapes, the injection rules. None of it is prose that can be shortened without
 * dropping a flag or a warning.
 *
 * So these are RE-BLOAT guards, not targets. Same rule as the budget tripwire: if a
 * legitimate new flag or warning pushes past one, raise it; never cut grounding to
 * fit. Ratchet down after a real reduction.
 */
const DEPLOY_CEILING = 800;
/**
 * Raised 3,500 → 3,550 for one clause on the `seed` entry (issue #259): id-pinning
 * is a `seed` property, and the runtime `s.db.bulk.add` drops `id` instead. The
 * entry already promised pinning without saying where the promise ends, which is
 * exactly the reading that cost someone a debugging session — a warning, not prose.
 */
const GOTCHAS_CEILING = 3_550;

describe("prose sections stay lean", () => {
  it(`Deploy is under ${DEPLOY_CEILING.toLocaleString()} tokens`, () => {
    const s = measureLlms(llms).sections.find((x) => x.title.startsWith("Deploy"));
    expect(s, "no `## Deploy` section").toBeDefined();
    expect(s!.tokens).toBeLessThan(DEPLOY_CEILING);
  });

  it(`Gotchas is under ${GOTCHAS_CEILING.toLocaleString()} tokens`, () => {
    const s = measureLlms(llms).sections.find((x) => x.title === "Gotchas");
    expect(s, "no `## Gotchas` section").toBeDefined();
    expect(s!.tokens).toBeLessThan(GOTCHAS_CEILING);
  });
});
