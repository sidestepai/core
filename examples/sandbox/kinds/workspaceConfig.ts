/**
 * `workspaceConfig({...})` — workspace-level settings (payload key `workspace`),
 * e.g. the canonical domain and realtime config. Also carries `use_xdo` and the
 * workspace-tier `middleware` map — the terminal fallback of the
 * Query → API Group → Workspace chain. Its keys are per host type (no
 * `_customize` flags); a query with no closer override inherits `query.pre`.
 */
import { workspaceConfig } from "@sidestep/core";
import { rateLimit } from "./middleware.js";

export const wsConfig = workspaceConfig({
  name: "ex_kind_workspace_config",
  canonical: "my-app",
  realtime: { canonical: "my-app-realtime" },
  middleware: {
    query: { pre: [rateLimit] },
  },
});
