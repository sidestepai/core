import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { measureLlms } from "../../scripts/measure-llms.js";

/**
 * Fact inventory for the three walls-of-text in `### Specials — authored
 * signatures`: `s.db.query` (988 tokens in one paragraph), the addon entry (612),
 * and the `InferResponse` derivation (429).
 *
 * Written BEFORE the reshape, same contract as the realtime inventory: identical
 * constraint set, addressable form. These three are reshaped and the rest of the
 * Specials block is left alone deliberately — the control-flow and db read/write
 * bullets are already one-line-per-statement, and splitting an already-terse line
 * costs tokens for nothing (see the realtime measurement in
 * `llms-realtime-facts.test.ts`).
 *
 * `s.db.query` earns the attention because it is the most-authored statement in the
 * SDK and had the worst shape in the doc.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const llms = readFileSync(join(ROOT, "llms.txt"), "utf8");

type Fact = { name: string; needs: RegExp[] };

const DB_QUERY: Fact[] = [
  {
    name: "bind adds joins, default inner, dotted paths, distinct aliases per table",
    needs: [/`bind`/, /join.*default.*inner|`\\?"inner\\?"`/i, /dotted path/i, /distinct alias/i],
  },
  {
    name: "returnType drives both context.return.type and the InferResponse shape",
    needs: [/returnType/, /"count"/, /"exists"/, /"single"/, /"stream"/, /"aggregate"/, /InferResponse/],
  },
  {
    name: "eval grafts computed columns as unknown keys, and shadowing a column throws",
    needs: [/`eval`/, /computed column/i, /unknown/, /shadow/i],
  },
  {
    name: "aggregate group/eval names must be BARE columns; a dotted name passes through",
    needs: [/aggregate/, /\bbare\b/i, /alias-qualified/i, /Unsupported param format/, /already-dotted/i],
  },
  {
    name: "paging with metadata on wraps the result in an envelope; metadata:false keeps the array",
    needs: [/paging envelope/i, /itemsReceived/, /curPage/, /metadata:\s*false/],
  },
  {
    name: "totals:true adds itemsTotal/pageTotal",
    needs: [/totals:\s*true/, /itemsTotal/, /pageTotal/],
  },
  {
    name: "paging fields accept a Value for input-bound paging",
    needs: [/input-bound paging/i, /inp\("page"\)/, /simpleExternal/],
  },
  {
    name: "a search/sort-only paging does not paginate",
    needs: [/search`?\/`?sort`?-only|`search`\/`sort`-only/, /does NOT paginate|not paginate/i],
  },
  {
    name: "external is the whole-config blob and falls back to input-bound paging when empty",
    needs: [/`external:/, /falls back/i, /resolves empty|comes back empty/i],
  },
  {
    name: "nextPage is the typed has-next signal",
    needs: [/nextPage/, /has-next/i],
  },
  {
    name: "cmp covers the full operator set; and()/or() compose nested boolean logic",
    needs: [/cmp\(left, op, right/, /ignoreEmpty/, /and\(\.\.\.\)/, /or\(\.\.\.\)/],
  },
  {
    name: "a where/cmp operand may be a filtered value inline",
    needs: [/withFilters\(\.\.\.\)/, /inline/i],
  },
  {
    name: "distinct rides context.return.<list|stream>.distinct",
    needs: [/`distinct`/, /"auto"/, /context\.return/],
  },
];

const ADDONS: Fact[] = [
  {
    name: "addon attaches to query/get/add/edit/patch, and not to add_or_edit/del/has/truncate",
    needs: [/db\.query`?\/`?get/, /add_or_edit`?\/`?del`?\/`?has`?\/`?truncate|no `addon`/],
  },
  {
    name: "as is a bare alias or a dotted offset.alias, auto-prefixed under a paging envelope",
    needs: [/offset\.alias/, /auto|automatic/i, /double-prefix/i],
  },
  {
    name: "out(col) binds a parent-row column into an addon input",
    needs: [/out\(col\)/],
  },
  {
    name: "the addon factory signature and registerAddons",
    needs: [/addon\(\{ name, table/, /registerAddons/],
  },
  {
    name: "never author table: null — it is a broken table-less addon",
    needs: [/table: null/, /BROKEN|broken/],
  },
  {
    name: "tableAlias is the SQL alias qualifying where/sort columns",
    needs: [/tableAlias/, /col\("merchant\.id"\)/],
  },
  {
    name: "cardinality shapes the graft: single/list/count/exists/aggregate",
    needs: [/cardinality/, /"single"/, /"list"/, /"count"/, /"exists"/, /"aggregate"/],
  },
  {
    name: "an alias shadowing an existing column throws at build time",
    needs: [/shadow/i, /build time/i, /`_` prefix|prefix/],
  },
];

const INFER_RESPONSE: Fact[] = [
  {
    name: "write ops bind the full row and stay non-nullable; a miss throws",
    needs: [/db\.add/, /db\.edit/, /NotFound/, /404/, /unique-constraint/],
  },
  {
    name: "db.get is Row | null because it binds null on a miss",
    needs: [/`?Row \\?\| null`?/, /db\.get/],
  },
  {
    name: "db.has is boolean and db.bulk.delete is a number count",
    needs: [/db\.has/, /boolean/, /db\.bulk\.delete/, /number/],
  },
  {
    name: "an output selection narrows to a Pick, still nullable for get",
    needs: [/`?Pick`?/, /output/],
  },
  {
    name: "untyped ops resolve to unknown and responseShape closes it",
    needs: [/unknown/, /responseShape/, /direct_query/],
  },
  {
    name: "a post middleware with resultStrategy replace needs an explicit responseShape",
    needs: [/resultStrategy: "replace"/, /post/, /responseShape/],
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

assertFacts("llms.txt s.db.query facts", DB_QUERY);
assertFacts("llms.txt addon facts", ADDONS);
assertFacts("llms.txt InferResponse facts", INFER_RESPONSE);

/** Every field the `s.db.query` signature must still list. */
const DB_QUERY_FIELDS = [
  "table", "where", "additionalWhere", "bind", "sort", "paging", "external",
  "returnType", "distinct", "eval", "output", "lock", "addon", "as",
];

describe("s.db.query signature is complete", () => {
  it(`lists all ${DB_QUERY_FIELDS.length} fields`, () => {
    const line = llms.split("\n").find((l) => /`s\.db\.query\(\{\s\w/.test(l));
    expect(line, "no s.db.query signature line").toBeDefined();
    const missing = DB_QUERY_FIELDS.filter((f) => !new RegExp(`\\b${f}\\b`).test(line!));
    expect(missing, `dropped: ${missing.join(", ")}`).toHaveLength(0);
  });
});

/**
 * Re-bloat guard, set from the measured floor. Like the def-shapes section, this
 * one is at its information floor — reshaping buys addressability, not tokens.
 *
 * Raised 5,700 → 5,800 when `s.microservice.request` gained `port?` and a
 * defaulting contract across five fields. That is API growth, not prose
 * creeping back: the entry was cut three times first, and every sentence left
 * changes how the call gets written. Re-measure before raising it again.
 *
 * Raised 6,050 → 6,150 for the `db.query` join-operand rule (#213). The block
 * previously said only "joined columns take a dotted path", which reads as
 * permission to dot BOTH sides of a join condition — the one spelling that does
 * not run, and the reason two apps could not use joins at all. The replacement
 * is two lines: the rule, and a complete working `bind`. Both are load-bearing;
 * the entry was condensed twice before the ceiling moved.
 *
 * Raised 6,150 → 6,250 for `asFilters`, a new option on every statement that
 * binds an `as`. API growth again, and again condensed twice first — what is
 * left is the signature plus the two things a reader gets WRONG by default:
 * that it throws on a statement binding nothing (rather than quietly doing
 * nothing), and that it does not retype the bound variable (the filter changes
 * the runtime value, the declared type does not follow). Drop either and the
 * remaining prose actively misleads. Re-measure before raising it again.
 *
 * Raised 6,250 → 6,350 for `bulk.add`'s `allowIdField` (issue #259) — a silent
 * data-corruption gate that had no entry at all. The engine drops `id` from
 * every row without it and nothing says so, so a reader who is not told writes
 * foreign keys against ids the rows never got. Condensed to one line carrying
 * the default, the `seed` contrast, and the one case that must set it.
 */
const SPECIALS_CEILING = 6_350;

describe("Specials block stays lean", () => {
  it(`is under ${SPECIALS_CEILING.toLocaleString()} tokens`, () => {
    const lines = llms.split("\n");
    const start = lines.findIndex((l) => l.startsWith("### Specials"));
    let end = start + 1;
    while (end < lines.length && !/^### \(top-level\)/.test(lines[end]!)) end++;
    expect(start, "no `### Specials` block").toBeGreaterThan(-1);
    const tokens = measureLlms(lines.slice(start, end).join("\n")).totalTokens;
    expect(tokens).toBeLessThan(SPECIALS_CEILING);
  });
});
