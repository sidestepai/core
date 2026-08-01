/**
 * Capture harness (NOT a shipped example, NOT auto-indexed).
 *
 * A curated subset of the sandbox — one object per authored KIND plus the deps
 * each needs — used as the `sidestep validate --capture` input to source real
 * engine goldens for the per-kind byte-verify corpus (plan 2026-07-22-008).
 *
 * It reuses the maintained `kinds/` example objects verbatim (KTD-5) rather than
 * re-authoring shapes, but omits the 600 auto-generated field/statement/filter
 * examples that make the full `index.ts` import too fragile to capture against.
 *
 * Run:  node dist/bin.js validate examples/sandbox/_capture.ts --capture --out validate-out
 */
import { workspace, query, s, inp, input, ref } from "@sidestep/core";
import { api, users, posts } from "./_shared.js";
import { fieldTableRef } from "./fields/tableRef.js";
import { productTable } from "./kinds/table.js";
import { getUserQuery } from "./kinds/query.js";
import { onUserInsert, onMessage, onBranchLive } from "./kinds/trigger.js";
import { searchTool } from "./kinds/tool.js";
import { exampleMcpServer, assistant, askAssistant } from "./kinds/ai.js";
import { nightlyCleanup } from "./kinds/task.js";
import { rateLimit } from "./kinds/middleware.js";
import { authorAddon } from "./kinds/addon.js";
import { echoService, helmService } from "./kinds/microservice.js";
import {
  chatServer,
  lobbyChannel,
  roomChannel,
  sendMessage,
  typingMessage,
  onChatConnect,
  onRoomJoin,
  onRoomDeliver,
} from "./kinds/realtime.js";

// A query with a CUSTOMIZED (inherit:false) request-history block — the golden
// source for byte-verifying authored history (the shipped examples all inherit).
const historyQuery = query({
  name: "ex_history_query",
  verb: "GET",
  apiGroup: api,
  history: 100,
  input: { id: input.int({ required: true }) },
  stack: [s.db.get({ table: users, fieldValue: inp("id"), as: "user" })],
  response: ref("user"),
});

// register* buckets are typed per kind; the examples span many kinds.
const defs = (xs: unknown[]) => xs as never[];

export default workspace("sidestep-capture-kinds")
  .registerApiGroups(defs([api]))
  .registerTables(defs([users, posts, productTable, fieldTableRef]))
  .registerQueries(defs([getUserQuery, askAssistant, historyQuery]))
  .registerTriggers(defs([onUserInsert, onMessage, onBranchLive, onChatConnect, onRoomJoin, onRoomDeliver]))
  .registerTools(defs([searchTool]))
  .registerMcpServers(defs([exampleMcpServer]))
  .registerAgents(defs([assistant]))
  .registerTasks(defs([nightlyCleanup]))
  .registerMiddleware(defs([rateLimit]))
  .registerAddons(defs([authorAddon]))
  .registerMicroservices(defs([echoService, helmService]))
  .registerRealtimeServers(defs([chatServer]))
  .registerRealtimeChannels(defs([lobbyChannel, roomChannel]))
  .registerRealtimeMessages(defs([sendMessage, typingMessage]));
