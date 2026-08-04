import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { measureLlms } from "../../scripts/measure-llms.js";

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

/** All patterns must match somewhere in the doc for the fact to count as present. */
type Fact = { name: string; needs: RegExp[] };

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
    name: "gating actions fail OPEN on a crash (a broken stack admits)",
    needs: [/\bCRASH\b/i, /fail(s)? OPEN/i, /\bADMITS?\b/i],
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
const DEF_SHAPES_CEILING = 7_400;

describe("object def shapes section stays lean", () => {
  it(`is under ${DEF_SHAPES_CEILING.toLocaleString()} tokens`, () => {
    const m = measureLlms(llms);
    const section = m.sections.find((s) => s.title === "Object def shapes");
    expect(section, "no `## Object def shapes` section").toBeDefined();
    expect(section!.tokens).toBeLessThan(DEF_SHAPES_CEILING);
  });
});
