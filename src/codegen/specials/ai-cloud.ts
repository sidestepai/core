/**
 * AI-agent and cloud-job decoders.
 *
 * These four are the flattest family in the catalog: every argument is an
 * `input[]` entry keyed by name, and the only structure is `call_agent`'s target
 * (`context.toolset.id`) and its top-level `runtime` block. What makes them worth
 * hand-writing rather than leaving to `raw()` is that each entry is *optional and
 * order-significant* — the encoder pushes only the arguments that were authored,
 * so a stored entry list is a faithful record of which ones were, and reading it
 * back positionally recovers the original call.
 */
import type { TaggedValue } from "../../types/xdo.js";
import { lit, obj, type Expr } from "../print.js";
import { resolveReference } from "../ref-index.js";
import { decodeValue } from "../value.js";
import { getPath, prove, type SpecialArgs, type SpecialDecoder } from "./prove.js";

/** Coerce a stored `{value, tag, filters}` block to a tagged value. */
function toValue(raw: unknown): TaggedValue | null {
  if (raw === null || typeof raw !== "object") return null;
  const block = raw as { value?: unknown; tag?: unknown; filters?: unknown };
  if (typeof block.tag !== "string" || block.value === undefined) return null;
  return {
    value: block.value as string,
    tag: block.tag as TaggedValue["tag"],
    filters: (Array.isArray(block.filters) ? block.filters : []) as TaggedValue["filters"],
  };
}

/** The stored `input[]` as a name → value map, or null if any entry is malformed. */
function inputMap(a: SpecialArgs): Map<string, TaggedValue> | null {
  const list = Array.isArray(a.stored.input) ? a.stored.input : [];
  const out = new Map<string, TaggedValue>();
  for (const raw of list) {
    const value = toValue(raw);
    const name = (raw as { name?: unknown }).name;
    if (!value || typeof name !== "string") return null;
    out.set(name, value);
  }
  return out;
}

/**
 * Build a decoder for a statement whose whole argument list is `input[]` entries
 * against an empty `context`.
 *
 * `fields` maps a stored entry name to its authoring argument, in the order the
 * encoder pushes them; an entry the map does not mention means this is not the
 * shape we think it is, so the decoder falls through rather than dropping it.
 */
function inputOnly(
  path: string,
  fields: ReadonlyArray<readonly [entry: string, arg: string]>,
): SpecialDecoder {
  return (a) => {
    const values = inputMap(a);
    if (!values) return null;
    const known = new Set(fields.map(([entry]) => entry));
    for (const name of values.keys()) if (!known.has(name)) return null;

    const entries: Array<[string, Expr]> = [];
    const runtime: Record<string, unknown> = {};
    for (const [entry, arg] of fields) {
      const value = values.get(entry);
      if (!value) continue;
      entries.push([arg, decodeValue(a.ctx, value)]);
      runtime[arg] = value;
    }
    const as = (a.stored as { as?: unknown }).as;
    if (typeof as === "string" && as !== "") {
      entries.push(["as", lit(as)]);
      runtime.as = as;
    }
    return prove(a.ctx, a.stored, path, [runtime], [obj(entries)]);
  };
}

/**
 * `ai.agent.run <agent>` — the target rides `context.toolset.id`, the execution
 * mode a top-level `runtime` block, and everything else `input[]`.
 */
const aiAgentRun: SpecialDecoder = (a) => {
  const guid = getPath(a.stored.context, "toolset.id");
  if (typeof guid !== "string" || guid === "") return null;
  const values = inputMap(a);
  if (!values) return null;

  const entries: Array<[string, Expr]> = [
    ["agent", resolveReference(a.ctx, a.refs, guid, { ...a.resolve, unresolved: "object-ref" })],
  ];
  const runtime: Record<string, unknown> = { agent: { name: "", guid } };

  for (const [entry, arg] of [
    ["args", "args"],
    ["allow_tool_execution", "allowToolExecution"],
    ["version", "version"],
  ] as const) {
    const value = values.get(entry);
    if (!value) continue;
    values.delete(entry);
    entries.push([arg, decodeValue(a.ctx, value)]);
    runtime[arg] = value;
  }
  if (values.size > 0) return null;

  // `runtime` is written only when a mode was authored, so its presence — not a
  // comparison against a default — is what carries `runtimeMode` back.
  const mode = getPath(a.stored, "runtime.mode");
  if (typeof mode === "string" && mode !== "") {
    entries.push(["runtimeMode", lit(mode)]);
    runtime.runtimeMode = mode;
  }
  const as = (a.stored as { as?: unknown }).as;
  if (typeof as === "string" && as !== "") {
    entries.push(["as", lit(as)]);
    runtime.as = as;
  }
  return prove(a.ctx, a.stored, "ai.agent.run", [runtime], [obj(entries)]);
};

/** AI-agent and cloud-job decoders by stored name. */
export const AI_CLOUD_DECODERS: ReadonlyMap<string, SpecialDecoder> = new Map<
  string,
  SpecialDecoder
>([
  ["mvp:call_agent", aiAgentRun],
  [
    "mvp:cloud_job",
    inputOnly("cloud.job", [
      ["image", "image"],
      ["command", "command"],
      ["args", "args"],
      ["secret", "secret"],
      ["template", "template"],
      ["await", "await"],
    ]),
  ],
  [
    "mvp:cloud_job_await",
    inputOnly("cloud.job.await", [
      ["ids", "ids"],
      ["timeout", "timeout"],
    ]),
  ],
  ["mvp:cloud_job_status", inputOnly("cloud.job.status", [["id", "id"]])],
]);
