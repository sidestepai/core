/**
 * `s` — the unified, discoverable statement authoring surface.
 *
 * Merges the codegen'd namespace (every declarative statement, reachable as
 * `s.<namespace>.<method>({…})` — e.g. `s.math.add`, `s.array.find`, `s.db.get`)
 * with the hand-authored control-flow / terminal specials that the codegen
 * defers (`!class`/`!function`). This is the one place to look for "what
 * statements can I author": tab-complete `s.` and explore.
 *
 * The generated factories take a single typed args object; the specials keep
 * their authored signatures. Both return a `Statement` ready for a function /
 * query / trigger `stack`.
 */
import "./generated/catalog.js"; // side-effect: registers every generated spec on the statement registry
import { generated } from "./generated/factories.generated.js";
import { setVar, updateVar } from "./set-var.js";
import { conditional } from "./conditional.js";
import { forLoop, foreachLoop, whileLoop, group } from "./special/loops.js";
import { switchStatement, tryCatch } from "./special/branch.js";
import {
  functionRun,
  functionCall,
  apiCall,
  taskCall,
  toolCall,
  triggerCall,
  middlewareCall,
  addonCall,
  actionCall,
  actionPackageCall,
  serviceFunctionRun,
  workflowTestCall,
} from "./special/calls.js";
import {
  dbAdd,
  dbEdit,
  dbAddOrEdit,
  dbGet,
  dbDel,
  dbHas,
  dbPatch,
  dbTruncate,
  dbSchema,
  dbDirectQuery,
  dbBulkAdd,
  dbBulkDelete,
  dbBulkPatch,
  dbBulkUpdate,
  dbQuery,
  dbTransaction,
  dbExternalQuery,
} from "./special/db.js";
import { aiAgentRun, cloudJob, cloudJobAwait, cloudJobStatus } from "./special/ai-cloud.js";
import {
  arrayMap,
  arrayUnion,
  comment,
  placeholder,
  getRawInput,
  postProcess,
  realtimeEvent,
  createAuthToken,
  expectToThrow,
} from "./special/misc.js";
import { precondition, throwError } from "./special/precondition.js";
import type { ExternalSqlEngine } from "./special/db.js";
import {
  returnValue,
  foreachBreak,
  foreachContinue,
  foreachRemove,
} from "./special/control-flow.js";

/** A `db.external.<engine>.direct_query` factory bound to one engine. */
const externalQuery = (engine: ExternalSqlEngine) => ({
  direct_query: (a: Omit<Parameters<typeof dbExternalQuery>[0], "engine">) =>
    dbExternalQuery({ ...a, engine }),
});

// `cloud.job` is both a statement and the namespace for its await/status ops.
const cloudJobNs = Object.assign(cloudJob, { await: cloudJobAwait, status: cloudJobStatus });

export const s = {
  ...generated,
  // Typed overrides of generated factories: `precondition` narrows `error_type`
  // to the status-bearing enum, and `throw` documents that it returns HTTP 200
  // (use `precondition` for a status-observable rejection). See issue #21.
  precondition,
  throw: throwError,
  // Hand-authored specials (not in the codegen'd catalog).
  set_var: setVar,
  update_var: updateVar,
  conditional,
  comment,
  placeholder,
  for: forLoop,
  foreach: foreachLoop,
  while: whileLoop,
  group,
  switch: switchStatement,
  try_catch: tryCatch,
  return: returnValue,
  foreach_break: foreachBreak,
  foreach_continue: foreachContinue,
  foreach_remove: foreachRemove,
  // Call family — invoke another workspace object. `api.call`/`api.realtime_event`
  // merge into the generated `api` namespace; the rest are new namespaces.
  function: { run: functionRun, call: functionCall },
  service: { function: { run: serviceFunctionRun } },
  action: { call: actionCall, package: { call: actionPackageCall } },
  workflow_test: { call: workflowTestCall },
  api: { ...generated.api, call: apiCall, realtime_event: realtimeEvent },
  task: { call: taskCall },
  tool: { call: toolCall },
  trigger: { call: triggerCall },
  middleware: { call: middlewareCall },
  addon: { call: addonCall },
  // Database family — merges into the generated `db` namespace.
  db: {
    ...generated.db,
    add: dbAdd,
    edit: dbEdit,
    add_or_edit: dbAddOrEdit,
    get: dbGet,
    del: dbDel,
    has: dbHas,
    patch: dbPatch,
    truncate: dbTruncate,
    schema: dbSchema,
    direct_query: dbDirectQuery,
    query: dbQuery,
    transaction: dbTransaction,
    bulk: { add: dbBulkAdd, delete: dbBulkDelete, patch: dbBulkPatch, update: dbBulkUpdate },
    external: {
      mssql: externalQuery("mssql"),
      mysql: externalQuery("mysql"),
      oracle: externalQuery("oracle"),
      postgres: externalQuery("postgres"),
      snowflake: externalQuery("snowflake"),
    },
  },
  // AI agent + cloud jobs.
  ai: { ...generated.ai, agent: { run: aiAgentRun } },
  cloud: { ...generated.cloud, job: cloudJobNs },
  // Array map/union, expect.to_throw, auth-token, raw-input/post-process merge
  // into their generated namespaces.
  array: { ...generated.array, map: arrayMap, union: arrayUnion },
  expect: { ...generated.expect, to_throw: expectToThrow },
  security: { ...generated.security, create_auth_token: createAuthToken },
  util: { ...generated.util, get_raw_input: getRawInput, get_input: getRawInput, post_process: postProcess },
} as const;
