import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { measureLlms } from "../../scripts/measure-llms.js";

/**
 * Fact inventory for the `## Gotchas`, `## Deploy`, and `## Quickstart` prose.
 *
 * Written BEFORE the de-narration pass over those sections. Gotchas is the
 * highest-signal region in the doc — every bullet is a rule an agent gets wrong
 * without it — so the compression there is bounded by an explicit roster: all 22
 * bullets must still be present afterward, keyed by their bold lead phrase. Losing
 * one to a tightening pass is the exact failure this file exists to prevent.
 *
 * Deploy is the opposite case: it carries the most narration in the doc, so the
 * assertions here pin the load-bearing half (destructive-operation warnings, the
 * non-interactive auth path, the injection contract) and let the framing go.
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
  "Build regex-filter patterns with `c.regex(body, flags?)`, never `c.text`.",
  'Declare inputs with `input.<type>()`, read them with `inp("name")`.',
  "Don't take a password through `input.password` on login — it double-hashes.",
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
    needs: [/FULL REPLACE/, /objects AND records/],
  },
  {
    name: "deploy defaults to --dest ephemeral",
    needs: [/--dest\s*\n?\s*ephemeral|--dest ephemeral/, /auto-expiring/],
  },
  {
    name: "event-driven objects deploy but never fire in the sandbox",
    needs: [/DO NOT FIRE IN THE SANDBOX/, /`task`/, /`mcpServer`/, /tableTrigger/],
  },
  {
    name: "the sandbox workaround is to factor the body into a callable function",
    needs: [/defineFunction/, /s\.function\.run/],
  },
  {
    name: "agents authenticate with the refresh-token env pair and must not run `sidestep login`",
    needs: [/\$XANO_REFRESH_TOKEN/, /\$XANO_CLIENT_ID/, /do NOT run/, /sidestep login/],
  },
  {
    name: "auth.json holds ONE credential discriminated by type, oauth or token",
    needs: [/auth\.json/, /ONE credential/, /"oauth"/, /"token"/],
  },
  {
    name: "the static deploy injects window.XANO_HOST before the app bundle",
    needs: [/window\.XANO_HOST/, /index\.html/, /<head>/],
  },
  {
    name: "verify injection with a cache-busting fetch and grep the BARE token, not the dot form",
    needs: [/cache-bust/i, /grep `?XANO_HOST`?/, /dot[- ]form/],
  },
  {
    name: "a static failure never rolls back the backend and is retried on its own",
    needs: [/never rolls back the backend/i, /retry|resumable/i],
  },
  {
    name: "injected static config is PUBLIC — secrets go in backend env",
    needs: [/--static-env/, /PUBLIC/, /never secrets/i, /env\(/],
  },
  {
    name: "a pulled tree is secret-bearing and schema-only",
    needs: [/secret-bearing/, /SCHEMA-ONLY/i],
  },
  {
    name: "there is no `workspace deploy` — SideStep never writes back to the real workspace",
    needs: [/workspace deploy/, /never writes back/],
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
 * Deploy is the most padded section in the doc — narration, restatement, and a
 * worked "typical agent flow" whose commands both appear in full above it. Unlike
 * the def-shape sections (which sit at their information floor), this one has real
 * headroom, so the ceiling here is a target the de-narration pass must actually hit.
 */
describe("prose sections stay lean", () => {
  it("Deploy is under 2,600 tokens", () => {
    const s = measureLlms(llms).sections.find((x) => x.title.startsWith("Deploy"));
    expect(s, "no `## Deploy` section").toBeDefined();
    expect(s!.tokens).toBeLessThan(2_600);
  });

  it("Gotchas is under 2,600 tokens", () => {
    const s = measureLlms(llms).sections.find((x) => x.title === "Gotchas");
    expect(s, "no `## Gotchas` section").toBeDefined();
    expect(s!.tokens).toBeLessThan(2_600);
  });
});
