/**
 * The central `Xano` registry (KTD-5). Authoring happens in a `xano/` folder
 * tree; modules export typed objects and register them **explicitly** on a
 * `Xano` instance (no folder auto-discovery magic — confirmed with the user).
 * `export()` walks the registrations and emits the aggregate `packageExport`
 * bundle.
 *
 * Per-kind sugar methods (`registerFunctions`, …) are thin wrappers over the
 * generic `register(kindName, …)`. More sugar is added as each kind lands.
 */
import { getKind, encodeObject } from "../kinds/kind.js";
import { middlewareEntryGuid, stackReferencesAuth } from "../kinds/middleware-attach.js";
import { deriveGuid, resolveRef, REFERENCEABLE_KINDS } from "../refs/guid.js";
import { buildBundle } from "./export.js";
import type { Bundle, BundleType, PayloadArrayKey } from "./export.js";
import {
  CANONICAL_PAYLOAD_KEYS,
  lockKey,
  mintCanonical,
  recordObserved,
  WORKSPACE_KEY,
} from "../lock/lock.js";
import type { LockExportContext } from "../lock/lock.js";
import type { FunctionDef } from "../function/define.js";
import type { TableDef } from "../kinds/table.js";
import type { ObjectKind } from "../kinds/kind.js";
import { DiagnosticBag } from "./diagnostics.js";
import { checkReferences, checkStacks } from "./guards.js";

/**
 * Cross-realm brand. `instanceof Xano` breaks when sidestep is loaded by two
 * different module loaders (e.g. the CLI under bare Node while a `.ts` entry is
 * loaded through tsx), since each loader has its own `Xano` constructor. A
 * `Symbol.for` key is shared through the global registry, so a structural
 * brand check survives that split.
 */
const XANO_BRAND: unique symbol = Symbol.for("sidestep.Xano");

export class Xano {
  /** @internal cross-realm identity brand — see {@link Xano.isXano}. */
  readonly [XANO_BRAND] = true;
  /** Encoded objects keyed by `packageExport` payload key. */
  private readonly sections = new Map<string, unknown[]>();
  /** Table defs, encoded lazily at {@link export} so each can inherit the workspace `use_xdo`. */
  private readonly tableDefs: TableDef[] = [];
  private workspaceConfig: Record<string, unknown> = {};
  private bundleType: BundleType = "workspace";

  /** True for any `Xano` registry, even one created by a different module instance. */
  static isXano(value: unknown): value is Xano {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as Record<symbol, unknown>)[XANO_BRAND] === true
    );
  }

  /** Encode one def and stamp its deterministic guid (the engine's sync/reference anchor). */
  private encodeOne(kind: ObjectKind<unknown, unknown>, def: unknown): unknown {
    const encoded = kind.encode(def);
    // Every guid-bearing object carries a deterministic guid — its identity
    // anchor for sync (the engine upserts by guid) and the target of any
    // reference (see refs/guid.ts). A standalone `compile()` has no
    // cross-references to resolve.
    if (REFERENCEABLE_KINDS.has(kind.name) && encoded && typeof encoded === "object") {
      const obj = encoded as Record<string, unknown>;
      // An explicit `guid` on the def is used verbatim (pins identity across a
      // rename / matches an existing workspace object); otherwise derive a
      // stable one from the display name. Guid type is the migrate type
      // (== payloadKey), e.g. table → "dbo".
      // A kind whose identity is not `md5("<payloadKey>:<name>")` declares
      // `guidOf` (the realtime family — a channel path is unique only per
      // server, a message name only per channel, so the name alone would make
      // two distinct objects share one guid and collapse onto one row).
      const explicit = (def as { guid?: string }).guid;
      if (obj.guid === undefined && typeof obj.name === "string") {
        obj.guid = explicit ?? kind.guidOf?.(def) ?? deriveGuid(kind.payloadKey, obj.name);
      }
    }
    return encoded;
  }

  /** Register one or more authoring defs of a given kind. */
  register(kindName: string, defOrDefs: unknown): this {
    const kind = getKind(kindName);
    const defs = Array.isArray(defOrDefs) ? defOrDefs : [defOrDefs];
    // Tables are encoded lazily at export: a table's `use_xdo` defaults to the
    // workspace's `use_xdo`, which may be registered in any order, so we resolve
    // it once both are known (see {@link export}).
    if (kind.name === "table") {
      for (const def of defs) this.tableDefs.push(def as TableDef);
      return this;
    }
    const bucket = this.sections.get(kind.payloadKey) ?? [];
    for (const def of defs) bucket.push(this.encodeOne(kind, def));
    this.sections.set(kind.payloadKey, bucket);
    return this;
  }

  /** Register the workspace settings object (singleton). */
  registerWorkspace(def: unknown): this {
    this.workspaceConfig = encodeObject<Record<string, unknown>>("workspace", def);
    return this;
  }

  /** Set the bundle `type` (defaults to "workspace"). */
  setBundleType(type: BundleType): this {
    this.bundleType = type;
    return this;
  }

  /**
   * The registered table defs (with their authored `seed`), for the Node deploy
   * path to build `content/` seed entries. Deliberately NOT reached from
   * `export()` — seed values are resolved only in the deploy pipeline, so they
   * never enter the browser-safe bundle. See {@link import("./seed.js")}.
   */
  tables(): readonly TableDef[] {
    return [...this.tableDefs];
  }

  registerFunctions(defs: FunctionDef[]): this {
    return this.register("function", defs);
  }

  registerTriggers(defs: unknown[]): this {
    return this.register("trigger", defs);
  }

  registerTools(defs: unknown[]): this {
    return this.register("tool", defs);
  }

  registerMcpServers(defs: unknown[]): this {
    return this.register("mcp_server", defs);
  }

  registerAgents(defs: unknown[]): this {
    return this.register("agent", defs);
  }

  registerTables(defs: unknown[]): this {
    return this.register("table", defs);
  }

  registerQueries(defs: unknown[]): this {
    return this.register("query", defs);
  }

  registerApiGroups(defs: unknown[]): this {
    return this.register("api_group", defs);
  }

  registerTasks(defs: unknown[]): this {
    return this.register("task", defs);
  }

  registerMiddleware(defs: unknown[]): this {
    return this.register("middleware", defs);
  }

  registerAddons(defs: unknown[]): this {
    return this.register("addon", defs);
  }

  registerMicroservices(defs: unknown[]): this {
    return this.register("microservice", defs);
  }

  registerRealtimeServers(defs: unknown[]): this {
    return this.register("realtime_server", defs);
  }

  registerRealtimeChannels(defs: unknown[]): this {
    return this.register("channel", defs);
  }

  registerRealtimeMessages(defs: unknown[]): this {
    return this.register("message", defs);
  }

  registerWorkflowTests(defs: unknown[]): this {
    return this.register("workflow_test", defs);
  }

  /**
   * Assemble the signed aggregate `packageExport` bundle.
   *
   * With `options.lock` (a {@link LockExportContext}), the export participates
   * in identity locking: empty api-group/toolset canonicals are filled from the
   * lock — minted fresh on first sight — and every identity the bundle emits is
   * reported back through `ctx.observed` (MUTATING the passed context), which
   * the caller merges into the lock file. All lock work happens before the
   * bundle is signed. Without options the output is byte-identical to before.
   */
  export(options: { lock?: LockExportContext } = {}): Bundle {
    const lockCtx = options.lock;
    const sections: Partial<Record<PayloadArrayKey, unknown[]>> = {};
    for (const [key, arr] of this.sections) {
      sections[key as PayloadArrayKey] = arr;
    }
    // Encode tables now that the workspace `use_xdo` is known: a table without an
    // explicit `useXdo` inherits the workspace default, so the two stay in sync.
    if (this.tableDefs.length > 0) {
      const tableKind = getKind("table") as ObjectKind<unknown, unknown>;
      const wsUseXdo = this.workspaceConfig.use_xdo === true;
      sections[tableKind.payloadKey as PayloadArrayKey] = this.tableDefs.map((def) => {
        const encoded = this.encodeOne(
          tableKind,
          def.useXdo === undefined ? { ...def, useXdo: wsUseXdo } : def,
        ) as Record<string, unknown>;
        // The engine decorates each dbo with an import directive *only* at
        // package-export time — it isn't part of the stored dbo, so it lives
        // here rather than in `encodeTable`. The import reader switches on
        // `import.mode`;
        // "standard" = create-or-update by guid (merge/reference are the
        // marketplace-install modes). Without it the import fatals on an
        // undefined "import" key.
        return { ...encoded, import: { mode: "standard" } };
      });
    }
    // Every build-time finding lands in one bag so the author sees the whole
    // set at once, and so a hard error aborts BEFORE the lock is mutated or the
    // bundle is signed.
    const bag = new DiagnosticBag();
    // A query's `auth` is resolved to its stored guid at encode time in
    // `encodeQuery` (see `resolveAuth`); here — where the table registry is
    // known — we confirm each resolved reference actually names a registered
    // auth table. Xano supports any number of auth tables; each endpoint names
    // the one it authenticates against.
    this.validateQueryAuth(sections, bag);
    // Catch an `auth()`-keyed middleware directly attached to a host that can't
    // resolve a request identity — the silent null-bucket collapse (issue #81).
    this.validateMiddlewareAuth(sections, bag);
    // Every cross-object reference must name something this bundle carries.
    // Runs last so a more specific diagnostic (an unregistered auth table)
    // is reported in its own words rather than as a bare dangling guid.
    // Shapes that succeed with HTTP 200 and the wrong result — warnings, so
    // they never block a deploy.
    checkStacks(this.tableDefs, sections, bag);
    checkReferences(this.bundleType, sections, this.workspaceConfig.guid, bag);
    bag.flush();
    if (lockCtx) this.applyLock(lockCtx, sections);
    // The workspace-import path requires `workspace.guid`. Under a lock,
    // `applyLock` stamps it from the workspace canonical; without one, derive a
    // deterministic guid from the workspace name so a lock-less `deploy` still
    // imports. Deterministic → stable across redeploys (refresh doesn't churn it).
    // Follow-up: build with a lock by default instead of this fallback.
    if (this.workspaceConfig.guid === undefined) {
      const wsName = typeof this.workspaceConfig.name === "string" ? this.workspaceConfig.name : "workspace";
      this.workspaceConfig.guid = deriveGuid("workspace", wsName);
    }
    return buildBundle({
      type: this.bundleType,
      workspace: this.workspaceConfig,
      sections,
      lock: lockCtx?.lock,
    });
  }

  /**
   * Cross-check every query's resolved `auth` against the registered auth tables.
   *
   * `resolveAuth` (in `encodeQuery`) turns a table ref into a guid with no
   * registry visibility, so a bare-name typo produces a valid-looking guid that
   * only fails at deploy with an opaque engine error. Here we have the registry,
   * so we catch it at export and name the offending query.
   *
   * A registered table that is not `table({ auth: true })` only WARNS: the
   * engine reads that flag nowhere at request time (it compares the token's
   * `dbo` to the endpoint's by name, and mints tokens for any table by name), so
   * refusing the combination blocked a real workspace's round trip. A numeric
   * `auth` (raw `dbo.id` escape hatch) references a table by id sidestep never
   * sees, so it's left as-is; `false` is a public endpoint. A table that pins an
   * explicit `guid` referenced by bare name lands in the "not registered" branch
   * (its name-derived guid diverges from the pinned one) — pass the def instead.
   */
  private validateQueryAuth(
    sections: Partial<Record<PayloadArrayKey, unknown[]>>,
    bag: DiagnosticBag,
  ): void {
    // The query kind's `payloadKey` (see `queryKind`); referenced literally so
    // this doesn't depend on the query kind being registered in every workspace.
    const queries = sections["query" as PayloadArrayKey];
    if (!Array.isArray(queries) || queries.length === 0) return;
    // Every registered table's guid → name, and the subset that are auth tables.
    // Resolved via the same `resolveRef("dbo", …)` a query's `auth` flows through,
    // so an explicit-guid table matches by def-handle reference.
    const tableNameByGuid = new Map<string, string>();
    const authGuids = new Set<string>();
    for (const def of this.tableDefs) {
      const guid = resolveRef("dbo", def);
      tableNameByGuid.set(guid, def.name);
      if (def.auth === true) authGuids.add(guid);
    }
    for (const q of queries) {
      if (!q || typeof q !== "object") continue;
      const auth = (q as { auth?: unknown }).auth;
      // Only a guid (string) needs the registry; `false`/number carry no name.
      if (typeof auth !== "string" || authGuids.has(auth)) continue;
      const name = String((q as { name?: unknown }).name ?? "?");
      const known = tableNameByGuid.get(auth);
      // A REGISTERED table that isn't flagged `auth` warns rather than throws.
      // The engine compares the token's `dbo` to the endpoint's by name and reads
      // the table's flag nowhere, so the combination works — and one real
      // workspace ships it, which throwing made impossible to pull.
      if (known) {
        bag.warn(
          "query.auth-table-unflagged",
          `query "${name}" requires auth against table "${known}", which is not marked ` +
            `\`table({ auth: true })\`. The engine allows it — a token minted for that table is ` +
            `accepted — but the editor will not offer the table as an auth source. Mark it if that ` +
            `is what you meant.`,
        );
        continue;
      }
      bag.error(
        "query.auth-table-unregistered",
        `query "${name}": \`auth\` references a table that isn't registered on this workspace. ` +
          `Check for a typo, or register the auth table; if it pins an explicit \`guid\`, pass the ` +
          `table def rather than its name.`,
      );
    }
  }

  /**
   * Warn about an `auth()`-keyed middleware **directly attached** to a host where
   * `auth()` may resolve to `null` (issue #81).
   *
   * The footgun: a rate limiter keyed by `auth("id")` is the canonical middleware,
   * but attach it to a host with no authenticated caller and `auth()` silently
   * resolves to `null` — every caller collapses into one shared bucket, with no
   * signal at author, export, or runtime. This surfaces it at export, where the
   * middleware registry is known (an attachment entry only carries the target's
   * guid; we resolve it back to the encoded `run` to inspect for `auth()`).
   *
   * It **warns, never throws** — a bare `auth()` reference is not proof of a
   * collapse (an IP-disambiguated key or a personalize-if-logged-in middleware
   * uses `auth()` where `null` is fine), so blocking the export would produce
   * false positives on legitimate use. The warning names the host and reason so
   * the author can confirm intent, vary the key, or move to an authenticated host.
   *
   * Scope: **direct attachment only** — a host's own `middleware.pre`/`post`. An
   * authenticated `query` (its own `auth` table set) resolves an identity, so it
   * is skipped. SideStep does not resolve the engine's Query→API-Group→Workspace
   * inheritance walk (`getMiddlewareForObject`), so a middleware reaching a public
   * query only via a workspace/API-group tier is a documented limitation.
   */
  private validateMiddlewareAuth(
    sections: Partial<Record<PayloadArrayKey, unknown[]>>,
    bag: DiagnosticBag,
  ): void {
    const middlewares = sections["middleware" as PayloadArrayKey];
    if (!Array.isArray(middlewares) || middlewares.length === 0) return;
    // Index encoded middleware by guid. auth() detection is lazy + memoized (see
    // `referencesAuth`) so we only deep-walk a stack that is actually attached —
    // a defined-but-unattached middleware is never walked.
    const byGuid = new Map<string, Record<string, unknown>>();
    for (const mw of middlewares) {
      if (!mw || typeof mw !== "object") continue;
      const guid = (mw as { guid?: unknown }).guid;
      if (typeof guid === "string") byGuid.set(guid, mw as Record<string, unknown>);
    }
    const authCache = new Map<string, boolean>();
    const referencesAuth = (guid: string): boolean => {
      let hit = authCache.get(guid);
      if (hit === undefined) {
        // The registry keeps only the encoded middleware; walk its `run` (the tag
        // survives encoding — see `stackReferencesAuth`).
        const run = byGuid.get(guid)?.run;
        hit = stackReferencesAuth(Array.isArray(run) ? run : undefined);
        authCache.set(guid, hit);
      }
      return hit;
    };

    // Leaf hosts that run middleware on their own request, each paired with why
    // `auth()` may be null there. The `apiGroup` and workspace *tiers* are
    // intentionally absent — their blocks are inherited by member queries, not run
    // directly, and resolving that walk is out of scope (see the method doc). A
    // `query` with its own auth table resolves an identity and is skipped.
    const hostKinds: { key: PayloadArrayKey; label: string; reason: string }[] = [
      { key: "query", label: "query", reason: "this endpoint has no auth table" },
      { key: "task", label: "task", reason: "a task is scheduled/background and never has a request identity" },
      { key: "function", label: "function", reason: "auth() is null unless an authenticated caller invokes it" },
      { key: "tool", label: "tool", reason: "auth() is null unless an authenticated caller invokes it" },
    ];

    for (const { key, label, reason } of hostKinds) {
      const hosts = sections[key];
      if (!Array.isArray(hosts)) continue;
      for (const host of hosts) {
        if (!host || typeof host !== "object") continue;
        const block = (host as { middleware?: unknown }).middleware;
        if (!block || typeof block !== "object") continue;
        // An authenticated query resolves an identity, so auth() is fine there.
        if (label === "query" && (host as { auth?: unknown }).auth) continue;
        const { pre, post } = block as { pre?: unknown; post?: unknown };
        const entries = [...(Array.isArray(pre) ? pre : []), ...(Array.isArray(post) ? post : [])];
        const hostName = String((host as { name?: unknown }).name ?? "?");

        for (const entry of entries) {
          // A disabled attachment doesn't run, so it can't collapse a bucket.
          if ((entry as { disabled?: unknown })?.disabled === true) continue;
          const guid = middlewareEntryGuid(entry);
          if (!guid || !referencesAuth(guid)) continue;
          const mwName = String(byGuid.get(guid)?.name ?? guid);

          bag.warn(
            "middleware.auth-null-host",
            `middleware "${mwName}" references auth() and is attached to ${label} ` +
              `"${hostName}", where ${reason}. A null auth() collapses all callers into one shared ` +
              `key — attach it to an authenticated host, vary the key, or remove auth().`,
          );
        }
      }
    }
  }

  /**
   * Lock participation (see {@link export}): canonical fill + identity report.
   * Runs after all sections are assembled and before signing.
   */
  private applyLock(
    ctx: LockExportContext,
    sections: Partial<Record<PayloadArrayKey, unknown[]>>,
  ): void {
    // Canonicals already spoken for (explicit in code, locked, or emitted in a
    // previous export() of this registry) must never be re-minted onto another
    // object — a duplicate canonical is one URL token serving two APIs.
    const usedCanonicals = new Set<string>();
    for (const entry of Object.values(ctx.lock.objects)) {
      if (entry.canonical) usedCanonicals.add(entry.canonical);
    }
    for (const arr of Object.values(sections)) {
      for (const obj of arr ?? []) {
        const canonical = (obj as { canonical?: unknown }).canonical;
        if (typeof canonical === "string" && canonical !== "") usedCanonicals.add(canonical);
      }
    }
    const mintUnique = (): string => {
      let token = mintCanonical();
      while (usedCanonicals.has(token)) token = mintCanonical();
      usedCanonicals.add(token);
      return token;
    };
    // Fill empty api-group/toolset canonicals: locked value, else mint-and-freeze
    // (R4). An explicit in-code canonical is already in the payload and stays.
    // Before minting for a key the lock doesn't know, check whether some OTHER
    // lock entry pins this object's GUID — that's a moved/orphaned entry for
    // the same engine object (a rename reverted before the `lock rename`
    // fix-up), and its canonical is the object's real public URL. Reusing it
    // beats minting a fresh token that would silently change the URL.
    const canonicalByGuid = (guid: unknown): string | undefined => {
      if (typeof guid !== "string") return undefined;
      for (const entry of Object.values(ctx.lock.objects)) {
        if (entry.guid === guid && entry.canonical !== undefined) return entry.canonical;
      }
      return undefined;
    };
    // Driven by the shared canonical-bearing set rather than a literal list, so
    // a kind that gains a canonical participates in minting automatically.
    for (const key of CANONICAL_PAYLOAD_KEYS as Set<PayloadArrayKey>) {
      for (const obj of sections[key] ?? []) {
        if (!obj || typeof obj !== "object") continue;
        const o = obj as { name?: unknown; guid?: unknown; canonical?: unknown };
        if (typeof o.name !== "string" || o.canonical !== "") continue;
        o.canonical =
          ctx.lock.objects[lockKey(key, o.name)]?.canonical ??
          canonicalByGuid(o.guid) ??
          mintUnique();
      }
    }
    // The workspace canonical lives under a fixed key (R5). An empty one is
    // filled from the lock (the `lock adopt` round-trip) but never minted — the
    // engine provisions workspace canonicals itself and its collision
    // semantics are the least-verified corner. @TODO(verify): whether an
    // emitted workspace canonical survives `provisionWorkspace` on import.
    const ws = this.workspaceConfig as { canonical?: unknown };
    if (ws.canonical === "") {
      ws.canonical = ctx.lock.objects[WORKSPACE_KEY]?.canonical ?? "";
    }
    if (typeof ws.canonical === "string" && ws.canonical !== "") {
      recordObserved(ctx, WORKSPACE_KEY, { canonical: ws.canonical });
    }
    // Report every guid-bearing object the bundle emits (guid conflicts with
    // the lock hard-error inside recordObserved — R3).
    for (const [payloadKey, arr] of Object.entries(sections)) {
      for (const obj of arr ?? []) {
        if (!obj || typeof obj !== "object") continue;
        const o = obj as { name?: unknown; guid?: unknown; canonical?: unknown };
        if (typeof o.name !== "string" || typeof o.guid !== "string") continue;
        const identity: { guid: string; canonical?: string } = { guid: o.guid };
        if (typeof o.canonical === "string" && o.canonical !== "") {
          identity.canonical = o.canonical;
        }
        recordObserved(ctx, lockKey(payloadKey, o.name), identity);
      }
    }
  }
}

/**
 * Convenience entry point — the natural name for "make a workspace."
 * `workspace("my-app")` is exactly `new Xano().registerWorkspace({ name:
 * "my-app" })`, returning the chainable {@link Xano} registry. Continue with the
 * per-kind `register*` methods and finish with `.export()`:
 *
 * ```ts
 * export default workspace("my-app")
 *   .registerTables([users])
 *   .registerQueries([listUsers]);
 * ```
 *
 * Authoring is functional/declarative: there is **no** callback-builder form —
 * you pass typed def-objects (`table({...})`, `query({...})`,
 * `defineFunction({...})`) to the `register*` methods, not a `w => {...}` closure.
 */
export function workspace(name: string): Xano {
  return new Xano().registerWorkspace({ name });
}
