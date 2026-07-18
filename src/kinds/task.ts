/**
 * Task (scheduled/background job) kind (U8) → payload key `task`. Function-like
 * `run[]` plus a `schedule[]` of cron-like entries. Validated against
 * `cloud-client: …/transform-temp/schema:task.json`.
 */
import type { StackItemXdo } from "../types/xdo.js";
import { encodeStatement } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { emptyMiddleware, encodeTags, defaultHistory } from "./common.js";
import type { MiddlewareBlock } from "./common.js";

export interface ScheduleDef {
  startsOn: string;
  /** Repeat frequency in seconds (defaults to 86400 when omitted). */
  freq?: number;
  repeatEnabled?: boolean;
  /** End timestamp; when present, `ends.enabled` is true. */
  endsOn?: string;
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
      ends: { enabled: def.endsOn != null, on: def.endsOn ?? def.startsOn },
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
    middleware: emptyMiddleware(),
    tag: encodeTags(def.tags),
    history: defaultHistory("task"),
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
