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
✓ Backend deployed to sandbox my-app
    https://x8ki-letl.n7.xano.io                                  ← backend, live
→ Deploying static frontend ./dist → workspace #9
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
# Build once, then ship backend + frontend together. The deploy wires the
# backend URL into the frontend for you — no need to know it before building.
npm run build                                          # → ./dist
npx sidestep sandbox deploy ./xano/index.ts --static ./dist
```

```
→ Deploying ./xano/index.ts → sandbox (merge)
✓ Backend deployed to sandbox sbx-ab12
    https://x8ki-letl.n7.xano.io/tenant/sbx-ab12                      ← backend, live
→ Deploying static frontend ./dist → workspace #9
✓ Config injected into index.html: window.XANO_HOST                   ← backend URL, wired in
✓ Static host deployed
    https://my-app.xano.io                                            ← frontend, live
```

One authenticated call ships your database schema, your APIs, your functions and
triggers, **and** your compiled web app. No separate frontend host to configure, no CI
glue wiring the two together.

> **Wiring the frontend to the backend.** The deploy bakes the sandbox's backend URL into
> your build's `index.html` automatically, as a `window.XANO_HOST` global evaluated *before*
> your app bundle. So read it at runtime with a build-time fallback and you never have to
> know the URL ahead of time:
>
> ```ts
> const HOST = (typeof window !== "undefined" && window.XANO_HOST) || import.meta.env.VITE_XANO_HOST;
> ```
>
> `window.XANO_HOST` is the **sandbox tenant** URL your deployed APIs answer at (the same
> value `sidestep sandbox details` prints as `baseUrl`); it is *not* `sidestep profile me`,
> which prints your account's instance origin. Because injection happens at deploy time, a
> prebuilt `./dist` retargets any sandbox with **no rebuild** — ideal for headless agents.
> Add your own public config (base URLs, *publishable* keys) with `--static-env KEY=VALUE`
> (repeatable), exposed the same way as `window.<KEY>`. A static host serves these files
> verbatim to the browser, so everything injected is **public** — never put secrets here;
> those belong in backend env, read server-side via `env(name)`.
>
> **Verifying the injection:** the served `index.html` writes the global in **bracket
> notation** — `window["XANO_HOST"]="…";` — so grep for the bare token `XANO_HOST`, not the
> exact string `window.XANO_HOST` (the dot form is valid to *read* the global in your app,
> but it's not what the file contains, so an exact-string grep for it wrongly reads as "not
> injected"). Note it can also be served from cache for up to an hour after a deploy — fetch
> once with a cache-buster (`curl -s "$URL/?nocache=$(date +%s)" | grep XANO_HOST`) rather
> than retrying the bare URL.

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
>
> **Verifying a def outside a bundler.** Inside a bundler (Vite/webpack) importing a query
> def to read `getPath()`/`verb` just works. To spot-check from Node, run a **real file**
> with `tsx <file.ts>` **from inside the project root** — not `tsx -e "import …"` (its
> CJS-preparse mis-resolves the package `exports` map → `ERR_PACKAGE_PATH_NOT_EXPORTED`) and
> not bare `node file.ts` (chokes on the `.js`-specifier intra-workspace imports the CLI's
> own loader resolves). Intra-workspace imports use `.js` specifiers
> (`../tables/links.js`) under `moduleResolution: bundler`, not extensionless.

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
- **`query.toSearchParams(input)`** → the GET transport counterpart to `InferInput`:
  serialize an input map into a `URLSearchParams` (scalars stringify, arrays repeat the
  key, `null`/`undefined` are dropped) instead of hand-building `?id=…`.
- **`InferRow<typeof post>`** → the table's row type. Rename or retype a column and every
  consumer breaks at compile time — exactly where you want it.
- **`InferResponse<typeof someQuery>`** → the endpoint's **response** type, closing the round
  trip. It auto-derives the common shapes with no codegen: an object-literal response yields
  those keys, and a query that returns a variable filled by a db op derives that op's result —
  the full row for `db.get`/`db.add`/`db.edit`/`db.patch`/`db.add_or_edit` (→ `Row`),
  a row list for `db.query`/`db.bulk.patch` (→ `Row[]`), a `boolean` for `db.has`, a `number`
  count for `db.bulk.delete`, and a `get`/`query` `output: [...]` selection narrows to a `Pick`.
  Where the shape isn't statically knowable — a value reshaped by a filter/lambda, built by
  control flow, or from an op the engine itself leaves untyped (`db.del`, `db.bulk.add`/`bulk.update`,
  raw `direct_query`) — it resolves to `unknown`; declare `responseShape` to close it.

```ts
import { listPosts, getPost } from "../xano/index.js";
import type { InferResponse } from "@sidestep/core";

type Posts = InferResponse<typeof listPosts>;   // Post[] — derived from the db.query it returns
type Post  = InferResponse<typeof getPost>;      // Post   — derived from the db.get it returns
```

For a **computed or multi-key object response**, author it as a *record of values* —
`response: { success: c.bool(true), id: inp("id") }` — **not** `c.obj({ ... })`. `c.obj` builds
a JSON *constant* by stringifying its argument, so a tagged value nested inside it serializes as
internal representation the engine can't decode (a runtime 500); nesting one is now a compile
error that points you at the record form (issue #42).

When a response is filtered, computed, or otherwise opaque to the static walk, declare it once
on the query and every caller derives from that single source of truth:

```ts
const getPost = query({
  verb: "GET", apiGroup: blog, name: "get_post",
  input: { id: input.int({ required: true }) },
  stack: [s.db.get({ table: post, fieldValue: inp("id"), as: "row" })],
  response: ref("row"),
  responseShape: null as InferRow<typeof post> | null,   // a get returns Row | null
});
type MaybePost = InferResponse<typeof getPost>;           // InferRow<typeof post> | null
```

This mirrors how the Xano engine itself derives an endpoint's response schema (a static walk of
the stack), so what you get in the type is what the endpoint actually returns — and it degrades
to `unknown` in exactly the cases the engine can't resolve either.

A GET endpoint carries its inputs in the query string rather than a JSON body:

```ts
import { getSnippet } from "../xano/index.js";
import { query, type InferInput } from "@sidestep/core";

const BASE = "https://your-instance.xano.io";

async function fetchSnippet(id: number) {
  const params = { id } satisfies InferInput<typeof getSnippet>;   // { id: number }
  const res = await fetch(`${BASE}${getSnippet.getPath()}?${query.toSearchParams(params)}`);
  return res.json();
}
```

The `@sidestep/core` entry has **zero Node dependencies**, so importing your workspace
graph into a browser bundle just works. The `node:fs`-backed emitters live in the
separate `@sidestep/core/node` entry a frontend never pulls in.

**Bundle size & tree-shaking.** `@sidestep/core` is `sideEffects: false`, so a bundler drops
the SDK exports your frontend doesn't use. But importing a query **def** for its `getPath()`
also pulls whatever its `stack` builds — the `s.*`/`c.*` factory *calls* run at module load
to construct the def, so they can't be tree-shaken out. Types are free (`InferInput`/
`InferRow` erase to nothing — use `import type`). To keep the client bundle lean, keep the
route metadata a frontend needs (the handle for `getPath()`/`verb`, plus `type` imports)
in a module separate from your stack-heavy authoring.

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
`trigger.workspace`, `trigger.error`. **A trigger's `stack` is a callback — `stack: (t) => [...]`,
not the plain `stack: []` array the other kinds use.** A trigger's inputs are **implied by type**
(fixed by Xano, not editable) and injected automatically — so triggers take no `input` field, and
the typed stack handle `t` is the only way to reference them (`response: (t) => ...` on
response-bearing types). `t` exposes exactly that type's inputs:

```ts
// Database trigger — t.new/t.old typed against the bound table's row.
trigger.table({
  name: "on-user-insert",
  table: users,
  actions: { insert: true },
  stack: (t) => [
    // t.new("email") is typed to the row; t.action is the op; t.old is null (insert-only).
    s.db.add({ table: auditLog, row: { email: t.new("email"), event: t.action } }),
  ],
});

// Realtime trigger — response-bearing; response defaults to the payload passthrough.
trigger.realtime({
  name: "on-message",
  objId: channelId,
  actions: { message: true },
  response: (t) => t.payload,
});
```

Per-type inputs: **table** `new`/`old`/`action`/`datasource`; **realtime** `action`/`channel`/`client`/`options`/`payload`; **mcpServer**/**agent** `toolset`/`tools`; **workspace** `to_branch`/`from_branch`/`action`; **error** `event`/`id`/`signature`/`error`/`caller`/`statement`/`actor`/`count`/`first_seen`/`last_seen`/`fixed_at`.

**Toolsets — AI vs MCP** — `toolset.mcp({ name, tools })` exposes tools over the MCP
protocol; `agent({ name, agentSettings: { type: "anthropic", model, system_prompt }, tools })`
is an LLM orchestrator. A `tool({...})` is its own kind — a function-like operation a
toolset references.

**Middleware attachment** — a `middleware({...})` is reusable logic (`input`/`stack`/
`response` + `resultStrategy: "merge"|"replace"` + `exceptionPolicy: "silent"|"rethrow"|
"critical"`). To run one, *attach* it with a host's `middleware: { pre, post }` field on
`query`/`apiGroup`/`defineFunction`/`task`/`tool` (not triggers):

```ts
const rateLimit = middleware({ name: "rate_limit", resultStrategy: "merge", /* ... */ });
const audit = middleware({ name: "audit", /* ... */ });

query({
  name: "get_user", verb: "GET", apiGroup: blog,
  middleware: { pre: [rateLimit], post: [audit] }, // runs rateLimit before, audit after
  stack: [/* ... */], response: ref("user"),
});
```

Prefer a def handle (`[rateLimit]`); a bare name (`["rate_limit"]`) only matches when the target
middleware uses its name-derived guid — pass the handle when the middleware pins an explicit
`guid` (same rule as `auth`/`apiGroup` references). Use `{ middleware: mw, active: false }` to
keep an entry but disabled. **Inheritance:** providing a phase **overrides** it (sets the stored
`pre_customize`/`post_customize` flag); omitting a phase **inherits** the parent tier's chain.
Xano resolves the fallback at request time — **Query → API Group → Workspace** (override, not
merge; the API-Group tier applies to queries — functions, tasks, and tools have no API-group
binding, so they inherit straight from the workspace). `pre: middleware.clear()` overrides a
phase with nothing (stop inheriting). Workspace-level defaults are the terminal tier:

```ts
workspaceConfig({
  name: "my-app",
  middleware: { query: { pre: [rateLimit] }, function: { post: [audit] } }, // {host}_{phase} map
});
```

**`workspaceConfig.middleware` is the whole workspace map.** Omit the field and SideStep leaves
the workspace's existing (e.g. UI-configured) middleware untouched. But once you set it, the full
`{host}_{phase}` map is emitted — any host/phase you don't list is emitted empty, which **clears**
that tier on deploy (the workspace tier has no per-key customize flag, so empty means "none").
Declare every workspace-level chain you want to keep.

SideStep emits each tier's lists + the customize flags; it does not compute the fallback (the
engine does). A `resultStrategy: "replace"` middleware attached `post` rewrites the response at
runtime, which `InferResponse` can't see — declare `responseShape` on the endpoint in that case.
Distinct from `s.middleware.call` (invoke a middleware inline from a stack). Branch-tier
middleware is not modeled — SideStep does not touch branches.

**`exceptionPolicy` — what a throw does to the request.** SideStep passes the value through; Xano
interprets it. `"silent"` **(the default)** swallows the throw — the host continues as if the
middleware succeeded, so a guard (rate limit, auth check) authored without an explicit policy is
**not enforced**. `"rethrow"` aborts the request and surfaces the authored `error`/status (a
tripped `s.redis.ratelimit` → HTTP 429); the `post` chain still runs — this is what a guard wants.
`"critical"` is like `"rethrow"` (same status) but additionally **skips the entire `post` chain**.
The only difference between the two is whether `post` runs.

**Request context & the `auth()` guard.** A `pre` middleware runs *after* auth resolution, so
`auth("id")` is the caller's id when the host is authenticated (its `auth` names an auth table) and
`null` on a public host. That `null` is the footgun: a rate limit keyed by `auth("id")` on a public
endpoint collapses every caller into one shared bucket, silently. `export()` **throws** when an
`auth()`-keyed middleware is directly attached to a host with no request identity — a `query` with
no auth table, or a `task` — and **warns** for a `function`/`tool` (auth is caller-dependent). The
check is direct-attachment only; tier-inherited attachment is not caught.

**Rate-limit recipe (the canonical middleware).** Build the per-user key with the filter chain
(`"prefix" + auth("id")` doesn't exist):

```ts
const writeRl = middleware({
  name: "write_rl",
  exceptionPolicy: "rethrow", // a tripped limit must abort (silent would let it through)
  stack: [
    s.redis.ratelimit({
      key: withFilters(c.text("rl:write:"), fl.concat(auth("id"))), // "rl:write:<id>"
      max: c.int(10), ttl: c.int(30), error: c.text("Too fast."),
    }),
  ],
});

query({ name: "create_post", verb: "POST", apiGroup: blog, auth: users, // authed ⇒ auth("id") is per-user
  middleware: { pre: [writeRl] }, stack: [/* ... */], response: ref("post") });
```

**Shared-bucket rule:** co-attaching one middleware object to N hosts means all N share the *same*
key ⇒ *one* counter — `max: 10` is a global per-user budget across them, not 10-per-host. Vary the
key (fold the host/action name into the prefix) for an independent limit per host.

</details>

<details>
<summary><b>Tables &amp; fields</b></summary>

**Field types** — a typed catalog `f.*` covers the full surface: scalars
(`f.text`/`f.int`/`f.decimal`/`f.bool`/`f.uuid`/`f.date`/`f.email`/`f.password`/`f.json`),
`f.timestamp`, the four file resources (`f.image`/`f.video`/`f.audio`/`f.attachment`), the
six `f.geo.*` types, `f.enum(values)`, `f.vector(size)`, and `f.object(children)`. Foreign
keys are `f.tableRef(table)` — an `int` (or `{ type: "uuid" }`) column whose link resolves
to the target table's guid at export. `f.tableRef` also takes the standard field options as
its second arg (`f.tableRef(users, { required: true })`). Any scalar `f.*` becomes a **list
column** with `{ array: true }` — `f.text({ array: true })` surfaces as `string[]` in
`InferRow<typeof table>` (the column analogue of `input.list`). Tables accept a named-map
schema (`{ email: f.email({ required: true }) }`), filter methods carry args (`"min:8"`), and
`views[]` (expression/sort/hiddenCols) encode via the shared comparison encoder. Byte-exact
vs the engine's `Schema::TYPE_MAP`. A column **`default` must stay within the BMP** — a 4-byte
character (codepoint > U+FFFF, e.g. an emoji) is mangled into invalid UTF-8 by the engine's
default pipeline and is rejected at export rather than 500ing at deploy with Postgres `22021`;
BMP defaults (accents, `€`, most CJK) are fine, or put the value on an endpoint input
(`input.text({ default })`), applied at runtime bind (issue #45).

**System columns & indexes** — `id` (int primary key; `idType:"uuid"` for a uuid key) and
`created_at` (`epochms`, `default:"now"`, `access:"private"`) auto-inject at the head of
the schema unless `system:false` or you declared them. Both are usable wherever a column
name is expected — a `db.query` `sort`/`output`, a `db.get`/`edit`/`del` `fieldName` — and
both appear in `InferRow<typeof table>`. Declare your own indexes with the shape
`{ type, fields: [{ name, op? }] }`, e.g. a unique email index
(`index: [{ type: "unique", fields: [{ name: "email" }] }]` — `"unique"` is shorthand for
`"btree|unique"`). The matching standard indexes (`primary(id)`, `btree(created_at desc)`,
plus `gin(xdo)` only when the table stores fields as JSON) auto-prepend, de-duped so
author-declared ones aren't doubled.

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
take a partial `row: { … }` — an `s.db.edit` writes **only** the columns you list and leaves
every unmentioned column at its stored value (a `{ votes }` edit bumps `votes` alone, it does
not null the rest); only `s.db.query` takes a `where` comparison built with
`expr(...)` (plus `sort: [{ sortBy, dir? }]` and `paging: { page?, per_page?, offset? }`).
`s.db.query`'s `where`, `additionalWhere`, `sort`, `paging`, and `output` are all
**applied by the engine** — the filter narrows the read, sort orders it, paging
pages it (`sort`/`paging` land in `context.return.list`; `dir` is `asc`/`desc`/`rand`,
and paging numbers are plain ints). The field-match ops take a **single** field — there's no composite `(a, b)` form. For a
two-column lookup (e.g. dedupe a `(habit, date)` check-in), use `s.db.query` with a `where`
array (ANDed) and branch on the result, rather than pushing the check to the client.

**Query parity — the full "Query All Records" surface.** Beyond a simple `where`,
`s.db.query` mirrors the whole Xano query builder:

- **Operators & boolean groups.** `expr(...)` stays the narrow comparison; for the
  full operator set use `cmp(left, op, right, { ignoreEmpty? })` — `op` is `in`/`not in`/
  `like`/`ilike`/`between`/`contains`/`includes`/`overlaps`/`@>`/`~`/`search`/… (plus the
  `expr` comparisons). Compose nested logic with `and(...)` / `or(...)`: `where:
  and(cmp(col("tags"), "overlaps", inp("t")), or(expr(col("a"), "=", …), expr(col("b"), "=", …)))`.
  The same surface is available on `addon()` `where`.
- **`returnType`** (`"list"` default | `"single"` | `"count"` | `"exists"` | `"stream"` |
  `"aggregate"`) drives `context.return.type` and the `InferResponse` shape — `count`→`number`,
  `exists`→`boolean`, `single`→`Row | null`, `stream`→`Row[]` (pageable, no envelope),
  `aggregate`→rows keyed by the group/eval aliases.
- **`bind: [{ table, as?, join?, where? }]`** adds joins (`context.bind[]`; `join` defaults to
  `"inner"`). Joined columns are addressable by **dotted path** in `where`/`sort`/`eval`; `as`
  defaults to the table name, and two joins to the same table need distinct aliases.
- **`eval: [{ name, as, filters? }]`** adds computed columns (`context.eval[]`); each `as`
  grafts onto the row as an `unknown` key in `InferResponse` (shadowing a column throws).
- **`aggregate: { group?, eval?, sort?, paging? }`** (with `returnType: "aggregate"`) builds
  `context.return.aggregate` — `group`/`eval` are `{ name, as, filters? }` (an aggregator like
  `sum`/`count` rides `filters`).
- **`distinct`** (`"auto"` default | `"yes"` | `"no"`) rides `context.return.<list|stream>.distinct`.

**Paging changes the response shape.** Supplying `paging` with metadata on (the
default) makes `s.db.query` return a **paging envelope** — `{ items: Row[], curPage,
nextPage, prevPage, offset, perPage, itemsReceived }`, plus `itemsTotal`/`pageTotal`
when `totals: true` — instead of a bare `Row[]`, and `InferResponse` reflects that
(issue #58). Pass `paging: { …, metadata: false }` to keep the bare array. Without
`paging` at all, the result stays a bare `Row[]`. Read `nextPage` (`number | null`) as
the typed has-next signal.

**Input-bound paging (#66).** `paging.page`/`per_page`/`offset` also accept a `Value`
(e.g. `inp("page")`) — the dynamic value rides `context.simpleExternal` while a static
block stays the engine gate (`enabled: true`). `paging.search`/`sort` are `Value` dynamic
overrides; a `search`/`sort`-only `paging` (no numeric field) does **not** paginate.
`external: { value, permissions? }` is the classic whole-config paging blob (mutually
exclusive with input-bound `paging` fields; forces the gate on).

**Addons** — enrich each returned row with related data by attaching addons to
`s.db.query`/`get`/`add`/`edit`/`patch` (the row-returning ops).

*Authoring an addon.* An addon is a single table-bound db query (not a statement
stack) — Xano executes it straight off its `context`. Use `addon({ table, where,
output })`: the `table` handle auto-fills the `context.dbo` binding, `where` (the
same `expr(...)` surface as `s.db.query`) is the predicate binding the addon to
the parent row, and `output` names the columns it returns. `sort` orders the
result. `cardinality` shapes it — `"single"` (one object), `"list"` (array, the
default), `"count"` (a number), `"exists"` (a boolean), or `"aggregate"` (grouped
rows; pass typed `group`/`eval` `{ name, as, filters? }` columns and the graft is an
array keyed by those aliases). Register it with `.registerAddons([...])`:

```ts
import { addon, input, expr, col, inp } from "@sidestep/core";
import { userTable } from "@sidestep/auth";

export const authorAddon = addon({
  name: "author",
  table: userTable,                          // → context.dbo binding
  where: expr(col("id"), "=", inp("user_id")), // → context.search (bind to parent row)
  output: ["id", "name"],                    // → typed graft, restricted columns
  cardinality: "single",                     // → one object, not a 1-element array
  input: { user_id: input.int({ required: true }) },
});
```

Rarer context (`bind`, `lock`, external paging) stays raw `context`
passthrough; an explicit `context.search`/`sort`/`return` wins over `where`/
`sort`/`cardinality`.

*Attaching it.* Reference the addon by its handle (or a bare name), map its
inputs (bind a parent-row column with `out(col)`), and land it on the row at an
`as` destination — a bare alias (`_author`) or a dotted `offset.alias`, authored
**relative to a row**. Addons nest via `children`:

```ts
s.db.query({
  table: post,
  paging: { per_page: 20 },
  addon: [
    { addon: authorAddon, as: "_author", input: { user_id: out("author") } },
  ],
  as: "rows",
}),
```

When you attach a typed `addon({ table, output })` handle, its **alias** (the
last segment of its `as` — here `_author`) is merged onto the row shape in
`InferResponse` with the addon's **graft shape** (`{ id; name }` for `single`,
`{ id; name }[]` for the default list, `number` for `count`, `boolean` for
`exists`, and an array keyed by the declared `group`/`eval` aliases for
`aggregate`) — no cast needed. An attachment-level
`output` narrows an object/array graft further (`output: ["name"]` → `{ name }[]`). A
**bare-name** reference still grafts `unknown` (the SDK can't shape it), so
narrow it at the call site. Author `as` relative to a row (`_author`); when the
query returns a metadata paging envelope (any `paging` with metadata on), the
`items[]` offset is prefixed for you so the addon grafts onto each `items[]`
element — without paging it lands on each bare row. (Writing `items[]` yourself
is tolerated and not double-prefixed.)

If an addon's alias **shadows an existing column** on the queried table, the
build throws — the engine would silently overwrite that column at runtime.
Rename the alias (Xano convention: a `_` prefix). The
`s.db.add_or_edit`/`del`/`has`/`truncate` ops do not take an `addon` (no row to
enrich / lean envelope).

**Runtime behavior.** Knowing what these return matters for typing your endpoint responses:

- `s.db.get` binds **`null`** when no row matches — it does *not* throw. So its response type
  is `InferRow<typeof table> | null`; null-check it. On a hit it binds the full row.
  (`s.db.has` is the boolean existence test.)
- `s.db.edit` binds the **full, post-mutation row** (the freshly-written values) and `s.db.add`
  the **full inserted row** (including the auto-assigned `id`/`created_at`). So
  `InferRow<typeof table>` is the correct response type for those two — and `InferResponse`
  derives it automatically when the query returns that bound variable, no `responseShape` needed
  (issue #48). `s.db.del` **binds `null`** (the engine deletes and returns no value), so it stays
  `unknown`. Unlike `get`, `edit`/`del` **throw** `NotFound` (404) when nothing matches.

**Values** — `c.int/text/bool/decimal/null/obj/array`, `ref(var)`, `inp(input)`,
`col(name)`, plus context refs `auth(path?)`, `env(name)`, `setting(name)`, `out(name)`
(a parent-row column, for addon inputs). `c.obj`/`c.array`
take **plain JSON literals only** — a nested tagged value (`inp`/`ref`/`auth`/`c.*`) is a
compile error; for a computed object — a response, or an `api.request` `params` — use a record
of values (`{ count: ref("count") }`), not `c.obj` (issues #42, #74/#75).
`withFilters(value, fl.a(), fl.b())` attaches the value pipeline via a typed catalog `fl.*`
(377 filters generated from the engine's own sources; pass filters spread — the array form
`withFilters(v, [fl.a(), fl.b()])` also works but the spread form is canonical). To
**read-modify-write a column from its current value** — e.g. increment a counter — you must
**`db.get` the row first** and pipe its bound value through a filter; `col()` does *not*
resolve to the stored value inside a `db.edit` `row` (it evaluates to `null`, so
`fl.add(1)` computes `null + 1` and the engine aborts — see issue #32):

```ts
s.db.get({ table, fieldValue: inp("id"), as: "current" }),
s.db.edit({ table, fieldValue: inp("id"), row: { clicks: withFilters(ref("current.clicks"), fl.add(c.int(1))) } }),
```

Note this read-modify-write is **not atomic** — concurrent writers can lose an increment;
there's no dedicated atomic-increment statement, and one can't be synthesized in the SDK
(it would still compile to this same `get` + `edit` pair). For a genuinely concurrency-safe
counter, push the arithmetic into the database with a single `s.db.direct_query`
`UPDATE … SET clicks = clicks + 1 WHERE …`.

⚠ **`direct_query` needs the table's *physical* Postgres name, which the typed surface does
not expose.** The engine assigns each table a physical name derived from its workspace and
table ids (of the form `x<workspace_id>_<table_id>`, e.g. `x6_203970`); those numeric ids are
assigned at import, so the physical name isn't knowable from a `table()` def (whose identity
is a name + guid, neither of which is the engine's numeric id), and `sql_name` is persisted
empty. There is currently
no typed way to reach that name, so the "safe" counter drops you out of the typed surface
entirely: you must hardcode the physical name after inspecting the deployed table. A typed
atomic path — either a dedicated increment statement or a table-reference token the engine
substitutes into `direct_query` SQL — requires an **engine change** (tracked in
[issue #35](https://github.com/sidestepai/core/issues/35)).

**Inputs** — `input.*` mirrors `f.*` exactly: every engine-legal field type is a valid
function/query input. Use `input.object(children)` and `input.list(element)` for structured
shapes. `input.url()` names a URL-typed text field. **Comparisons** use `= != > < >= <=`
(JS `== === !==` are normalized).

**Validate input at the boundary.** Field types don't enforce arbitrary rules, so reject
bad input in the stack with `s.precondition` — it raises a **status-bearing** error
(`error_type: "badrequest"` → HTTP 400) a client can detect via `res.ok`, unlike `s.throw`,
which returns 200 with an error body. Example: a link shortener stores user URLs and later
navigates to them, so a `javascript:`/`data:` URL is a stored-XSS / open-redirect vector —
guard the scheme before persisting:

```ts
import { s, c, inp, expr, withFilters, fl } from "@sidestep/core";

s.precondition({
  // `fl.regex_test` runs PHP `preg_match(pattern, subject)`. It is PATTERN-piped:
  // the piped value is the regex, the arg is the text tested — the REVERSE of
  // `istarts_with`, whose piped value is the subject (#22). The pattern needs
  // PCRE delimiters (`~…~i` = case-insensitive); `^https?://` matches http/https
  // and rejects `javascript:`, `data:`, and `httpfoo://` lookalikes alike.
  expr: expr(withFilters(c.text("~^https?://~i"), fl.regex_test(inp("url"))), "=", c.bool(true)),
  error_type: "badrequest",                       // → HTTP 400 (not a 200 throw)
  error: c.text("url must be an http(s) URL"),
})
```

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
sidestep sandbox deploy ./xano/index.ts --static ./dist --static-env PK=pk_live_1   # + extra public config
sidestep sandbox deploy --bundle ws.json     # deploy an already-exported bundle
sidestep sandbox details                     # print the sandbox base URL + tenant details (JSON)
sidestep profile me                          # print the scoped user + instance base URL (JSON)
sidestep logout                              # revoke the refresh token + delete the local cache
sidestep version                             # print the installed @sidestep/core version
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
`~/.sidestep/auth.json` instead, reusable from any project directory. Every command that
**reads** credentials (`sandbox deploy`/`details`, `profile me`, token refresh) resolves them
**project-local first, global as a fallback**: it uses `./.xano/auth.json` when present,
otherwise `~/.sidestep/auth.json` — so a single `sidestep login --global` covers directories
that have no local cache. `login` and `logout` do **not** fall back: they target the
project-local cache unless you pass `--global`, so a plain `logout` never revokes the shared
credential. An explicit `--config`/`$XANO_CONFIG` always wins over everything.

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

**Config injection** — before archiving, the deploy rewrites the build's root `index.html`,
inserting an inline `<script>` at the top of `<head>` that assigns each config value to a
`window.<KEY>` global (so it runs before the app bundle). The backend URL is seeded
automatically as `window.XANO_HOST` (from the backend deploy's own response), and
`--static-env KEY=VALUE` (repeatable) merges in extra keys, overriding the seed on a name
clash. A static host has no server runtime — it serves these files verbatim — so injected
values are **public**: base URLs and *publishable* keys only, never secrets (those go in
backend env, read via `env(name)`). Injection is skipped (reported as a warning, not a
failure) when the archive has no root `index.html` with a `<head>` to anchor to; values are
`<`-escaped so one containing `</script>` can't break out of the element. This is why a
prebuilt `./dist` can retarget any sandbox with no rebuild.

> **Caching — verify with a cache buster.** The static host serves `index.html` with
> `Cache-Control: public, max-age=3600`, so a browser (or CDN) that loaded the page before
> your latest deploy can hold the old HTML — including a *pre-injection* `<script>`-less
> version — for up to an hour. If `window.XANO_HOST` looks missing, it's almost always this:
> hard-reload (Cmd/Ctrl+Shift+R) or open DevTools with "Disable cache" checked. When
> verifying from a script or agent, append a throwaway query param so you never read a cached
> copy — `curl -s "$URL/?nocache=$(date +%s)"` — and check the fetched HTML for the injected
> `window.XANO_HOST` line rather than retrying the same cached URL.

`sidestep sandbox details` prints the same **sandbox base URL** (`GET /api:meta/sandbox/me`,
projected to JSON) out of band, for cases where you'd rather bake it in at build time.
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
the `workflow_test` / `service` / `vault` / `branch` payload sections. `InferResponse`
auto-derivation covers the object-literal and single-`db`-variable cases (matching the engine's
static walk); multi-hop tracing (a response variable produced inside control flow, `set_var`, or
a nested function call) and addon/related-field keys resolve to `unknown` — declare
`responseShape` for those.

</details>

---

<div align="center">

**Write TypeScript. Run `sidestep sandbox deploy`. See it live.**

See [`@sidestep/auth`](https://www.npmjs.com/package/@sidestep/auth) for a real,
reusable extension package · [`llms.txt`](llms.txt) for the full authoring surface ·
MIT licensed

</div>
