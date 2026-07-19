# sidestep

**Sidestep into code — drive Xano infrastructure from TypeScript.**

Sidestep is a standalone TypeScript SDK for powering Xano infrastructure in
code. Author an entire Xano workspace in TypeScript and compile it into Xano's
stored JSON — an **AI-first SDK** where an agent (or a developer) emits
well-typed TS that deterministically produces a valid, importable Xano workspace
bundle.

You build a `xano/` folder of typed objects, register them on a central `Xano`
instance, and call `export()` to get one aggregate `packageExport` bundle.

## Install

```bash
npm install @sidestep/core
```

## The model

```ts
import { Xano, defineFunction, table, trigger, input, setVar, ref, c } from "@sidestep/core";

const getUser = defineFunction({
  name: "get_user",
  input: { id: input.int({ required: true }) },
  stack: [setVar("x1", ref("id"))],
  response: ref("x1"),
});

const users = table({
  name: "user",
  auth: true,
  // `id` + `created_at` are auto-injected system columns; declare only your own.
  schema: [{ name: "email", type: "email", required: true, methods: ["trim", "lower"] }],
  index: [{ type: "primary", fields: [{ name: "id" }] }],
});

const xano = new Xano()
  .registerWorkspace({ name: "my-app" })
  .registerFunctions([getUser])
  .registerTables([users]);

export default xano;            // `sidestep export` reads this default export
```

`workspace("my-app")` is a convenience for `new Xano().registerWorkspace({ name:
"my-app" })` — the natural entry point that returns the same chainable registry:

```ts
import { workspace } from "@sidestep/core";
export default workspace("my-app").registerFunctions([getUser]).registerTables([users]);
```

Authoring is **declarative def-objects** passed to factories — there is no
callback/chaining builder (no `workspace(w => w.table(...))`). See `llms.txt`'s
**Gotchas** section for the handful of intuitions that commonly miss (foreign keys
are `f.tableRef`, not `ref`; system columns auto-inject; self-refs use the
bare-name form).

For a fuller example, see the test fixture workspace
([`test/fixtures/workspace/`](test/fixtures/workspace/)) and
[**@sidestep/auth**](https://www.npmjs.com/package/@sidestep/auth) — the canonical
extension package (auth tables + queries + a function, shipped as reusable
npm-versioned defs) — whose
[`docs/extending-sidestep.md`](https://github.com/sidestepai/auth/blob/main/docs/extending-sidestep.md)
documents the extension-package pattern.

`xano.export()` returns the importable bundle:

```jsonc
{ "app": "xano", "version": "1.03", "type": "workspace",
  "payload": { "function": [...], "dbo": [...], "trigger": [...], "workspace": {...}, ... },
  "sig": "<base64url sha1>" }
```

## Project structure (explicit registration)

Lay objects out however you like and register them explicitly — there is no
folder auto-discovery magic (deliberately):

```
xano/
├── functions/   get-user.ts        export default defineFunction({...})
├── tables/      user.ts            export default table({...})
├── triggers/    on-insert.ts       export default trigger.table({...})
├── toolsets/    assistant.ts       export default agent({...})
└── index.ts     new Xano().registerFunctions([...]).registerTables([...])...
```

## Object kinds

Every top-level Xano object is a registered kind with a factory and a
`Xano.register*` method. Payload keys use the engine's singular names.

| Author with | `Xano` method | Payload key |
|---|---|---|
| `defineFunction({...})` | `registerFunctions` | `function` |
| `table({ schema, index, ... })` | `registerTables` | `dbo` |
| `query({ verb, apiGroup, ... })` | `registerQueries` | `query` |
| `apiGroup({ canonical, cors, ... })` | `registerApiGroups` | `app` |
| `trigger.{table,realtime,mcpServer,agent,workspace,error}(...)` | `registerTriggers` | `trigger` |
| `tool({...})` | `registerTools` | `tool` |
| `toolset.mcp({...})` / `agent({...})` | `registerToolsets` | `toolset` |
| `task({ schedule, ... })` | `registerTasks` | `task` |
| `middleware({ resultStrategy, ... })` | `registerMiddleware` | `middleware` |
| `addon({...})` | `registerAddons` | `addon` |
| `workspaceConfig({...})` | `registerWorkspace` | `workspace` |

### Triggers

All six trigger types share one envelope, discriminated by `obj_type` + a
per-type `meta`: `trigger.table` (db), `trigger.realtime`, `trigger.mcpServer`,
`trigger.agent`, `trigger.workspace`, `trigger.error`.

### Toolsets — AI vs MCP

- **MCP toolset** — `toolset.mcp({ name, tools: [{ tool: myTool }] })`: a
  collection of tools exposed via the MCP protocol. Each entry's `tool` is a
  `tool()` def handle (or its name) — it resolves to the tool's guid at export,
  the same cross-object mechanism the call family uses. (A raw numeric `id` is an
  escape hatch for adopting an existing engine-side toolset.)
- **AI/agent toolset** — `agent({ name, agentSettings: { type: "anthropic", model, system_prompt }, tools: [{ tool: myTool }] })`:
  an LLM orchestrator (stored as a toolset with `type:"agent"` + `agent_settings`).
- A **tool** (`tool({...})`) is its own kind — a function-like operation a toolset references.

### Tables

- **Field types** — a typed catalog `f.*` (`src/fields/catalog.ts`) covers the
  full type surface: scalars (`f.text`/`f.int`/`f.decimal`/`f.bool`/`f.uuid`/
  `f.date`/`f.email`/`f.password`/`f.json`), `f.timestamp` (→ `epochms`), the
  four file resources (`f.image`→`blob_img`, `f.video`→`blob_video`,
  `f.audio`→`blob_audio`, `f.attachment`→`blob`), the six `f.geo.*` types,
  `f.enum(values)`, `f.vector(size)`, and `f.object(children)` (→ `obj`).
  Foreign keys are `f.tableRef(table)` — an `int` (or `{ type: "uuid" }`)
  column whose persisted link is a trailing `@` method that resolves to the
  target table's guid via the same cross-object resolver used everywhere else.
  Tables accept a named-map schema (`{ id: f.int({ required: true }) }`),
  filter methods carry args (`"min:8"`), and table `views[]`
  (expression/sort/hiddenCols) encode via the shared comparison encoder. The
  authoring→stored name mapping mirrors the engine's `Schema::TYPE_MAP`;
  byte-exact vs the full corpus (`schema:table-all/fancy/fancy2/sensitive/view`).
- **System columns & indexes** — `id` (int primary key; set `idType:"uuid"`
  for a uuid key) and `created_at` (`epochms`, `default:"now"`,
  `access:"private"`) auto-inject at the head of the schema unless
  `system:false` or the author already declared them; `db.add`/`db.edit` row
  expansion sees the injected columns too. The matching standard indexes —
  `primary(id)`, `btree(created_at desc)`, plus `gin(xdo)` only when the table
  stores fields as JSON (see `use_xdo` below) — are likewise auto-prepended
  (de-duped by type + covered fields, so author-declared ones aren't doubled);
  declare extras (unique/composite) and the standard set rides along.
  Byte-exact vs `schema:table-sensitive` authored without the explicit meta
  head *or* the explicit index list.
- **`use_xdo` storage mode** — a table either stores every field as JSON under
  the internal `xdo` column (`use_xdo:true`, and the engine adds the `gin(xdo)`
  index) or gives each field a real Postgres column (`use_xdo:false`, no `gin`);
  both read identically since `xdo` is hidden. It's a **workspace** setting
  (`registerWorkspace({ use_xdo })`, default `false`) that each table mirrors as
  its own source of truth. A `table({ useXdo })` overrides per-table; otherwise a
  table inherits the workspace default — resolved at `export()`, so the workspace
  and tables can be registered in any order.

## Statements

The function/query/tool/etc. `stack` is a list of statements. The whole catalog
is reachable through one discoverable, typed namespace — `s`:

```ts
import { s, c, ref, expr } from "@sidestep/core";

stack: [
  s.set_var("total", c.int(0)),
  s.math.add({ name: "total", value: c.int(5) }),
  s.array.find({ as: "hit", expr: ref("items"), if: expr(ref("$this"), "=", c.int(1)) }),
  s.storage.delete_file({ pathname: c.text("tmp/x") }),
  s.conditional({ when: expr(ref("total"), ">", c.int(0)), then: [s.return(ref("total"))] }),
  s.function.run({ fn: getUser, as: "u", input: { id: ref("total") } }),
]
```

Tab-complete `s.` to explore: `s.math.*`, `s.array.*`, `s.text.*`, `s.object.*`,
`s.expect.*`, `s.storage.*`, `s.security.*`, `s.api.*`, `s.cloud.*`, … Each
declarative statement takes one typed args object (field names match the Xano
engine); the control-flow specials (`s.set_var`, `s.conditional`, `s.for`,
`s.foreach`, `s.while`, `s.group`, `s.switch`, `s.try_catch`, `s.return`,
`s.foreach_break`, …) keep their authored signatures. The **call family**
(`s.function.run`/`s.function.call`, `s.api.call`, `s.task.call`,
`s.tool.call`, `s.trigger.call`, `s.middleware.call`, `s.addon.call`) invokes
another workspace object — pass the target's def handle (or name) and sidestep
resolves the cross-object reference at export (see below). The **db family**
(`s.db.add`/`s.db.edit`/`s.db.add_or_edit`/`s.db.get`/`s.db.del`/`s.db.has`/
`s.db.patch`/`s.db.truncate`/`s.db.schema`) reads and mutates records — pass the
target `table` the same way; `s.db.direct_query` runs raw SQL (no table ref).
The single-record reads/mutations **match one field**, not a `where`-expr:
`s.db.get`/`s.db.edit`/`s.db.del`/`s.db.has`/`s.db.patch` take
`{ fieldName, fieldValue }` (`fieldName` defaults to the primary key `id`), while
writes (`s.db.add`/`s.db.edit`/`s.db.add_or_edit`) take a partial `row: { … }`
(or explicit `data` entries) — set only your own fields: the auto-injected
`created_at` already carries `default:"now"`, so don't pass it manually on an
insert (it's redundant), and `id` is engine-assigned. **Only `s.db.query`** takes a `where`/`additionalWhere`
comparison (or an array of them, ANDed) built with `expr(...)` —
`where: expr(col("status"), "=", c.text("published"))` — encoded into the
engine's operand-based search expression; a raw `Value` remains the escape hatch.

**Recommended style:** reach statements through the `s` namespace; the familiar
flat factories (`dbAdd`, `dbQuery`, `setVar`, `mathAdd`, `objectKeys`, …) remain
exported and emit identically, but prefer `s.*` in new code for one consistent,
discoverable surface.

Statements without a typed factory yet are still reachable by name via the
registry escape hatch: `getStatementFactory("mvp:<name>")({ … })`.

Values: `c.int/text/bool/decimal/null/obj/array`, `ref(var)`, `inp(input)`,
`col(name)`, plus the context references `auth(path?)` (the authenticated
identity — `auth("id")` → `$auth.id`), `env(name)` (an environment variable),
and `setting(name)` (a workspace setting). `filter(name, ...args)` /
`withFilters(value, ...filters)` (filters spread or as an array) attach the
value pipeline; it has a typed catalog `fl.*` — `withFilters(inp("email"),
fl.trim(), fl.lower())` — 377 filters generated from the engine's own sources
(`npm run codegen:filters`; 161 carry named, typed args + JSDoc, the rest are
reachable and variadic by name).

**Inputs:** `input.*` fully mirrors the `f.*` catalog — every engine-legal field type
is also a valid function/query input. Scalars
(`input.text/int/decimal/bool/email/password/uuid/date/timestamp/json`,
`input.enum(values)`), files (`input.image/video/audio/attachment`), `input.geo.*`,
`input.vector(size)`, and `input.tableRef(table)` all return a typed descriptor for
the `input` map (e.g. `input.email({ required: true })`). For structured inputs use
`input.object(children)` and `input.list(element)` (an array of any element
constructor) — e.g. `input.list(input.text())` or
`input.list(input.object({ id: f.int() }))`. Prefer these typed forms over
`input.json()` when the shape is known.

**Comparisons** (`expr`/`s.conditional`/`s.while`) use the engine operators
`= != > < >= <=`; the JS forms `== === !==` are accepted and normalized.

## Consuming a query as a contract

A `query()` def is the single source of truth for an endpoint's path and its
inputs — so the code that *calls* the API can reuse it instead of re-typing the
URL and the request body. Import the query def and use it directly:

```ts
import { loginQuery } from "@sidestep/auth";          // a sidestep query() def
import type { InferInput } from "@sidestep/core";

const BASE = "https://x8ki-letl-twmt.n7.xano.io";  // your instance host

async function login(email: string, password: string) {
  const payload = { email, password } satisfies InferInput<typeof loginQuery>;
  return fetch(BASE + loginQuery.getPath(), {        // "/api:<canonical>/auth/login"
    method: loginQuery.verb,                          // "POST"
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
```

- **`loginQuery.getPath()`** returns the **group-relative** path `/api:<canonical>/<name>`.
  You prepend the instance host (sidestep stays out of environment concerns). The
  canonical resolves in order: an explicit `getPath({ canonical })` override, then the
  bound `apiGroup()` handle's in-code `canonical`, then the value minted into
  `xano.lock`. So you have two supported setups:
  - **Set it in code** — `apiGroup({ canonical: "auth" })`. Stable, shareable, and
    resolvable everywhere including a browser bundle.
  - **Let `export --lock` mint it** — run `sidestep export --lock` once (it generates a
    unique canonical and freezes it in `xano.lock`), then seed that lock before reading
    paths: the CLI does this automatically, and a build/codegen script calls
    `seedLockOverrides(readLockFile(path))` first. `getPath()` then returns the minted
    value.

  `getPath()` never mints its own token — canonicals must be unique per Xano **instance
  across all workspaces**, so a call-time value could collide or not match the deployed
  endpoint. With no in-code canonical and no seeded lock it throws (pass
  `getPath({ canonical })` as a last resort). For a browser bundle that reads a
  lock-minted canonical, resolve it at build time in Node (seed the lock, call
  `getPath()`) and emit the resulting string into your generated client — the browser
  has no lock of its own.
- **`InferInput<typeof loginQuery>`** is the request-payload type, derived from the
  query's `input` map at compile time — no codegen, always in sync. Required inputs
  are required keys; `nullable` adds `| null`; `input.list(...)` becomes `T[]`;
  `input.enum([...])` a literal union; `input.object({...})` a nested type. The same
  utility works on a `defineFunction` def (functions share the input system).
- **`InferRow<typeof postTable>`** is the read-side counterpart: the row type of a
  table whose schema is a `FieldMap` (`{ title: f.text(), … }`), derived from the same
  field brands. Every declared column is present (`nullable` adds `| null`, `f.list`
  → `T[]`), plus the auto-injected system columns `id: number` and `created_at: number`.
  Type your response usage against it instead of hand-copying the table, and a column
  rename/retype lights up every consumer — closing the loop `InferInput` opens on the
  request side.

  ```ts
  import type { InferRow } from "@sidestep/core";
  import { post } from "./tables";               // a table({ schema: { … } }) def

  type Post = InferRow<typeof post>;              // { id: number; created_at: number; title: string; … }
  const rows = (await res.json()) as Post[];
  ```

  A table authored with a raw `ColumnDef[]` schema carries no brands, so its row is
  `unknown`. (Response-level inference from a query — `InferResponse<typeof listPosts>`
  — is a planned follow-up; for now derive the row from the table and wrap it as the
  endpoint returns it, e.g. `InferRow<typeof post>[]`.)

**Browser-safe.** The `@sidestep/core` entry has no Node built-in dependencies, so
importing a query def (and its transitive workspace graph) into an Angular/React
bundle just works — `getPath()`/`verb`/`InferInput` are all you need on the client.
The `node:fs`-backed emitters (`writeBundle`, `writeArtifact`, `readLockFile`,
`writeLockFile`) and the programmatic CLI live in the separate **`@sidestep/core/node`**
entry, which a frontend bundle never pulls in.

## Emit & CLI

Emitters that write to disk (and the programmatic CLI) are Node-only — import them
from `@sidestep/core/node`. The string emitters (`emit`, `emitBundle`,
`serializeBundle`) stay on the browser-safe `@sidestep/core` entry.

```ts
import { emitBundle } from "@sidestep/core";        // pure string — browser-safe
import { writeBundle } from "@sidestep/core/node";  // writes a file — Node only
emitBundle(xano);                 // pretty-printed JSON string
writeBundle(xano, "workspace.json");
```

```bash
sidestep export ./xano/index.js              # bundle to stdout
sidestep export ./xano/index.js --out ws.json
sidestep compile ./xano/functions/get-user.js  # a single function's JSON

sidestep export ./xano/index.ts --lock       # opt into xano.lock (created beside the entry)
sidestep export ./xano/index.ts --frozen-lock  # CI guard: fail if the export would change the lock
sidestep lock rename table users members     # move a lock entry after renaming in code
sidestep lock prune ./xano/index.ts --yes    # drop lock entries nothing exports anymore
sidestep lock adopt live-export.json --yes   # seed the lock from a live engine export

sidestep login                               # OAuth sign-in (once) — pick the instance at consent
sidestep push ./xano/index.ts                # compile + import into your sandbox (merges)
sidestep push ./xano/index.ts --reset        # ...clearing the sandbox workspace first (full replace)
sidestep push --bundle ws.json               # upload an already-exported bundle
sidestep logout                              # revoke the refresh token + delete the local cache
```

The CLI imports the module's default export, and **the entry must be an ES
module** — sidestep defs are ESM-only. On Node ≥ 22.6 a `.ts` entry loads directly
via native type-stripping, so `sidestep export ./xano/index.ts` just works when the
entry is ESM. Make it ESM by either setting `"type": "module"` in the nearest
`package.json` or naming the entry `.mts`. (`npm init -y` writes
`"type": "commonjs"`, which pulls a `.ts` entry into the CommonJS graph and fails
with a "must be ES modules" error — set `"type": "module"` to fix it.)

Install [`tsx`](https://tsx.is) (`npm i -D tsx`) for two cases the native loader
doesn't cover: older Node with no `.ts` support, and a multi-file workspace whose
entry imports its own `.js` specifiers that resolve to `.ts` sources. `tsx`
respects the package `type`, so it is **not** a substitute for making the entry
ESM.

When a `xano.lock` sits beside the entry file, `export` (and `compile`) read it
automatically — see [Identity & the lock file](#identity--the-lock-file). The
lock path can be overridden with `--lock=<path>` (the `=` form only), the escape
hatch for a directory with multiple workspace entries.

### Signing in & uploading to a sandbox

`sidestep push` bakes the sandbox upload straight into the CLI, so a starter no
longer needs its own upload script. Authentication is **OAuth** against the Xano
control plane — no static API keys to copy around.

**Sign in once** with `sidestep login`. You pick the target instance at the
hosted consent screen — the CLI binds to whatever you choose:

```bash
sidestep login
```

This runs the standard authorization-code + PKCE browser flow (powered by the
OpenID-certified [`openid-client`](https://github.com/panva/openid-client), the
same library the [sidestep dashboard](https://www.npmjs.com/package/@sidestep/dashboard)
uses): it opens your browser, you approve the request, and the CLI captures the
redirect on a local `127.0.0.1` callback. On first use it **dynamically registers
its own OAuth client** (RFC 7591) whose redirect URI is exactly that loopback
address, so the authorize step never depends on the server tolerating an
arbitrary loopback port; the registration is cached in
`~/.xano/sidestep-clients.json` and reused. If that cached client is ever
rejected (`invalid_client` — e.g. the server forgot the registration), `login`
transparently drops it, re-registers, and retries once. The instance the token
is bound to is read from the token itself (its `aud` claim), so which instance
you're signed in to is always whatever you chose at consent.

The resulting tokens (access + refresh) are cached in a **project-local** file,
`./.xano/auth.json`, which `login` **auto-adds to your `.gitignore`** so
credentials never get committed. Override the cache location with `--auth-file` /
`$XANO_AUTH_FILE`, the OAuth host with `--auth-host` / `$XANO_AUTH_HOST` (default
`https://app.xano.com`), and the loopback port with `--port` (default `47100`).

**Then push:**

```bash
sidestep push ./xano/index.ts                 # compile the workspace + import it (merge)
sidestep push ./xano/index.ts --reset         # ...clear the sandbox workspace first (full replace)
sidestep push --bundle workspace.json         # upload a bundle exported earlier
```

`push <file>` runs the exact same pipeline as `export` (including `xano.lock`
seeding and merge), then `POST`s the bundle to your instance's sandbox import
endpoint (`/api:meta/sandbox/bundle`). `push --bundle <path>` skips the compile
and uploads a bundle a previous `export` wrote — handy in CI where the two steps
are separate. The endpoint returns `{ url, workspace }`: the whole JSON prints to
stdout (so `sidestep push --bundle ws.json > result.json` captures it), and the
sandbox's public `url` is echoed to stderr for convenience.

**`--reset` — merge vs. replace.** By default the bundle is imported **on top of**
the sandbox workspace (a merge/upsert), so objects you removed from code linger
in the sandbox. Pass `--reset` to fully **clear the sandbox workspace first**, so
the bundle replaces it wholesale (sent as `?reset=true`). The clear and the
import run in a single transaction, so a failed import can never leave the sandbox
wiped. Use `--reset` when you want the sandbox to exactly mirror your code.

`push` reuses the cached tokens and **refreshes them automatically** when the
access token has expired (Xano rotates the refresh token on every use, and the
new one is persisted for you). If a refresh is rejected because the session was
revoked or expired (`invalid_grant`), `push` clears the stale cache and tells you
to run `sidestep login` again rather than retrying a spent token. The target
instance is always the one your cached token is bound to (chosen at `login`).

**Sign out** with `sidestep logout`. It best-effort **revokes** the refresh token
at the Xano control plane (so a leaked cache file can't be replayed) and then
deletes the project-local `./.xano/auth.json`. A revocation that fails at the
server never blocks the local delete — your credentials are removed from disk
either way. Point it at a non-default cache with `--auth-file` / `$XANO_AUTH_FILE`.

**CI and agents** can't open a browser, so `push` runs fully non-interactively
from two env vars — `$XANO_REFRESH_TOKEN` and `$XANO_CLIENT_ID` (both copied once
from `./.xano/auth.json` after a local `sidestep login`; a refresh token can only
be exchanged by the client that minted it, hence both). `push` exchanges them for
an access token — no cache file or browser needed:

```bash
XANO_REFRESH_TOKEN=… XANO_CLIENT_ID=… sidestep push --bundle ws.json
```

The target instance is read from the refresh token itself (its `aud`), so CI
pushes to whatever instance the token was minted for — no instance flag needed.

> **Automated agents:** authenticate with `$XANO_REFRESH_TOKEN` + `$XANO_CLIENT_ID`
> + `push`; do **not** invoke `sidestep login`, which blocks on an interactive
> browser consent no agent can complete. Xano rotates refresh tokens on use, so a
> stored `$XANO_REFRESH_TOKEN` may be single-use — mint one per job if exchanges
> fail. In a headless shell where `login` *is* run by a human over SSH, set
> `XANO_NO_BROWSER=1` to suppress the browser spawn and open the printed authorize
> URL manually.

> ⚠️ **`push` writes to your live sandbox and is non-permanent.** It imports into
> the **sandbox tenant** of your live instance — a fast dev-loop convenience, not
> a production deploy. `--reset` additionally **clears the sandbox workspace**
> before importing, discarding whatever was there. **Automated agents must ask
> for explicit confirmation before running `sidestep push`** — never run it
> unattended, and treat `--reset` as especially destructive.

## Agent grounding

sidestep ships two machine-readable descriptions of its whole authoring surface so
an agent can learn the SDK without reading the source:

- **`manifest.json`** — every object kind (factory, `Xano.register*` method,
  payload key), every statement surface (the `s.<path>` accessor, stored
  `mvp:` name, and a typed field schema for the 154 declarative statements), the
  value constructors, the tag catalog, and the filter catalog — plus live
  coverage counts.
- **`llms.txt`** — the same surface rendered as a concise plaintext grounding
  doc.

Both are derived from the SDK's own sources of truth (so they can't drift) and
regenerated with `npm run manifest`; a test fails if the committed files fall out
of sync. The same data is available at runtime:

```ts
import { buildManifest, renderLlmsTxt } from "@sidestep/core";
const manifest = buildManifest();        // the structured surface description
const grounding = renderLlmsTxt(manifest); // the llms.txt string
```

## Coverage & scope

sidestep emits only (the engine imports/executes). Fidelity is proven by deep-equal
against the real Xano engine golden fixtures, and a coverage report prints
progress on every test run.

**Status:**

| Surface | Coverage |
|---|---|
| Object kinds | **11 / 24** — `function`, `table`, `query`, `api_group`, all 6 `trigger`s, `tool`, `toolset`/`agent`, `task`, `middleware`, `addon`, `workspace` |
| Statements (reachable via `s`) | **214 / 214** (100%) — every engine statement surface has a factory; 154 codegen'd declarative + the hand-authored control-flow / call / db / ai / cloud / misc specials |

The statement catalog is generated from the engine's own schema YAMLs by a
schema-driven codegen pipeline (`npm run codegen` → `src/statements/generated/`),
with the non-declarative remainder hand-authored. Per-statement fidelity that
can't be derived from the schema (the `output` flag, the envelope tier) is
**pinned from the golden fixtures**; statements without a fixture are reachable
but not yet byte-verified.

**Reachable ≠ byte-verified.** All 214 surfaces are authorable, but the
specials that have no persisted golden yet (the structural specials —
`db.bulk*`/`db.query`/external SQL, `ai.agent.run`, `cloud.job*`,
`array.map`/`union`, `action.call`, `service.function.run`,
`workflow_test.call`, realtime/auth/raw-input, …) emit a shape *modeled* on the
engine schema, to be deep-equal'd against fixtures as they're vendored.
`db.transaction` and `util.post_process` are byte-verified (parser-minimal,
incl. their run-stack children); see `test/statements/substacks.test.ts`. The
214/214 counts authoring surfaces; the deep-equal-proven subset is smaller (see
the per-statement notes in `src/statements/special/`).

**Identity & sync.** Every top-level object carries a stable `guid` — the field
Xano uses as its identity anchor. On a sync import the engine matches an incoming
object to an existing one **by guid** and updates it in place; no match means a
new object. So re-running `export` on the same code maps cleanly onto the same
workspace (no duplicates). By default the guid is derived from the object's
`name`; set an explicit `guid` on any def to **pin identity across a rename**, or
to **match an object in an existing Xano workspace** you're adopting into code
(the guid column is plain text, so any stable string works):

```ts
defineFunction({ guid: "fn_get_user", name: "get_user", ... });
// rename `name` later — the guid (identity) stays, so the sync still updates it
```

**Cross-object references** (a `function.run`/`db.get`/query→`apiGroup`/a
`trigger.table({ table })`/… pointing at another object) ride the same
mechanism: the reference resolves to the target's guid — its explicit `guid` if
set, else the name-derived one — so the import remaps both sides together. Pass
the target's **def handle** (it carries the guid) rather than a bare name when
the target sets an explicit guid (`src/refs/guid.ts`).

Because the name-derived guid ignores fields like a query's `verb`, two objects
of the same kind with the same name (e.g. a `GET /posts` and a `POST /posts`
both named `posts`) would resolve to the **same** guid. `export()` detects any
such collision and throws — name same-path endpoints distinctly (`list_posts`,
`create_post`) or pin an explicit `guid`.

### Identity & the lock file

Per-object explicit `guid`s pin identity one def at a time. The opt-in
**`xano.lock`** freezes the whole workspace's identities at once — every
auto-derived guid, plus the `canonical` URL tokens of api groups and toolsets
(which the engine otherwise randomizes at creation, giving the same code
different public URLs per environment). Create it once with
`sidestep export --lock`; from then on it's read automatically and updated on
every export (new objects appended, written atomically before the bundle).
Commit it next to your code.

Precedence at emit is always **explicit in-code value → lock entry → name
derivation**. The lock records explicit values too, so deleting an explicit
`guid` from code later resolves through the lock to the same identity instead
of silently reverting to the name derivation.

**Renames.** With a lock, a rename in code no longer has to mean delete+create
on sync. The export warns about the orphaned entry and names the fix-up:

```bash
mv code: defineFunction({ name: "signup" }) → { name: "register" }
sidestep export ./xano/index.ts   # stderr: lock entry "function:signup" matches no exported object…
sidestep lock rename function signup register
sidestep export ./xano/index.ts   # emits signup's original guid under "register" → engine renames in place
```

Orphaned entries are never auto-matched to new objects — `sidestep lock prune`
removes them once you confirm the object is really gone (a pruned canonical's
public URL is unrecoverable, so prune asks for `--yes`).

**Adopting a live workspace.** `sidestep lock adopt <bundle.json>` seeds the lock
from a real engine `packageExport` — capturing the live workspace's random
guids (and canonicals, when present) by `(type, name)` so code can take over an
existing workspace and the first sync updates in place instead of duplicating.
Two caveats: the engine's standard partial export **strips canonicals** (adopt
warns when none are found — existing URLs are still safe, because guid-matched
updates keep the server-side canonical), and a live bundle can contain **`vault`
entries (secrets)** — don't commit the bundle file; adopt warns about that too.

**CI.** `sidestep export --frozen-lock` fails instead of changing the lock — use
it in CI so a canonical minted there (which would be discarded with the
container) can never silently diverge public URLs. Mint locally, commit the
lock.

Scope of the promise: the lock freezes the *existing* identity scheme — it does
not add finer-grained identity (a query's identity still ignores its `verb`),
and its guarantees apply to the partial/sync import path (full imports
regenerate guids engine-side). Canonical parity holds across instances or
non-colliding workspaces; canonicals are unique per **instance**, so importing
one lock into two workspaces on the same instance keeps the URL on the first
and the engine self-heals the second with a regenerated token.
<!-- @TODO(verify): live round-trip of rename-syncs-as-update, adopt-avoids-duplicate-sync,
     and workspace-canonical provisioning semantics (provisionWorkspace collision path). -->

The programmatic surface is exported from the package index (`readLockFile`,
`seedLockOverrides`, `createLockContext`, `mergeObserved`, `renameLockEntry`,
`adoptFromBundle`, …). The one contract that matters: **seed before any def
module is evaluated, once per process** — references bake guids at authoring
time, so seeding after your defs have loaded is a silent no-op (the CLI always
seeds correctly; `resetLockOverrides` exists for tests).

### What's left

- **Byte-verify the structural specials** — every statement surface is now
  authorable, but the specials shipped without a golden (listed above) carry a
  *modeled* shape. As fixtures are vendored, promote each to a deep-equal test
  and correct any shape drift (context-vs-input placement, envelope tier, the
  api.call `headers`/`auth`/`verb` blocks).
- **`sig` byte-exactness** — implemented (`base64url(sha1(...))`); verified at the
  first real engine import (no signed-bundle fixture exists to deep-equal yet).

### Deferred (follow-up, by design)

Folder auto-discovery (scan `xano/**` without explicit registration),
round-trip/decompile (bundle JSON → TS), live-instance push/deploy via the
metadata API, and the `workflow_test` / `service` / `vault` / `branch` payload
sections (emitted as empty arrays until authored kinds exist).

### Out of scope

Reimplementing the engine's XanoScript parser, executing objects at runtime
(sidestep only compiles), and generating engine-side numeric ids/timestamps.
(Object guids and canonicals *are* handled — deterministically derived or
frozen via `xano.lock`; see [Identity & the lock file](#identity--the-lock-file).)
