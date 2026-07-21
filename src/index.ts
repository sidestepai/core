/**
 * sidestep — author an entire Xano workspace in TypeScript and compile it to the
 * importable `packageExport` JSON bundle.
 *
 * Start here (declarative def-objects, NOT a callback/chaining builder):
 *
 * ```ts
 * import { workspace, table, query, input, f, c, inp, ref } from "@sidestep/core";
 *
 * const users = table({ name: "users", schema: { email: f.email({ required: true }) } });
 *
 * const listUsers = query({
 *   name: "list_users", verb: "GET", apiGroup: api,
 *   stack: [dbQuery({ table: users, as: "rows" })],
 *   response: ref("rows"),
 * });
 *
 * export default workspace("my-app")        // a `new Xano()` with the name set
 *   .registerTables([users])
 *   .registerQueries([listUsers]);          // `sidestep export ./index.ts` reads the default export
 * ```
 *
 * - Tables/inputs are typed catalogs: `f.<type>(opts)` for columns,
 *   `input.<type>(opts)` for endpoint inputs. A foreign key is `f.tableRef(table)`.
 * - Statements live under one discoverable namespace, `s.<ns>.<method>({...})`
 *   (e.g. `s.math.add`, `s.db.get`); the flat factories (`dbQuery`, `dbAdd`, …)
 *   are exported too.
 * - Bind data with the right helper: `c.*` constant, `ref` stack var, `inp`
 *   input, `col` table column, `auth("id")` the caller. (`ref` ≠ `tableRef`.)
 * - `manifest.json` / `llms.txt` (shipped) describe the whole surface for agents.
 *
 * See the README and `llms.txt` for the full tour.
 */

// Authoring
export { defineFunction } from "./function/define.js";
export type { FunctionDef, ResponseDef } from "./function/define.js";
export { input } from "./inputs/input.js";
export type { InputOptions, InputDescriptor } from "./inputs/input.js";
// Consumer contract: derive a query's request-payload type from its declared
// inputs (no codegen) — `InferInput<typeof myQuery>`. The read-side counterpart
// is `InferRow<typeof myTable>` (exported with the table kind below).
export type { InferInput } from "./inputs/infer.js";
// Consumer contract: derive a query/function's response type from its declared
// `responseShape` (override) or its `response`/`stack` (auto-derivation) — the
// read-side round-trip counterpart of `InferInput`.
export type { InferResponse } from "./responses/infer.js";
export type {
  TypeBrand,
  BrandValue,
  BrandOpts,
  ValueOf,
  FromFieldMap,
  RowFromFieldMap,
  XanoFileRef,
  XanoGeoJson,
} from "./fields/value-types.js";
export { f, toNestedFields } from "./fields/catalog.js";
export type { FieldDescriptor, FieldMap, FieldOpts, MethodOpts } from "./fields/catalog.js";
export type {
  MethodSpec,
  MethodArg,
  FieldAccess,
  TextFormat,
  FieldStyleType,
} from "./fields/field.js";
export { FIELD_METHODS } from "./fields/generated/field-methods.generated.js";
export type {
  TextMethod,
  IntMethod,
  DecimalMethod,
  EmailMethod,
  PasswordMethod,
  VectorMethod,
  TableRefMethod,
} from "./fields/generated/field-methods.generated.js";
export { c, ref, inp, col, auth, env, setting, out, filter, withFilters } from "./values/value.js";
export type { Value, RefValue, FilteredValue } from "./values/value.js";
export { fl, FILTER_NAMES } from "./values/generated/filters.generated.js";
export { setVar, updateVar } from "./statements/set-var.js";
export { conditional, expr } from "./statements/conditional.js";
export type { Comparison } from "./statements/conditional.js";
export { cmp, and, or } from "./statements/special/db-search.js";
export type {
  SearchOp,
  SearchComparison,
  SearchGroup,
  SearchNode,
} from "./statements/special/db-search.js";
export type { Statement } from "./statements/statement.js";

// Hand-authored control-flow / terminal specials (U10)
export {
  returnValue,
  die,
  debugLog,
  foreachBreak,
  foreachContinue,
  foreachRemove,
} from "./statements/special/control-flow.js";
export { forLoop, foreachLoop, whileLoop, group } from "./statements/special/loops.js";
export type { ForArgs, ForeachArgs, WhileArgs } from "./statements/special/loops.js";
export { switchStatement, switchCase, tryCatch } from "./statements/special/branch.js";
export type { SwitchArgs, SwitchCaseArgs, TryCatchArgs } from "./statements/special/branch.js";
export {
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
} from "./statements/special/calls.js";
export type {
  FunctionRunArgs,
  FunctionCallArgs,
  ApiCallArgs,
  TaskCallArgs,
  ToolCallArgs,
  TriggerCallArgs,
  MiddlewareCallArgs,
  AddonCallArgs,
  ActionCallArgs,
  ServiceFunctionRunArgs,
  WorkflowTestCallArgs,
} from "./statements/special/calls.js";
export {
  aiAgentRun,
  cloudJob,
  cloudJobAwait,
  cloudJobStatus,
} from "./statements/special/ai-cloud.js";
export type {
  AiAgentRunArgs,
  CloudJobArgs,
  CloudJobAwaitArgs,
  CloudJobStatusArgs,
} from "./statements/special/ai-cloud.js";
export {
  arrayMap,
  arrayUnion,
  comment,
  placeholder,
  getRawInput,
  postProcess,
  realtimeEvent,
  createAuthToken,
  expectToThrow,
} from "./statements/special/misc.js";
export type {
  ArrayMapArgs,
  GetRawInputArgs,
  RealtimeEventArgs,
  CreateAuthTokenArgs,
  ExpectToThrowArgs,
} from "./statements/special/misc.js";
export {
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
} from "./statements/special/db.js";
export type {
  DbField,
  DbAddArgs,
  DbEditArgs,
  DbAddOrEditArgs,
  DbDirectQueryArgs,
  DbGetArgs,
  DbDelArgs,
  DbHasArgs,
  DbPatchArgs,
  DbTruncateArgs,
  DbSchemaArgs,
  DbBulkAddArgs,
  DbBulkDeleteArgs,
  DbBulkWriteArgs,
  DbQueryArgs,
  DbReturnType,
  DbDistinct,
  DbEval,
  DbEvalFilter,
  DbExternal,
  DbExternalPermissions,
  DbWhere,
  DbTransactionArgs,
  DbExternalQueryArgs,
  ExternalSqlEngine,
  DbResponseType,
  SortDir,
  SortDirective,
  DbPaging,
} from "./statements/special/db.js";
export type { AddonSpec } from "./statements/special/addon-encode.js";
export { deriveGuid, resolveRef, REFERENCEABLE_KINDS } from "./refs/guid.js";
export type { ObjectRef } from "./refs/guid.js";

// Unified statement authoring surface — the discoverable `s.<namespace>.<method>`
// catalog (all 150+ declarative statements) merged with the control-flow specials.
export { s } from "./statements/s.js";

// Statement registry escape hatch — invoke any registered statement by name with
// a raw authored record (for statements without a typed factory yet).
export {
  encodeStatement,
  getStatementFactory,
  isRegisteredStatement,
} from "./statements/statement.js";

// Canonical statement authoring-surface catalog (drives coverage + the manifest)
export {
  STATEMENT_SURFACES,
  TOTAL_STATEMENTS,
  IMPLEMENTED_STATEMENTS,
  sPathOf,
} from "./statements/surfaces.js";

// Agent-grounding manifest — machine-readable surface description + llms.txt
export { buildManifest, renderLlmsTxt, TOTAL_OBJECT_KINDS } from "./manifest/manifest.js";
export type {
  Manifest,
  ManifestKind,
  ManifestStatement,
  ManifestField,
  ManifestValue,
} from "./manifest/manifest.js";

// Schema-driven statement catalog (U9)
export { encodeFromSpec, registerSpec } from "./statements/schema-dsl/interpret.js";
export type { StatementSpec, FieldRule, Route, Authored } from "./statements/schema-dsl/interpret.js";
export { generated as generatedStatements } from "./statements/generated/factories.generated.js";
export {
  GENERATED_SPECS,
  GENERATED_STATEMENT_NAMES,
  mathAdd,
  mathSub,
  mathMul,
  mathDiv,
  bitwiseAnd,
  bitwiseOr,
  bitwiseXor,
  textAppend,
  textPrepend,
  objectKeys,
  objectValues,
  objectEntries,
} from "./statements/generated/catalog.js";

// Kind model
export {
  registerKind,
  getKind,
  encodeObject,
  isRegisteredKind,
  registeredKinds,
} from "./kinds/kind.js";
export type { ObjectKind } from "./kinds/kind.js";
export { functionKind, encodeFunction } from "./kinds/function.js";
export { trigger, triggerKind, encodeTrigger } from "./kinds/trigger.js";
export type { TriggerDef, TriggerXdo, TriggerObjType } from "./kinds/trigger.js";
export {
  tool,
  toolKind,
  encodeTool,
  toolsetKind,
  encodeToolset,
  toolset,
  agent,
} from "./kinds/toolset.js";
export { table, tableKind, encodeTable, encodeColumn, encodeIndex, encodeView } from "./kinds/table.js";
export type {
  TableDef,
  TableXdo,
  ColumnDef,
  SchemaDef,
  SchemaCols,
  RowOf,
  InferRow,
  IndexDef,
  IndexXdo,
  IndexType,
  IndexOp,
  IndexLang,
  ViewDef,
  ViewXdo,
} from "./kinds/table.js";
export { query, queryKind, encodeQuery, toSearchParams } from "./kinds/query.js";
export type { QueryDef, QueryHandle, QueryXdo, HttpVerb, SearchParamValue } from "./kinds/query.js";
export { apiGroup, apiGroupKind, encodeApiGroup } from "./kinds/api-group.js";
export type { ApiGroupDef, ApiGroupXdo, CorsConfig } from "./kinds/api-group.js";
export { task, taskKind, encodeTask, encodeSchedule } from "./kinds/task.js";
export type { TaskDef, TaskXdo, ScheduleDef } from "./kinds/task.js";
export { middleware, middlewareKind, encodeMiddleware } from "./kinds/middleware.js";
export type { MiddlewareDef, MiddlewareXdo, ResultStrategy, ExceptionPolicy } from "./kinds/middleware.js";
export { addon, addonKind, encodeAddon } from "./kinds/addon.js";
export type { AddonDef, AddonXdo } from "./kinds/addon.js";
export { workspaceConfig, workspaceKind, encodeWorkspaceConfig } from "./kinds/workspace-config.js";
export type { WorkspaceConfigDef, WorkspaceConfigXdo } from "./kinds/workspace-config.js";
export type {
  ToolDef,
  ToolXdo,
  ToolsetDef,
  ToolsetXdo,
  ToolsetType,
  AgentSettings,
  ToolsetToolRef,
} from "./kinds/toolset.js";

// Workspace registry + aggregate export
export { Xano, workspace } from "./workspace/xano.js";
export { buildBundle, calcSignatureJson, phpJsonEncode, PAYLOAD_ARRAY_KEYS } from "./workspace/export.js";
export type { Bundle, BundlePayload, BundleType, PayloadArrayKey } from "./workspace/export.js";

// Compile + emit. Only the pure string emitters live on the browser-safe entry;
// the `node:fs` writers (`writeArtifact`, `writeBundle`) and lock-file I/O
// (`readLockFile`, `writeLockFile`) are exported from `@sidestep/core/node`.
export { compile, encodeResponse } from "./function/compile.js";
export { emit, emitBundle, serializeBundle } from "./emit/emit.js";

// Identity lock file (xano.lock). Programmatic contract: seed BEFORE any def
// module is evaluated, once per process (see src/lock/store.ts).
export {
  LOCK_VERSION,
  emptyLock,
  parseLock,
  serializeLock,
  validateLockModel,
  mintCanonical,
  lockKey,
  resolvePayloadKey,
  createLockContext,
  recordObserved,
  mergeObserved,
  renameLockEntry,
  adoptFromBundle,
  WORKSPACE_KEY,
  WORKSPACE_REALTIME_KEY,
} from "./lock/lock.js";
export type {
  LockFile,
  LockEntry,
  LockExportContext,
  MergeResult,
  RenameResult,
  AdoptResult,
  AdoptChange,
} from "./lock/lock.js";
export {
  seedLockOverrides,
  resetLockOverrides,
  isLockSeeded,
  getLockedGuid,
  getLockedCanonical,
} from "./lock/store.js";

// Types
export type * from "./types/xdo.js";
