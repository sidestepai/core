<div align="center">

# SideStep

### Your Xano backend, as TypeScript. Deployed to a live sandbox in one command.

**Write your database, APIs, functions, triggers, and AI agents in typed TypeScript.
Then push the whole thing — plus an optional static frontend — to a disposable Xano
sandbox with a single deploy.**

</div>

```bash
# One command. Backend + frontend. Live in your sandbox.
sidestep sandbox deploy ./xano/index.ts --static ./dist
```

```
→ Deploying ./xano/index.ts → sandbox (merge)
✓ Backend deployed
    https://x8ki-letl.n7.xano.io                                  ← backend, live
→ Deploying static frontend ./dist
✓ Static host deployed
    https://my-app.xano.io                                        ← frontend, live
```

<div align="center">

No export/import dance. No upload script. No CI glue between your API and your app.
Your TypeScript is the source of truth, and one command puts it on real Xano
infrastructure you can hit immediately.

```bash
npm install @sidestep/core
```

[Deploy it](#deploy-it-backend--frontend-one-command) ·
[The model](#the-model-typescript-in-real-infrastructure-out) ·
[Quickstart](#60-second-quickstart) ·
[Type-safe frontend](#the-payoff-a-type-safe-frontend-for-free) ·
[Reference](#reference)

</div>

---

## Why SideStep

Xano gives you a genuinely scalable backend — Postgres, serverless functions, background
tasks, realtime, MCP servers, AI agents — without you running a single server. SideStep
gives you that backend **as code you own**:

- **📦 TypeScript is the source of truth.** Your whole workspace — tables, indexes, API
  endpoints, functions, triggers, tasks, middleware, AI toolsets — is typed TS in your
  repo. Version it, review it in PRs, diff it, roll it back. No more clicking through a
  dashboard and hoping prod matches staging.

- **🚀 Deploy is built in.** `sidestep sandbox deploy` compiles your code and ships it
  straight to your live Xano sandbox over an authenticated connection. No export/import
  dance, no upload script to maintain. Backend **and** static frontend in one command.

- **⚡ Fast, safe iteration.** The sandbox is disposable, so you can rebuild it as often
  as you like. Deploys are identity-stable — re-running never duplicates objects, and
  with a committed `xano.lock` renames stay renames instead of delete-and-recreate.

- **🧩 The types flow to your frontend.** Import a `query()` def into your React/Angular
  app and get the endpoint path, HTTP verb, and a fully-typed request payload — with
  **zero codegen**. Rename a column and every consumer lights up red.

- **🏗️ Highly scalable, zero ops.** You write intent; Xano runs the infrastructure.
  Autoscaling compute, managed Postgres, edge-served static hosting. You never touch a
  Dockerfile.

- **🤖 AI-first by design.** A deterministic, fully-typed authoring surface — an agent (or
  you) emits well-typed TS that always compiles to a valid, importable workspace. Ships
  with machine-readable grounding (`manifest.json`, `llms.txt`) so agents learn the whole
  SDK without reading source.

---

## Deploy it: backend + frontend, one command

The **sandbox** is SideStep's deploy target: a disposable Xano workspace attached to your
account, meant to be written to constantly while you build. Most stacks make you deploy
your API and your app through two separate pipelines. SideStep collapses that into **one
command** — point `--static` at your built frontend and it archives and uploads it to the
sandbox's edge-served static host, right after the backend import, in the same run:

```bash
# 1. Get the sandbox's backend base URL (stable per account) and bake it into the
#    build. `sandbox details` prints the sandbox tenant URL your APIs live at.
BASE=$(npx sidestep sandbox details | jq -r .baseUrl)

# 2. Build your app against it. The env-var NAME is your framework's convention
#    (Vite shown); the VALUE is the sandbox base URL from step 1.
VITE_XANO_HOST="$BASE" npm run build                   # → ./dist, pointed at the sandbox

# 3. Ship backend + frontend, live, together.
npx sidestep sandbox deploy ./xano/index.ts --static ./dist
```

```
→ Deploying ./xano/index.ts → sandbox (merge)
✓ Backend deployed
    https://x8ki-letl.n7.xano.io/tenant/sbx-ab12                      ← backend, live
→ Deploying static frontend ./dist
✓ Static host deployed
    https://my-app.xano.io                                            ← frontend, live
```

One authenticated call ships your database schema, your APIs, your functions and
triggers, **and** your compiled web app. No separate frontend host to configure, no CI
glue wiring the two together.

> **Wiring the frontend to the backend.** The compiled app needs the sandbox's backend
> URL baked in *at build time*, so fetch it first with `sidestep sandbox details` (the
> `baseUrl` field) and pass it to your build as an env var — as in step 1–2 above. That
> `baseUrl` is the **sandbox tenant** URL your deployed APIs answer at; it is *not* the same
> as `sidestep profile me`, which prints your account's instance origin. The sandbox is a
> singleton per account, so its `baseUrl` is stable — fetch it once and reuse it.

**Two modes**, so you're always in control:

| Command | What it does |
|---|---|
| `sandbox deploy` | Upserts everything **in place** by identity — the bundle merges into the sandbox workspace. Safe to re-run. The default. |
| `sandbox deploy --reset` | **From-scratch rebuild** — clears the sandbox workspace (objects *and* records) first, then imports. Recovery is just a re-deploy (git is your source of truth). |

Deploys are **authenticated over OAuth** — sign in once, and the CLI refreshes tokens
automatically. The target instance comes from your token (never a stray flag), and the CLI
prints what it's about to do before it touches anything.

**CI & agents** run fully headless from two env vars — no browser needed:

```bash
XANO_REFRESH_TOKEN=… XANO_CLIENT_ID=… npx sidestep sandbox deploy --bundle ws.json
```

> ⚠️ `--reset` clears the sandbox workspace, including its table records, before importing.
> The blast radius is your own disposable sandbox — but anything you only ever created by
> hand in it (or any data it accumulated) is gone. Leave `--reset` off for the normal
> merge-in-place loop.

---

## The model: TypeScript in, real infrastructure out

You author declarative def-objects, register them on one `Xano` instance, and SideStep
compiles the whole thing into Xano's importable bundle.

```ts
import { workspace, table, query, apiGroup, f, s, ref, c, expr, col } from "@sidestep/core";

// A database table — `id` + `created_at` auto-inject, so declare only your own columns.
const user = table({
  name: "user",
  auth: true,
  schema: {
    email: f.email({ required: true, methods: ["trim", "lower"] }),
    name:  f.text(),
  },
});

const post = table({
  name: "post",
  schema: {
    title:     f.text({ required: true }),
    body:      f.text(),
    published: f.bool({ default: false }),
    author:    f.tableRef(user),          // a real foreign key, type-checked
  },
});

// A public API group + endpoint. This query def is also the contract your frontend imports.
const blog = apiGroup({ name: "blog", canonical: "blog" });

const listPosts = query({
  verb: "GET",
  apiGroup: blog,
  name: "list_posts",
  stack: [
    s.db.query({ table: post, where: expr(col("published"), "=", c.bool(true)), as: "rows" }),
  ],
  response: ref("rows"),
});

export default workspace("blog")
  .registerApiGroups([blog])
  .registerTables([user, post])
  .registerQueries([listPosts]);
```

Tab-complete `s.` to discover the entire statement catalog — `s.db.*`, `s.math.*`,
`s.array.*`, `s.text.*`, `s.storage.*`, `s.api.*`, `s.cloud.*`, control flow, AI agent
runs, and more. **All 214 engine statement surfaces are authorable** — every field name
matches the Xano engine, and the output is proven byte-for-byte against the engine's own
golden fixtures.

---

## 60-second quickstart

```bash
# 1. Install
npm install @sidestep/core
npm i -D tsx                       # lets the CLI run your .ts entry directly

# 2. Write your workspace in TypeScript
#    xano/index.ts  →  export default workspace("my-app")...

# 3. Sign in once (OAuth — no API keys to copy around)
npx sidestep login                 # opens your browser; you pick the instance

# 4. Deploy to your sandbox — this is the dev loop
npx sidestep sandbox deploy ./xano/index.ts

# 5. Ship a built frontend alongside it — point it at the sandbox backend first
BASE=$(npx sidestep sandbox details | jq -r .baseUrl)   # the sandbox's backend URL
VITE_XANO_HOST="$BASE" npm run build                    # bake it into ./dist
npx sidestep sandbox deploy ./xano/index.ts --static ./dist
```

That's the whole loop: **install → write TypeScript → login → deploy.** No dashboards, no
manual imports, no upload scripts.

> The entry must be an ES module (SideStep defs are ESM-only). On Node ≥ 22.6 a `.ts`
> entry loads natively; install [`tsx`](https://tsx.is) for older Node or multi-file
> workspaces. Set `"type": "module"` in the nearest `package.json` if you hit a
> "must be ES modules" error.

---

## The payoff: a type-safe frontend, for free

Because your API is a typed def, the code that *calls* it can reuse that def instead of
re-typing URLs and request bodies. Import the `query()` into your frontend:

```ts
import { listPosts } from "../xano/index.js";          // the same def you deployed
import { post } from "../xano/tables.js";
import type { InferRow } from "@sidestep/core";

const BASE = "https://x8ki-letl.n7.xano.io";           // your instance host

type Post = InferRow<typeof post>;                     // { id: number; created_at: number; title: string; … }

async function fetchPosts(): Promise<Post[]> {
  const res = await fetch(BASE + listPosts.getPath(), { method: listPosts.verb });
  return res.json();                                   // typed end to end
}
```

- **`listPosts.getPath()`** → the endpoint path, resolved from your code (or the frozen
  `xano.lock`). No hardcoded strings.
- **`listPosts.verb`** → the HTTP method, straight from the def.
- **`InferInput<typeof someQuery>`** → the request-payload type, derived from a query's
  `input` map at compile time. Required inputs are required keys; enums become literal
  unions; nested objects and lists carry through. **No codegen, always in sync.**
- **`InferRow<typeof post>`** → the table's row type. Rename or retype a column and every
  consumer breaks at compile time — exactly where you want it.

The `@sidestep/core` entry has **zero Node dependencies**, so importing your workspace
graph into a browser bundle just works. The `node:fs`-backed emitters live in the
separate `@sidestep/core/node` entry a frontend never pulls in.

---

## Reference

<details open>
<summary><b>Project structure</b></summary>

Lay objects out however you like and register them explicitly — there's no folder
auto-discovery magic (deliberately):

```
xano/
├── functions/   get-user.ts        export default defineFunction({...})
├── tables/      user.ts            export default table({...})
├── triggers/    on-insert.ts       export default trigger.table({...})
├── toolsets/    assistant.ts       export default agent({...})
└── index.ts     workspace("my-app").registerTables([...]).registerFunctions([...])…
```

`workspace("my-app")` is the natural entry point — sugar for
`new Xano().registerWorkspace({ name: "my-app" })`, returning the same chainable registry.
Authoring is **declarative def-objects** passed to factories; there is no callback/chaining
builder. `xano.export()` returns the importable `packageExport` bundle, and
`sidestep export`/`deploy` read the module's default export.

</details>

<details>
<summary><b>Object kinds</b></summary>

Every top-level Xano object is a registered kind with a factory and a `Xano.register*`
method. Payload keys use the engine's singular names.

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

**Triggers** — all six types share one envelope discriminated by `obj_type` + a per-type
`meta`: `trigger.table` (db), `trigger.realtime`, `trigger.mcpServer`, `trigger.agent`,
`trigger.workspace`, `trigger.error`.

**Toolsets — AI vs MCP** — `toolset.mcp({ name, tools })` exposes tools over the MCP
protocol; `agent({ name, agentSettings: { type: "anthropic", model, system_prompt }, tools })`
is an LLM orchestrator. A `tool({...})` is its own kind — a function-like operation a
toolset references.

</details>

<details>
<summary><b>Tables &amp; fields</b></summary>

**Field types** — a typed catalog `f.*` covers the full surface: scalars
(`f.text`/`f.int`/`f.decimal`/`f.bool`/`f.uuid`/`f.date`/`f.email`/`f.password`/`f.json`),
`f.timestamp`, the four file resources (`f.image`/`f.video`/`f.audio`/`f.attachment`), the
six `f.geo.*` types, `f.enum(values)`, `f.vector(size)`, and `f.object(children)`. Foreign
keys are `f.tableRef(table)` — an `int` (or `{ type: "uuid" }`) column whose link resolves
to the target table's guid at export. Tables accept a named-map schema
(`{ email: f.email({ required: true }) }`), filter methods carry args (`"min:8"`), and
`views[]` (expression/sort/hiddenCols) encode via the shared comparison encoder. Byte-exact
vs the engine's `Schema::TYPE_MAP`.

**System columns & indexes** — `id` (int primary key; `idType:"uuid"` for a uuid key) and
`created_at` (`epochms`, `default:"now"`, `access:"private"`) auto-inject at the head of
the schema unless `system:false` or you declared them. The matching standard indexes
(`primary(id)`, `btree(created_at desc)`, plus `gin(xdo)` only when the table stores fields
as JSON) auto-prepend, de-duped so author-declared ones aren't doubled.

**`use_xdo` storage mode** — a table either stores every field as JSON under the internal
`xdo` column (`use_xdo:true`, adds the `gin(xdo)` index) or gives each field a real Postgres
column (`use_xdo:false`). It's a workspace setting (`registerWorkspace({ use_xdo })`,
default `false`) each table mirrors; `table({ useXdo })` overrides per-table. Resolved at
`export()`, so workspace and tables register in any order.

</details>

<details>
<summary><b>Statements, values &amp; inputs</b></summary>

The `stack` of a function/query/tool is a list of statements, all reachable through one
discoverable, typed namespace — `s`:

```ts
import { s, c, ref, expr } from "@sidestep/core";

stack: [
  s.set_var("total", c.int(0)),
  s.math.add({ name: "total", value: c.int(5) }),
  s.array.find({ as: "hit", expr: ref("items"), if: expr(ref("$this"), "=", c.int(1)) }),
  s.conditional({ when: expr(ref("total"), ">", c.int(0)), then: [s.return(ref("total"))] }),
  s.function.run({ fn: getUser, as: "u", input: { id: ref("total") } }),
]
```

Tab-complete `s.` to explore: `s.math.*`, `s.array.*`, `s.text.*`, `s.object.*`,
`s.expect.*`, `s.storage.*`, `s.security.*`, `s.api.*`, `s.cloud.*`, … Each declarative
statement takes one typed args object; control-flow specials (`s.set_var`, `s.conditional`,
`s.for`, `s.foreach`, `s.while`, `s.group`, `s.switch`, `s.try_catch`, `s.return`, …) keep
their authored signatures.

The **call family** (`s.function.run`, `s.api.call`, `s.task.call`, `s.tool.call`, …)
invokes another workspace object — pass the target's def handle (or name) and SideStep
resolves the cross-object reference at export. The **db family** (`s.db.add`/`s.db.edit`/
`s.db.get`/`s.db.query`/`s.db.del`/…) reads and mutates records. Single-record
reads/mutations match one field (`{ fieldName, fieldValue }`, defaulting to `id`); writes
take a partial `row: { … }`; only `s.db.query` takes a `where` comparison built with
`expr(...)`.

**Values** — `c.int/text/bool/decimal/null/obj/array`, `ref(var)`, `inp(input)`,
`col(name)`, plus context refs `auth(path?)`, `env(name)`, `setting(name)`.
`withFilters(value, ...filters)` attaches the value pipeline via a typed catalog `fl.*`
(377 filters generated from the engine's own sources).

**Inputs** — `input.*` mirrors `f.*` exactly: every engine-legal field type is a valid
function/query input. Use `input.object(children)` and `input.list(element)` for structured
shapes. **Comparisons** use `= != > < >= <=` (JS `== === !==` are normalized).

</details>

<details>
<summary><b>CLI</b></summary>

```bash
sidestep export ./xano/index.ts              # bundle to stdout
sidestep export ./xano/index.ts --out ws.json
sidestep compile ./xano/functions/get-user.ts  # a single function's JSON

sidestep export ./xano/index.ts --lock       # opt into xano.lock (created beside the entry)
sidestep export ./xano/index.ts --frozen-lock  # CI guard: fail if the export would change the lock
sidestep lock rename table users members     # move a lock entry after renaming in code
sidestep lock prune ./xano/index.ts --yes    # drop lock entries nothing exports anymore
sidestep lock adopt live-export.json --yes   # seed the lock from a live engine export

sidestep login                               # OAuth sign-in (once) — pick the instance at consent
sidestep sandbox deploy ./xano/index.ts      # compile + import into your sandbox (the dev loop)
sidestep sandbox deploy ./xano/index.ts --reset            # clear the sandbox first, then import
sidestep sandbox deploy ./xano/index.ts --static ./dist    # also deploy a static frontend
sidestep sandbox deploy --bundle ws.json     # deploy an already-exported bundle
sidestep sandbox details                     # print the sandbox base URL + tenant details (JSON)
sidestep profile me                          # print the scoped user + instance base URL (JSON)
sidestep logout                              # revoke the refresh token + delete the local cache
```

Emitters that write to disk (and the programmatic CLI) are Node-only — import them from
`@sidestep/core/node`. The string emitters (`emit`, `emitBundle`, `serializeBundle`) stay
on the browser-safe `@sidestep/core` entry.

```ts
import { emitBundle } from "@sidestep/core";        // pure string — browser-safe
import { writeBundle } from "@sidestep/core/node";  // writes a file — Node only
```

</details>

<details>
<summary><b>Signing in &amp; deploying (in depth)</b></summary>

**Sign in once** with `sidestep login`. It runs the standard authorization-code + PKCE
browser flow (powered by the OpenID-certified [`openid-client`](https://github.com/panva/openid-client)):
opens your browser, you approve, and the CLI captures the redirect on a `127.0.0.1`
callback. On first use it dynamically registers its own OAuth client (RFC 7591) so the
authorize step never depends on the server tolerating an arbitrary loopback port; the
registration is cached in `~/.xano/sidestep-clients.json`. The instance you're bound to is
read from the token's own `aud` claim.

Tokens (access + refresh) cache in a **project-local** `./.xano/auth.json`, which `login`
**auto-adds to `.gitignore`**. Override with `--config`/`$XANO_CONFIG`, the OAuth host with
`--origin`/`$XANO_ORIGIN`, and the loopback port with `--port`.

**Global credentials** — pass `--global` to `login` to cache tokens in a **shared**
`~/.sidestep/auth.json` instead, reusable from any project directory. Every other command
resolves credentials **project-local first, global as a fallback**: it uses `./.xano/auth.json`
when present, otherwise `~/.sidestep/auth.json` — so a single `sidestep login --global` covers
directories that have no local cache. An explicit `--config`/`$XANO_CONFIG` always wins over both.

`sandbox deploy <file>` runs the exact same pipeline as `export` (including `xano.lock`
seeding and merge), then `POST`s the bundle to `/api:meta/sandbox/bundle` (`?reset=true`
with `--reset`). `sandbox deploy --bundle <path>` skips the compile and uploads a bundle a
previous `export` wrote (handy in CI). A **projected, secret-free summary** prints to stdout
as JSON — `baseUrl` plus the workspace `id`/`name`, and the static URL when `--static` is
used — while the human-readable progress (and the live URLs) echoes to stderr. The raw
workspace blob is deliberately never dumped: it carries per-tenant secrets that must not land
in shell history or CI logs.

**Where it goes** — the sandbox workspace of the instance your **token is bound to**
(the token's `aud`), never a flag. `deploy` never creates or selects any other workspace,
and there is no deploy path to a real workspace.

**Static host** — `sandbox deploy --static <dir>` archives a directory and deploys it to a
static host after the backend import. It targets your **own (parent) workspace**, not the
sandbox: the sandbox tenant does not serve static hosting, so the frontend lives on your
real workspace. The CLI resolves which workspace from your token (`GET /api:meta/auth/me` —
the scoped workspace guid mapped to its numeric id) and uploads the archive to
`/api:meta/workspace/{id}/static_host/default/build` with your ordinary bearer. That route
auto-creates the `default` host and **auto-deploys to `dev`**, returning the live URL — so
the static step is independent of the backend deploy (the backend still runs first because
it's the primary action).

Pair it with `sidestep sandbox details`, which prints the **sandbox's own base URL**
(`GET /api:meta/sandbox/me`, projected to JSON) an agent can bake into the frontend's API
config before building and uploading — no need to re-run a deploy just to recover the URL.
(`sidestep profile me` prints the *instance* base URL, i.e. the account's origin rather than
the sandbox tenant.) A static failure after a committed backend deploy **does not roll
back**: it exits with code `3` and a resumable message telling you to re-run with `--static`
to retry just that step.

`deploy` reuses cached tokens and **refreshes them automatically** when the access token
expires (Xano rotates the refresh token on every use; the new one is persisted). A rejected
refresh (`invalid_grant`) clears the stale cache and tells you to `sidestep login` again.

**CI & agents** run non-interactively from `$XANO_REFRESH_TOKEN` + `$XANO_CLIENT_ID` (both
copied once from `./.xano/auth.json` after a local `sidestep login`). The target instance
is read from the refresh token's `aud`.

> **Automated agents:** authenticate with `$XANO_REFRESH_TOKEN` + `$XANO_CLIENT_ID`; do
> **not** invoke `sidestep login` (it blocks on interactive browser consent). Xano rotates
> refresh tokens on use, so a stored one may be single-use — mint one per job if exchanges
> fail. `sandbox deploy` writes to the user's disposable sandbox, so it's fine to run in a
> loop; just be aware `--reset` clears that sandbox before importing.

</details>

<details>
<summary><b>Identity &amp; the <code>xano.lock</code> file</b></summary>

Every top-level object carries a stable `guid` — Xano's identity anchor. On a sync import
the engine matches an incoming object to an existing one **by guid** and updates it in
place; no match means a new object. So re-running `export`/`deploy` on the same code maps
cleanly onto the same workspace — **no duplicates**. By default the guid derives from the
object's `name`; set an explicit `guid` to pin identity across a rename, or to adopt an
existing workspace object into code.

The opt-in **`xano.lock`** freezes the whole workspace's identities at once — every
auto-derived guid, plus the `canonical` URL tokens of API groups and toolsets (which the
engine otherwise randomizes, giving the same code different public URLs per environment).
Create it once with `sidestep export --lock`; from then on it's read automatically and
updated on every export (written atomically before the bundle). **Commit it next to your
code.**

Precedence at emit is always **explicit in-code value → lock entry → name derivation**.

**Renames** — with a lock, a rename in code no longer means delete+create on sync. The
export warns about the orphaned entry and names the fix-up:

```bash
# code: defineFunction({ name: "signup" }) → { name: "register" }
sidestep export ./xano/index.ts             # stderr: lock entry "function:signup" matches no exported object…
sidestep lock rename function signup register
sidestep export ./xano/index.ts             # emits signup's original guid under "register" → engine renames in place
```

**Adopting a live workspace** — `sidestep lock adopt <bundle.json>` seeds the lock from a
real engine `packageExport`, capturing the live workspace's random guids by `(type, name)`
so code takes over an existing workspace and the first sync updates in place instead of
duplicating.

**CI** — `sidestep export --frozen-lock` fails instead of changing the lock, so a canonical
minted in a throwaway container can never silently diverge public URLs. Mint locally, commit
the lock.

</details>

<details>
<summary><b>Agent grounding</b></summary>

SideStep ships two machine-readable descriptions of its whole authoring surface so an agent
can learn the SDK without reading source:

- **`manifest.json`** — every object kind (factory, `Xano.register*` method, payload key),
  every statement surface (the `s.<path>` accessor, stored `mvp:` name, and a typed field
  schema for the 154 declarative statements), the value constructors, the tag catalog, and
  the filter catalog — plus live coverage counts.
- **`llms.txt`** — the same surface rendered as a concise plaintext grounding doc.

Both derive from the SDK's own sources of truth (so they can't drift), regenerate with
`npm run manifest`, and are available at runtime via `buildManifest()` / `renderLlmsTxt()`.

</details>

<details>
<summary><b>Coverage &amp; scope</b></summary>

SideStep emits only (the engine imports/executes). Fidelity is proven by deep-equal against
the real Xano engine golden fixtures, and a coverage report prints on every test run.

| Surface | Coverage |
|---|---|
| Object kinds | **11 / 24** — `function`, `table`, `query`, `api_group`, all 6 `trigger`s, `tool`, `toolset`/`agent`, `task`, `middleware`, `addon`, `workspace` |
| Statements (via `s`) | **214 / 214 (100%)** — every engine statement surface has a factory |

The statement catalog is generated from the engine's own schema YAMLs (`npm run codegen`),
with the non-declarative remainder hand-authored. **Reachable ≠ byte-verified**: all 214
surfaces are authorable, but structural specials without a persisted golden yet
(`db.query`/external SQL, `ai.agent.run`, `cloud.job*`, `array.map`/`union`, …) emit a
shape *modeled* on the engine schema, to be deep-equal'd against fixtures as they're
vendored.

**Out of scope** — reimplementing the engine's XanoScript parser, executing objects at
runtime (SideStep only compiles), and generating engine-side numeric ids/timestamps.
(Object guids and canonicals *are* handled — deterministically derived or frozen via
`xano.lock`.)

**Deferred (by design)** — folder auto-discovery, round-trip/decompile (bundle → TS), and
the `workflow_test` / `service` / `vault` / `branch` payload sections.

</details>

---

<div align="center">

**Write TypeScript. Run `sidestep sandbox deploy`. See it live.**

See [`@sidestep/auth`](https://www.npmjs.com/package/@sidestep/auth) for a real,
reusable extension package · [`llms.txt`](llms.txt) for the full authoring surface ·
MIT licensed

</div>
