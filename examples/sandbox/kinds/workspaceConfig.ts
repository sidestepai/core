/**
 * `workspaceConfig({...})` — workspace-level settings (payload key `workspace`),
 * e.g. the canonical domain. Also carries `use_xdo` and the
 * workspace-tier `middleware` and `history` maps — the terminal fallback of the
 * Query → API Group → Workspace chain. Their keys are per object type (no
 * `_customize`/inherit flags); a query with no closer override inherits these.
 */
import { workspaceConfig } from "@sidestep/core";
import { rateLimit } from "./middleware.js";

export const wsConfig = workspaceConfig({
  // No `name`: the config inherits the one `workspace("…")` gave the registry
  // in index.ts. Naming it here would RENAME the workspace, which is what this
  // example used to do by accident.
  canonical: "my-app",
  // NOTE: `realtime`, `documentation`, and `swagger` are deliberately absent.
  // They are server-shaped blocks this SDK carries verbatim so a pulled workspace
  // round-trips, not surfaces to author. (For realtime, author `realtimeServer` /
  // `realtimeChannel` / `realtimeMessage` — see the realtime examples.)
  middleware: {
    query: { pre: [rateLimit] },
  },
  // Workspace-tier request-history defaults (terminal, wholesale — unlisted types
  // fall back to their engine default). A scalar per object type.
  history: {
    query: 100,
    function: true,
    trigger: "all",
    // `message` is the realtime tier; it defaults off because message history is
    // a hot path.
    message: false,
  },
  // Workspace environment variables — read at request time with `env("NAME")`.
  // VALUES ARE SECRETS: source them from the deploy environment, don't commit
  // literals or bundles containing real values. Deploy replaces the tenant's env.
  env: {
    STRIPE_KEY: process.env.STRIPE_KEY ?? "",
    APP_BASE_URL: "https://my-app.example.com",
  },
  // Editor preferences. Declare only what departs from the engine's defaults
  // (`allow_push: false`, `track_performance: true`, `use_internal_docs: false`)
  // — a value equal to the default is dropped when a workspace is pulled back.
  preferences: { allow_push: true },
  // Workspace settings, an opaque map merged over the engine's default scaffold:
  // name the members you care about, not the four provider configs you don't.
  settings: { ai_enabled: true },
  // Defaults applied to newly created objects (engine default: `int`).
  defaults: { db_primary_key: "uuid" },
  // Let tables carry SQL names distinct from their workspace names.
  use_custom_names: true,
  // Non-live datasources. WHOLESALE: deploying replaces the tenant's list, so
  // declare every datasource you want to keep.
  datasources: [{ label: "test", color: "#fff3cd" }],
  datasource_live: { color: "#fff3cd", show_banner: true },
});
