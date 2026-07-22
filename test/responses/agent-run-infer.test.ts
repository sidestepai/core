import { describe, it, expect, expectTypeOf } from "vitest";
import { query } from "../../src/kinds/query.js";
import { apiGroup } from "../../src/kinds/api-group.js";
import { s } from "../../src/statements/s.js";
import { ref, inp, obj } from "../../src/index.js";
import type { InferResponse } from "../../src/responses/infer.js";
import type { AgentRunResult } from "../../src/index.js";

/**
 * `s.ai.agent.run` result typing (#89). The special is now branded with
 * `AsShapeBrand<As, AgentRunResult<R>>`, so `ref(as)` traces to the typed
 * envelope instead of `unknown` — and the completion is visibly at `.result`.
 * Compile-time assertions (validated by `tsc`, which includes `test/`).
 */

const api = apiGroup({ name: "ai", canonical: "abc123" });

// Whole-envelope response: derivation is now the typed AgentRunResult, not unknown.
const askEnvelope = query({
  verb: "POST",
  apiGroup: api,
  name: "ask_envelope",
  stack: [s.ai.agent.run({ agent: "assistant", args: obj({ q: inp("q") }), as: "answer" })],
  response: ref("answer"),
});

// Object-literal response wrapping the ref: the whole envelope lands under `text`
// — this is exactly the bug #89 flags (the metadata blob shipped as the answer),
// now visible in the derived type instead of hidden behind `unknown`.
const askWrapped = query({
  verb: "POST",
  apiGroup: api,
  name: "ask_wrapped",
  stack: [s.ai.agent.run({ agent: "assistant", as: "answer" })],
  response: { text: ref("answer") },
});

// Structured-output agent: `resultShape` narrows `.result` to the object type.
const askStructured = query({
  verb: "POST",
  apiGroup: api,
  name: "ask_structured",
  stack: [s.ai.agent.run({ agent: "classifier", as: "answer", resultShape: {} as { sentiment: string } })],
  response: ref("answer"),
});

// Dotted ref: projects the `.result` completion out of the traced envelope (#93)
// — `string` by default, so `responseShape` is no longer needed for the common
// "return just the completion" case.
const askDotted = query({
  verb: "POST",
  apiGroup: api,
  name: "ask_dotted",
  stack: [s.ai.agent.run({ agent: "assistant", as: "answer" })],
  response: ref("answer.result"),
});

// Dotted ref against a structured-output agent: `.result` narrows to the object.
const askDottedStructured = query({
  verb: "POST",
  apiGroup: api,
  name: "ask_dotted_structured",
  stack: [s.ai.agent.run({ agent: "classifier", as: "answer", resultShape: {} as { sentiment: string } })],
  response: ref("answer.result"),
});

// Dotted ref wrapped in an object literal — the endgame the issue describes:
// `{ text: ref("answer.result") }` now types `text` to the completion.
const askDottedWrapped = query({
  verb: "POST",
  apiGroup: api,
  name: "ask_dotted_wrapped",
  stack: [s.ai.agent.run({ agent: "assistant", as: "answer" })],
  response: { text: ref("answer.result") },
});

// A dotted ref whose head names no bound variable stays `unknown` (honest floor).
const askDottedUntraceable = query({
  verb: "POST",
  apiGroup: api,
  name: "ask_dotted_untraceable",
  stack: [s.ai.agent.run({ agent: "assistant", as: "answer" })],
  response: ref("missing.result"),
});

describe("InferResponse — s.ai.agent.run brand (#89, type-level)", () => {
  it("fixtures construct (runtime touch)", () => {
    const names = [
      askEnvelope.name,
      askWrapped.name,
      askStructured.name,
      askDotted.name,
      askDottedStructured.name,
      askDottedWrapped.name,
      askDottedUntraceable.name,
    ];
    expect(names.every((n) => n.length > 0)).toBe(true);
  });

  it("ref(as) traces to the typed AgentRunResult<string> envelope (not unknown)", () => {
    expectTypeOf<InferResponse<typeof askEnvelope>>().toEqualTypeOf<AgentRunResult<string>>();
  });

  it("the completion is at .result and is a string by default", () => {
    expectTypeOf<InferResponse<typeof askEnvelope>["result"]>().toEqualTypeOf<string>();
  });

  it("object-literal response derives { text: AgentRunResult } — the wrong-shape bug is now visible", () => {
    expectTypeOf<InferResponse<typeof askWrapped>>().toEqualTypeOf<{ text: AgentRunResult<string> }>();
  });

  it("resultShape narrows .result to the structured object type", () => {
    expectTypeOf<InferResponse<typeof askStructured>>().toEqualTypeOf<AgentRunResult<{ sentiment: string }>>();
    expectTypeOf<InferResponse<typeof askStructured>["result"]>().toEqualTypeOf<{ sentiment: string }>();
  });

  it("a dotted ref projects the completion: ref('answer.result') → string (#93)", () => {
    expectTypeOf<InferResponse<typeof askDotted>>().toEqualTypeOf<string>();
  });

  it("a dotted ref narrows to the structured .result type", () => {
    expectTypeOf<InferResponse<typeof askDottedStructured>>().toEqualTypeOf<{ sentiment: string }>();
  });

  it("a dotted ref inside an object literal resolves that key to the completion", () => {
    expectTypeOf<InferResponse<typeof askDottedWrapped>>().toEqualTypeOf<{ text: string }>();
  });

  it("a dotted ref whose head names no binding stays unknown (honest floor)", () => {
    expectTypeOf<InferResponse<typeof askDottedUntraceable>>().toEqualTypeOf<unknown>();
  });
});
