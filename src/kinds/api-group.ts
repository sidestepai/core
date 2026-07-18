/**
 * API group kind (U7) → payload key `app` (stored as `mvp_app`). A metadata
 * container: queries bind to it via `app.id`. Carries CORS + group middleware.
 * Validated against `cloud-client: …/process/schema:api_group`.
 */
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { emptyMiddleware, encodeTags } from "./common.js";
import type { MiddlewareBlock } from "./common.js";

export interface CorsConfig {
  mode?: string; // default | custom | disabled
  allowOrigins?: string[];
  allowHeaders?: string[];
  allowCredentials?: boolean;
  maxAge?: number;
  allowMethods?: {
    delete?: boolean;
    get?: boolean;
    head?: boolean;
    patch?: boolean;
    post?: boolean;
    put?: boolean;
  };
}

export interface ApiGroupDef {
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  canonical?: string;
  description?: string;
  docs?: string;
  swagger?: boolean;
  apiGroupEnabled?: boolean;
  documentation?: { require_token: boolean; token: string };
  cors?: CorsConfig;
  /** Workspace tags (stored `tag: [{tag}]`), e.g. `["xano:quick-start"]`. */
  tags?: string[];
}

export interface ApiGroupXdo {
  name: string;
  description: string;
  canonical: string;
  swagger: boolean;
  api_group_enabled: boolean;
  docs: string;
  documentation: { require_token: boolean; token: string };
  middleware: MiddlewareBlock;
  history: { inherit: boolean; query_enabled: boolean; query_limit: number };
  tag: unknown[];
  cors: Required<CorsConfig> & {
    allowMethods: Required<NonNullable<CorsConfig["allowMethods"]>>;
  };
}

function encodeCors(cors?: CorsConfig): ApiGroupXdo["cors"] {
  return {
    mode: cors?.mode ?? "default",
    allowOrigins: cors?.allowOrigins ?? [],
    allowHeaders: cors?.allowHeaders ?? [],
    allowCredentials: cors?.allowCredentials ?? false,
    maxAge: cors?.maxAge ?? 0,
    allowMethods: {
      delete: cors?.allowMethods?.delete ?? false,
      get: cors?.allowMethods?.get ?? false,
      head: cors?.allowMethods?.head ?? false,
      patch: cors?.allowMethods?.patch ?? false,
      post: cors?.allowMethods?.post ?? false,
      put: cors?.allowMethods?.put ?? false,
    },
  };
}

export function encodeApiGroup(def: ApiGroupDef): ApiGroupXdo {
  if (!def.name) throw new Error("apiGroup: `name` is required.");
  return {
    name: def.name,
    description: def.description ?? "",
    canonical: def.canonical ?? "",
    swagger: def.swagger ?? false,
    api_group_enabled: def.apiGroupEnabled ?? true,
    docs: def.docs ?? "",
    documentation: def.documentation ?? { require_token: false, token: "" },
    middleware: emptyMiddleware(),
    history: { inherit: true, query_enabled: true, query_limit: 100 },
    tag: encodeTags(def.tags),
    cors: encodeCors(def.cors),
  };
}

export const apiGroupKind: ObjectKind<ApiGroupDef, ApiGroupXdo> = {
  name: "api_group",
  payloadKey: "app",
  encode: encodeApiGroup,
};
registerKind(apiGroupKind);

/** Author an API group (query container). */
export function apiGroup(def: ApiGroupDef): ApiGroupDef {
  return def;
}
