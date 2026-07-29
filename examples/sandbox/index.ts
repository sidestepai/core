/**
 * The implementation-examples sandbox — one deployable Xano workspace that
 * registers every example so the whole set type-checks and `export()`s.
 *
 * The statement / value / filter / field examples are collected automatically
 * (see `_auto.ts`, regenerated with `npm run examples:index`). The object-kind
 * examples in `kinds/` are hand-wired below, since each is a different kind with
 * its own `register*` bucket.
 */
import { workspace } from "@sidestep/core";
import { api, users, posts, doubleFn } from "./_shared.js";
import { autoTables, autoQueries, autoFunctions } from "./_auto.js";

// --- object-kind examples (kinds/) ---
import { addFunction } from "./kinds/function.js";
import { productTable } from "./kinds/table.js";
import { publicApi } from "./kinds/apiGroup.js";
import { getUserQuery, userPostQuery } from "./kinds/query.js";
import { onUserInsert, onMessage, onBranchLive } from "./kinds/trigger.js";
import { searchTool } from "./kinds/tool.js";
import { exampleMcpServer, assistant, classifier, askAssistant, classifyTicket } from "./kinds/ai.js";
import { nightlyCleanup } from "./kinds/task.js";
import { rateLimit, publicRateLimit } from "./kinds/middleware.js";
import { authorAddon } from "./kinds/addon.js";
import { wsConfig } from "./kinds/workspaceConfig.js";
import {
  chatServer,
  lobbyChannel,
  roomChannel,
  sendMessage,
  typingMessage,
  onChatConnect,
  onRoomJoin,
} from "./kinds/realtime.js";

// The examples span many def-object kinds; register* buckets are typed per kind.
const defs = (xs: unknown[]) => xs as never[];

export default workspace("sidestep-examples")
  .registerWorkspace(wsConfig)
  .registerApiGroups(defs([api, publicApi]))
  .registerTables(defs([users, posts, productTable, ...autoTables]))
  .registerFunctions(defs([doubleFn, addFunction, ...autoFunctions]))
  .registerQueries(defs([getUserQuery, userPostQuery, askAssistant, classifyTicket, ...autoQueries]))
  .registerTriggers(defs([onUserInsert, onMessage, onBranchLive, onChatConnect, onRoomJoin]))
  .registerTools(defs([searchTool]))
  .registerMcpServers(defs([exampleMcpServer]))
  .registerAgents(defs([assistant, classifier]))
  .registerTasks(defs([nightlyCleanup]))
  .registerMiddleware(defs([rateLimit, publicRateLimit]))
  .registerAddons(defs([authorAddon]))
  .registerRealtimeServers(defs([chatServer]))
  .registerRealtimeChannels(defs([lobbyChannel, roomChannel]))
  .registerRealtimeMessages(defs([sendMessage, typingMessage]));
