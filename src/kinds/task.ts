/**
 * Task (scheduled/background job) kind (U8) → payload key `task`. Function-like
 * `run[]` plus a `schedule[]` of cron-like entries. Validated against
 * the Xano engine's persisted shape.
 */
import type { StackItemXdo } from "../types/xdo.js";
import { encodeStatement } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";
import { encodeHistory, type HistoryInput } from "./history.js";
import type { MiddlewareBlock } from "./common.js";
import { buildMiddlewareBlock } from "./middleware-attach.js";
import type { MiddlewareAttach } from "./middleware-attach.js";

export interface ScheduleDef {
  startsOn: string;
  /** Repeat frequency in seconds (defaults to 86400 when omitted). */
  freq?: number;
  repeatEnabled?: boolean;
  /** End timestamp; when present, `ends.enabled` defaults to true. */
  endsOn?: string;
  /**
   * Whether the end date applies. Defaults to `endsOn != null`; state it only to
   * represent a stored schedule that REMEMBERS an end date with the gate off —
   * a state the derivation alone cannot spell, and one real tasks are in.
   */
  endsEnabled?: boolean;
}

export interface TaskDef {
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  docs?: string;
  datasource?: string;
  active?: boolean;
  tags?: string[];
  schedule?: ScheduleDef[];
  stack?: Statement[];
  /**
   * Pre/post middleware attachment. Tasks have no API-Group tier — an
   * un-customized phase inherits straight from the workspace. Providing a phase
   * sets its `_customize` flag; `pre: middleware.clear()` overrides with nothing.
   */
  middleware?: MiddlewareAttach;
  /**
   * Request-history capture. Omit to inherit from the workspace (tasks have no
   * container tier). A scalar: `false` off, `true` on at default depth, a number
   * = capture depth, `"all"` unlimited. Any value stops inheriting. See
   * {@link HistoryInput}.
   */
  history?: HistoryInput;
}

export interface ScheduleXdo {
  starts_on: string;
  repeat: { enabled: boolean; ends: { enabled: boolean; on: string }; freq: number };
}

export interface TaskXdo {
  name: string;
  description: string;
  docs: string;
  datasource: string;
  active: boolean;
  middleware: MiddlewareBlock;
  tag: Array<{ tag: string }>;
  history: { inherit: boolean; enabled: boolean; limit: number };
  run: StackItemXdo[];
  schedule: ScheduleXdo[];
}

export function encodeSchedule(def: ScheduleDef): ScheduleXdo {
  return {
    starts_on: def.startsOn,
    repeat: {
      enabled: def.repeatEnabled ?? def.freq != null,
      ends: { enabled: def.endsEnabled ?? def.endsOn != null, on: def.endsOn ?? def.startsOn },
      freq: def.freq ?? 86400,
    },
  };
}

export function encodeTask(def: TaskDef): TaskXdo {
  if (!def.name) throw new Error("task: `name` is required.");
  return {
    name: def.name,
    description: def.description ?? "",
    docs: def.docs ?? "",
    datasource: def.datasource ?? "",
    active: def.active ?? false,
    middleware: buildMiddlewareBlock(def.middleware),
    tag: encodeTags(def.tags),
    history: encodeHistory("task", def.history),
    run: (def.stack ?? []).map(encodeStatement),
    schedule: (def.schedule ?? []).map(encodeSchedule),
  };
}

export const taskKind: ObjectKind<TaskDef, TaskXdo> = {
  name: "task",
  payloadKey: "task",
  encode: encodeTask,
};
registerKind(taskKind);

export function task(def: TaskDef): TaskDef {
  return def;
}
