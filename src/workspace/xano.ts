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
import { deriveGuid, resolveRef, REFERENCEABLE_KINDS } from "../refs/guid.js";
import { buildBundle } from "./export.js";
import type { Bundle, BundleType, PayloadArrayKey } from "./export.js";
import { lockKey, mintCanonical, recordObserved, WORKSPACE_KEY, WORKSPACE_REALTIME_KEY } from "../lock/lock.js";
import type { LockExportContext } from "../lock/lock.js";
import type { FunctionDef } from "../function/define.js";
import type { TableDef } from "../kinds/table.js";
import type { ObjectKind } from "../kinds/kind.js";

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
      const explicit = (def as { guid?: string }).guid;
      if (obj.guid === undefined && typeof obj.name === "string") {
        obj.guid = explicit ?? deriveGuid(kind.payloadKey, obj.name);
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

  registerFunctions(defs: FunctionDef[]): this {
    return this.register("function", defs);
  }

  registerTriggers(defs: unknown[]): this {
    return this.register("trigger", defs);
  }

  registerTools(defs: unknown[]): this {
    return this.register("tool", defs);
  }

  registerToolsets(defs: unknown[]): this {
    return this.register("toolset", defs);
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
        // package-export time (`Export.php::exportSchema`) — it isn't part of the
        // stored dbo, so it lives here rather than in `encodeTable`. The import
        // reader (`Migrate.php::importWorkspace`) switches on `import.mode`;
        // "standard" = create-or-update by guid (merge/reference are the
        // marketplace-install modes). Without it the import fatals on an
        // undefined "import" key.
        return { ...encoded, import: { mode: "standard" } };
      });
    }
    // A query's `auth` is resolved to its stored guid at encode time in
    // `encodeQuery` (see `resolveAuth`); here — where the table registry is
    // known — we confirm each resolved reference actually names a registered
    // auth table. Xano supports any number of auth tables; each endpoint names
    // the one it authenticates against.
    this.validateQueryAuth(sections);
    if (lockCtx) this.applyLock(lockCtx, sections);
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
   * registry visibility, so a bare-name typo — or a name that resolves to a
   * table that isn't `table({ auth: true })` — produces a valid-looking guid
   * that only fails at deploy with an opaque engine error. Here we have the
   * registry, so we catch it at export and name the offending query. A numeric
   * `auth` (raw `dbo.id` escape hatch) references a table by id sidestep never
   * sees, so it's left as-is; `false` is a public endpoint. A table that pins an
   * explicit `guid` referenced by bare name lands in the "not registered" branch
   * (its name-derived guid diverges from the pinned one) — pass the def instead.
   */
  private validateQueryAuth(sections: Partial<Record<PayloadArrayKey, unknown[]>>): void {
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
      throw new Error(
        known
          ? `query "${name}": \`auth\` references table "${known}", which is not an auth table. ` +
              `Mark it with \`table({ auth: true })\`.`
          : `query "${name}": \`auth\` references a table that isn't registered on this workspace. ` +
              `Check for a typo, or register the auth table; if it pins an explicit \`guid\`, pass the ` +
              `table def rather than its name.`,
      );
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
    for (const key of ["app", "toolset"] as const) {
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
    // Workspace canonicals live under fixed keys (R5). Empty ones are filled
    // from the lock (the `lock adopt` round-trip) but never minted — the
    // engine provisions workspace canonicals itself and its collision
    // semantics are the least-verified corner. @TODO(verify): whether an
    // emitted workspace canonical survives `provisionWorkspace` on import.
    const ws = this.workspaceConfig as { canonical?: unknown; realtime?: { canonical?: unknown } };
    if (ws.canonical === "") {
      ws.canonical = ctx.lock.objects[WORKSPACE_KEY]?.canonical ?? "";
    }
    if (ws.realtime && ws.realtime.canonical === "") {
      ws.realtime.canonical = ctx.lock.objects[WORKSPACE_REALTIME_KEY]?.canonical ?? "";
    }
    if (typeof ws.canonical === "string" && ws.canonical !== "") {
      recordObserved(ctx, WORKSPACE_KEY, { canonical: ws.canonical });
    }
    if (typeof ws.realtime?.canonical === "string" && ws.realtime.canonical !== "") {
      recordObserved(ctx, WORKSPACE_REALTIME_KEY, { canonical: ws.realtime.canonical });
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
