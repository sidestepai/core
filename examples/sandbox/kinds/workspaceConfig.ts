/**
 * `workspaceConfig({...})` — workspace-level settings (payload key `workspace`),
 * e.g. the canonical domain and realtime config. Also carries `use_xdo`.
 */
import { workspaceConfig } from "@sidestep/core";

export const wsConfig = workspaceConfig({
  name: "ex_kind_workspace_config",
  canonical: "my-app",
  realtime: { canonical: "my-app-realtime" },
});
