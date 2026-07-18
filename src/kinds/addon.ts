/**
 * Addon kind (U8) → payload key `addon`. A lightweight composable function
 * (input + stack) with an `output` selection block and an optional `context`
 * (e.g. a db binding). The MVP models the common shape; rich db-bound contexts
 * pass through verbatim. Validated against `cloud-client: dbo/mvp/addon.yaml`.
 */
import type { StackItemXdo, InputXdo } from "../types/xdo.js";
import { encodeStatement } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { encodeInput } from "../inputs/input.js";
import type { InputDescriptor } from "../inputs/input.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";

export interface AddonDef {
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  tags?: string[];
  input?: Record<string, InputDescriptor>;
  stack?: Statement[];
  /** Optional binding context (e.g. `{ dbo: { id, as } }`); passed through. */
  context?: Record<string, unknown>;
  /** Output selection block. */
  output?: { customize?: boolean; items?: unknown[] };
}

export interface AddonXdo {
  name: string;
  description: string;
  context: Record<string, unknown>;
  output: { customize: boolean; items: unknown[] };
  tag: Array<{ tag: string }>;
  input: InputXdo[];
  run: StackItemXdo[];
}

export function encodeAddon(def: AddonDef): AddonXdo {
  if (!def.name) throw new Error("addon: `name` is required.");
  return {
    name: def.name,
    description: def.description ?? "",
    context: def.context ?? {},
    output: { customize: def.output?.customize ?? false, items: def.output?.items ?? [] },
    tag: encodeTags(def.tags),
    input: Object.entries(def.input ?? {}).map(([name, d]) => encodeInput(name, d)),
    run: (def.stack ?? []).map(encodeStatement),
  };
}

export const addonKind: ObjectKind<AddonDef, AddonXdo> = {
  name: "addon",
  payloadKey: "addon",
  encode: encodeAddon,
};
registerKind(addonKind);

export function addon(def: AddonDef): AddonDef {
  return def;
}
