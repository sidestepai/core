/**
 * `workspaceConfig({...})` — workspace-level settings (payload key `workspace`),
 * e.g. the canonical domain and realtime config. Also carries `use_xdo` and the
 * workspace-tier `middleware` and `history` maps — the terminal fallback of the
 * Query → API Group → Workspace chain. Their keys are per object type (no
 * `_customize`/inherit flags); a query with no closer override inherits these.
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
  // Workspace-tier request-history defaults (terminal, wholesale — unlisted types
  // fall back to their engine default). A scalar per object type.
  history: {
    query: 100,
    function: true,
    trigger: "all",
  },
  // Workspace environment variables — read at request time with `env("NAME")`.
  // VALUES ARE SECRETS: source them from the deploy environment, don't commit
  // literals or bundles containing real values. Deploy replaces the tenant's env.
  env: {
    STRIPE_KEY: process.env.STRIPE_KEY ?? "",
    APP_BASE_URL: "https://my-app.example.com",
  },
  // Defaults applied to newly created objects.
  defaults: { db_primary_key: "int" },
  // Let tables carry SQL names distinct from their workspace names.
  use_custom_names: false,
  // Non-live datasources. WHOLESALE: deploying replaces the tenant's list, so
  // declare every datasource you want to keep.
  datasources: [{ label: "test", color: "#fff3cd" }],
  datasource_live: { color: "#008000", show_banner: false },
});
