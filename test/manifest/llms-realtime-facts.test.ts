import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { measureLlms } from "../../scripts/measure-llms.js";
import { claimHash, evidenceProblems } from "./helpers/claims.js";
import type { Evidence, VerifiedFact } from "./helpers/claims.js";

/**
 * Fact inventory for the realtime + object-def-shape grounding in `llms.txt`.
 *
 * Written BEFORE the reshape that compressed those blocks, and that ordering is the
 * point: the reshape's contract is "identical constraint set, fewer words", which is
 * only verifiable if the constraint set was pinned first. Every assertion here maps
 * to a constraint that existed in the pre-reshape prose.
 *
 * Assertions key on the distinctive TOKENS of a fact (`at_least_once`, `4401`,
 * `presence_full`), not on sentence structure, so a legitimate rewording passes and
 * a dropped fact fails. When a fact genuinely changes, update the assertion in the
 * same commit as the prose — never delete one to make a reshape land.
 *
 * The silent-failure facts are the load-bearing half: each is a behavior that
 * produces no error, appears in no type signature, and cannot be inferred from the
 * option name. They are exactly what this doc exists to carry.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const llms = readFileSync(join(ROOT, "llms.txt"), "utf8");

/**
 * All patterns must match somewhere in the doc for the fact to count as present.
 *
 * `evidence` records what ESTABLISHED the claim, and is bound to the claim's
 * exact wording by a hash — see `helpers/claims.ts` for why presence alone was
 * not enough. It is optional only because most of this inventory predates the
 * mechanism; the roster below ratchets coverage upward so it cannot quietly
 * shrink.
 */
type Fact = { name: string; needs: RegExp[]; evidence?: Evidence };

const SILENT_FAILURES: Fact[] = [
  {
    name: "conversation.limit defaults to 0 and 0 means OFF (enabled alone is a no-op)",
    needs: [/\bconversation\b/, /\blimit\b/, /\b0\b[^.]{0,80}\b(OFF|RETAIN NONE)\b/i],
  },
  {
    name: "at_least_once needs a durable options.client_id from anonymous clients, else degrades",
    needs: [/at_least_once/, /options\.client_id/, /at_most_once/, /\banonymous\b/i],
  },
  {
    name: "a deliver trigger drops only on explicit null — false/0/\"\" deliver",
    needs: [/\bdeliver\b/, /\bNULL\b/, /\bfalse\b/, /DELIVERS IT UNCHANGED|delivers it unchanged/i],
  },
  {
    name: "a gating trigger with no response refuses every client",
    needs: [/\bgat(e|ing)\b/i, /\bNO `?response`?\b/i, /\b(DENIES|refuses)\b/i],
  },
  {
    // This entry asserted the OPPOSITE until 2026-08-10, and it is the exact
    // drift U18 exists to catch: a live-behavioral claim with a test that only
    // checked the text was PRESENT, never that it was true. The transport seeds
    // a deny before running a gate stack and keeps it on a throw — both
    // connect and join. Verified against the engine's own gate code, whose
    // comment reads "a join gate that cannot answer must NOT admit".
    name: "a gating action DENIES on a crash (the gate is seeded with a deny)",
    needs: [/\bCRASH\b/i, /\bDENIES\b/i],
    evidence: {
      kind: "engine-source",
      checked: "2026-08-11",
      note: "read both gate paths: each seeds a deny decision before running the stack and keeps it in the catch; the connect path additionally sends an error frame and closes 4401",
      claim: "cc26b026",
    },
  },
  {
    name: "gating is OPT-IN — no trigger means no gate at all",
    needs: [/OPT-IN/i, /no `?connect`? trigger/i],
    evidence: {
      kind: "engine-source",
      checked: "2026-08-11",
      note: "the gate block runs only when the object declares the action; with none declared the transport joins/connects without consulting a stack",
      claim: "36470fa1",
    },
  },
  {
    name: "join/leave bind the channel's path params, so inp() resolves there",
    needs: [/bind the channel's typed path params|binds? the channel's typed path params/i, /inp\(/],
    evidence: {
      kind: "engine-source",
      checked: "2026-08-11",
      note: "both lifecycle paths merge the resolved path params into the trigger event so the stack reads them as inputs; a server-scoped connect has no channel and so no params",
      claim: "1d8a532c",
    },
  },
  {
    name: "a message handler that crashes broadcasts the original unvalidated payload",
    needs: [/CRASHES|crashes/, /UNVALIDATED|unvalidated/, /\bbroadcast/i],
  },
  {
    name: "deliverTo: explicit still delivers to nobody",
    needs: [/"explicit"/, /\bNOBODY\b/i],
  },
  {
    name: "s.realtime.publish is delivery-only, bypasses publish.who, and is fail-soft",
    needs: [/s\.realtime\.publish/, /DELIVERY-ONLY|delivery-only/i, /publish\.who/, /FAIL-SOFT|fail-soft/i],
  },
  {
    name: "an idle socket is reaped, so a listen-only client must ping",
    needs: [/\bREAPED\b|\breaped\b/, /10 minutes/, /"ping"/, /LISTEN-ONLY|listen-only/i],
  },
  {
    name: "realtimeServer.enabled defaults to false",
    needs: [/realtimeServer\(/, /`enabled`[^.]{0,60}\*\*false\*\*|`enabled` defaults to \*\*false\*\*/],
  },
  {
    name: "every {param} needs a matching input or the factory throws",
    needs: [/\{param\}/, /\bMUST have a matching input\b/i, /THROWS?\b/i],
  },
];

const SHAPES: Fact[] = [
  {
    name: "presence_full carries an ARRAY of members; presence_join/leave carry one member",
    needs: [/presence_full/, /payload\.members/, /presence_join/, /presence_leave/, /payload\.member\b/],
  },
  {
    name: "a presence member entry shape",
    needs: [/\bid\b/, /dbo_id/, /authenticated/, /extras/, /joined_at/],
  },
  {
    name: "tenant socket form glues tenant to canonical; HTTP form gives it its own segment",
    needs: [/<tenant>:<canonical>/, /\/tenant\/<tenant>\/api:<canonical>/],
  },
  {
    name: "getUrl translates a tenant base URL rather than concatenating",
    needs: [/getUrl/, /TRANSLATES|translates/, /LIFTED|lifted/],
  },
  {
    name: "a refused connect trigger closes the socket with code 4401",
    needs: [/4401/, /connect/i],
  },
  {
    name: "get_session is FLAT with the documented fields",
    needs: [/get_session/, /client_id/, /socket_id/, /dbo_id/, /opened_at/, /\bparams\b/],
  },
  {
    name: "three unrelated things are called a client id",
    needs: [/session\.client_id/, /session\.socket_id/, /options\.client_id/],
  },
  {
    name: "a channel path param is bound at join and read from the connection, not the frame",
    needs: [/bound ONCE at join|bound once at join/i, /never from the frame|not from the frame/i],
  },
  {
    name: "only channel/others fan out AND are recorded in the transcript",
    needs: [/"channel"/, /"others"/, /"sender"/, /RECORDED|recorded/],
  },
  {
    name: "anonymousClients is gated twice — server admits, then channel admits",
    needs: [/anonymousClients/, /TWICE|twice/i],
  },
  {
    name: "perRecipient is a no-op without a deliver trigger and costs a stack per recipient",
    needs: [/perRecipient/, /NO-OP|no-op/i, /PER RECIPIENT|per recipient/i],
  },
  {
    name: "rateLimit is a cost guardrail, not a security control, and fails open",
    needs: [/rateLimit/, /guardrail/i, /fails? OPEN/i],
  },
];

/**
 * Every field each realtime factory's signature must still list. Hard-coded rather
 * than derived because a TS argument type erases at runtime — this list IS the
 * checklist, and a field dropped from the doc to shorten a line fails here. The SDK
 * side is covered separately by `manifest.test.ts` and `tsc --noEmit`.
 */
const FACTORY_FIELDS: Record<string, string[]> = {
  "realtimeServer": ["name", "guid", "description", "enabled", "canonical", "tags", "history"],
  "realtimeChannel": [
    "name", "server", "guid", "description", "active", "input", "anonymousClients",
    "presence", "publish", "conversation", "delivery", "rateLimit", "tags", "history",
  ],
  "realtimeMessage": [
    "name", "channel", "server", "guid", "description", "active", "auth", "deliverTo",
    "input", "middleware", "stack", "response", "history", "disabled", "tags",
  ],
  "realtimeServerTrigger": ["name", "realtimeServer", "actions", "stack", "response"],
  "realtimeChannelTrigger": ["name", "channel", "actions", "stack", "response"],
  "agent": ["name", "guid", "description", "docs", "enabled", "canonical", "tags", "history", "llm", "tools", "output"],
  "mcpServer": [
    "name", "guid", "description", "instructions", "docs", "enabled", "canonical",
    "spec", "tags", "history", "tools", "llm", "output",
  ],
  "query": [
    "name", "verb", "apiGroup", "guid", "auth", "input", "stack", "response",
    "responseType", "apiEnabled", "disabled", "cache", "description", "docs",
  ],
};

/**
 * The signature line for a factory: the first line declaring `factory({ <field>…`.
 * The trailing `\s\w` matters — prose mentions the factories in elided form
 * (`` `agent({...})` ``), and matching one of those would compare the field list
 * against a sentence and report every field as dropped.
 */
function signatureOf(factory: string): string {
  const line = llms
    .split("\n")
    .find((l) => new RegExp("`" + factory + "\\(\\{\\s\\w").test(l));
  expect(line, `no signature line found for ${factory}()`).toBeDefined();
  return line!;
}

describe("llms.txt realtime silent-failure facts", () => {
  for (const { name, needs } of SILENT_FAILURES) {
    it(name, () => {
      const missing = needs.filter((re) => !re.test(llms)).map(String);
      expect(missing, `missing from llms.txt: ${missing.join(", ")}`).toHaveLength(0);
    });
  }
});

describe("llms.txt realtime shape facts", () => {
  for (const { name, needs } of SHAPES) {
    it(name, () => {
      const missing = needs.filter((re) => !re.test(llms)).map(String);
      expect(missing, `missing from llms.txt: ${missing.join(", ")}`).toHaveLength(0);
    });
  }
});

describe("def-shape signatures list every field", () => {
  for (const [factory, fields] of Object.entries(FACTORY_FIELDS)) {
    it(`${factory}() lists all ${fields.length} fields`, () => {
      const sig = signatureOf(factory);
      const missing = fields.filter((f) => !new RegExp(`\\b${f}\\b`).test(sig));
      expect(missing, `${factory}() signature dropped: ${missing.join(", ")}`).toHaveLength(0);
    });
  }
});

/**
 * Section ceiling, set from the measured floor rather than from an estimate.
 *
 * The reshape that split this section into one-fact-per-line form was projected to
 * take it to ~4,600 tokens. It did not, and the measurement is worth recording
 * because it generalizes: the realtime block went 3,430 → ~3,300 while going from
 * 13 lines to 72. Splitting dense prose into bullets is roughly TOKEN-NEUTRAL — the
 * ~210 tokens of `- ` prefixes cost about what the removed connective prose saved.
 *
 * What the reshape bought is addressability: an agent can now retrieve one
 * constraint without reading 800 words. What it cannot buy is compression, because
 * this section was never padded. It carries ~110 discrete realtime constraints plus
 * eight factory signatures at roughly 30 tokens each — that product IS the section,
 * and the only way under it is to delete grounding, which R3 forbids.
 *
 * So this ceiling guards against RE-BLOATING, not toward a target. Same rule as the
 * budget tripwire: if a legitimate new constraint pushes past it, raise it — never
 * cut grounding to fit. Ratchet it down after a real reduction.
 */
// Raised 7,400 → 7,500 when `workflowTest` landed: a ninth factory signature plus
// its datasource-clone constraint, which is the kind's one real trap. Exactly the
// "legitimate new constraint" case above — the entry was already compressed from
// 128 tokens over to 13 before raising.
//
// Raised 7,650 → 7,800 for the stored-name charset (#227). A name outside
// `A-Za-z0-9_-/{}` is not rejected by Xano — it saves the object with an EMPTY
// name, which deploys clean and then 404s forever, reported nowhere. That is
// unguessable and silent, so it is grounding the model cannot do without; it also
// covers `realtimeChannel`/`tool`/`realtimeMessage` in one clause. Compressed
// twice before raising (~150 tokens over → 92).
const DEF_SHAPES_CEILING = 7_800;

describe("object def shapes section stays lean", () => {
  it(`is under ${DEF_SHAPES_CEILING.toLocaleString()} tokens`, () => {
    const m = measureLlms(llms);
    const section = m.sections.find((s) => s.title === "Object def shapes");
    expect(section, "no `## Object def shapes` section").toBeDefined();
    expect(section!.tokens).toBeLessThan(DEF_SHAPES_CEILING);
  });
});

/**
 * U18 — the claim guard.
 *
 * Not "does a live-behavioral claim have a test": the fail-open claim above HAD
 * one, passed for two weeks, and was false the whole time, because the test
 * checked the sentence was PRESENT. What this enforces instead is that a fact
 * carrying evidence stays bound to the wording that evidence was gathered for —
 * reword it and the hash moves, which fails until someone re-verifies.
 *
 * Evidence is optional because most of this inventory predates the mechanism.
 * The roster below is a RATCHET: it names every fact that carries evidence, so
 * coverage can only grow, and dropping one is a visible edit rather than a
 * silent regression.
 */
describe("documented claims carry their evidence", () => {
  const all: Fact[] = [...SILENT_FAILURES, ...SHAPES];

  /** Facts whose evidence has been gathered. Add to this list; never shorten it. */
  const EVIDENCED = [
    "a gating action DENIES on a crash (the gate is seeded with a deny)",
    "gating is OPT-IN — no trigger means no gate at all",
    "join/leave bind the channel's path params, so inp() resolves there",
  ];

  it("keeps every evidenced fact bound to the wording it was verified for", () => {
    const problems = all
      .filter((f) => f.evidence !== undefined)
      .flatMap((f) => evidenceProblems(f as VerifiedFact));
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("ratchets coverage — an evidenced fact never silently loses its evidence", () => {
    const carrying = all.filter((f) => f.evidence !== undefined).map((f) => f.name).sort();
    for (const name of EVIDENCED) {
      expect(carrying, `"${name}" lost its evidence — re-verify rather than deleting`).toContain(
        name,
      );
    }
  });

  it("names an evidenced fact in the roster, so the list cannot drift", () => {
    // The other direction: evidence added without registering it here would not
    // be protected by the ratchet above.
    for (const f of all) {
      if (f.evidence === undefined) continue;
      expect(EVIDENCED, `"${f.name}" carries evidence but is missing from EVIDENCED`).toContain(
        f.name,
      );
    }
  });

  it("reports the hash a fact's evidence must carry", () => {
    // Not an assertion so much as the tool: when a claim changes, this is where
    // the new hash comes from, and re-running it is the prompt to re-verify.
    for (const f of all.filter((x) => x.evidence !== undefined)) {
      expect(claimHash(f)).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});
