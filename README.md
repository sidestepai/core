<div align="center">

# SideStep

### Your whole backend, in TypeScript. Live on the internet in one command.

**Write your app in TypeScript — the database, the APIs, even AI agents. Or let an
AI write it for you. Then run one command and it's live on Xano's cloud, with its own
URL. No servers, no setup, no config. That's it.**

</div>

```bash
npx sidestep login                      # 1. sign in (opens your browser)
npx sidestep init my-app && cd my-app   # 2. scaffold your backend + frontend
npm run build                           # 3. build your frontend → frontend/dist
npx sidestep deploy ./xano/index.ts --static ./frontend/dist   # 4. deploy both → live URLs
```

```
→ Deploying ./xano/index.ts → new ephemeral "my-app"
✓ Ephemeral e4f2-9ab1 deployed
! New ephemeral URL:
    https://e4f2-9ab1.xano.io                                     ← backend, live
✓ Static host deployed
    https://my-app.xano.io                                        ← frontend, live
    Expires in 1h 0m
```

<div align="center">

**From an empty folder to a live full-stack app.** `init` sets up your project — a
TypeScript backend and a React frontend. `npm run build` builds your frontend, then
`deploy` puts both online and hands you a live URL. Change your code — yourself or with
an AI — and deploy again; your app updates in seconds. No servers to set up, nothing to
configure, no glue code between your backend and your frontend.

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

- **🚀 Deploy is built in.** `sidestep deploy` compiles your code and ships it straight to
  a live Xano **ephemeral environment** over an authenticated connection, then prints its
  URL. No export/import dance, no upload script to maintain. Backend **and** static frontend
  in one command. Use ephemerals for QA and dev, then `sidestep release` the same workspace
  to your main Xano instance for production — same code, same command shape, promoted.

- **⚡ Fast, safe iteration.** Ephemerals are disposable (they auto-expire, ~1h by default),
  so you rebuild as often as you like — `deploy` figures out whether to refresh the one
  you're iterating on or spin up a fresh one, and calls out the URL when it changes. Deploys
  are identity-stable: re-running never duplicates objects, and with a committed `xano.lock`
  renames stay renames instead of delete-and-recreate.

- **🧩 The types flow to your frontend.** Import a `query()` def into your React/Angular
  app and get the endpoint path, HTTP verb, and a fully-typed request payload — with
  **zero codegen**. Rename a column and every consumer lights up red.

- **🏗️ Highly scalable, zero ops.** You write intent; Xano runs the infrastructure.
  Autoscaling compute, managed Postgres, edge-served static hosting. You never touch a
  Dockerfile.

- **🤖 AI-first by design.** A deterministic, fully-typed authoring surface — an agent (or
  you) emits well-typed TS that always compiles to a valid, importable workspace. Ships with
  machine-readable grounding: **`llms.txt`** is the lean, canonical tour an agent reads to
  author the SDK, with the exhaustive per-entry catalog — full field schemas, filter argument
  lists, engine mappings — a targeted lookup away in **`manifest.json`**. Agents learn the
  whole SDK without reading source.

---

## Deploy it: backend + frontend, one command

SideStep's primary deploy target is an **ephemeral environment**: a named, disposable Xano
workspace that spins up on demand, auto-expires (~1h by default), and is meant to be written
to constantly while you build. `sidestep deploy` create-or-refreshes one and prints its URL —
run it again and it refreshes the same environment; if it expired, a fresh one is minted and
the new URL is called out. (Prefer a single throwaway singleton? `--dest sandbox`.) Most
stacks make you deploy your API and your app through two separate pipelines. SideStep
collapses that into **one command** — point `--static` at your built frontend and it archives
and uploads it to the edge-served static host, right after the backend import, in the same run:

```bash
# Build once, then ship backend + frontend together. The deploy wires the
# backend URL into the frontend for you — no need to know it before building.
npm run build                                          # → frontend/dist
npx sidestep deploy ./xano/index.ts --static ./frontend/dist
```

```
→ Deploying ./xano/index.ts → new ephemeral "my-app"
✓ Ephemeral e4f2-9ab1 deployed
! New ephemeral URL:
    https://e4f2-9ab1.xano.io                                         ← backend, live
✓ Config injected into index.html: window.XANO_HOST                   ← backend URL, wired in
✓ Static host deployed
    https://my-app.xano.io                                            ← frontend, live
✓ Frontend is live                                                    ← edge confirmed serving THIS build
    Expires in 1h 0m
```

One authenticated call ships your database schema, your APIs, your functions and
triggers, **and** your compiled web app. No separate frontend host to configure, no CI
glue wiring the two together. Manage your environments with `sidestep ephemeral
<list|get|delete|export>`.

> **Wiring the frontend to the backend.** The deploy bakes the environment's backend URL into
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
> prebuilt `frontend/dist` retargets any sandbox with **no rebuild** — ideal for headless agents.
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

**Two targets**, so the dev loop and the production step stay distinct:

| Command | Where it goes |
|---|---|
| `sidestep deploy` | A disposable **ephemeral** environment (default) — create-or-refreshed each run, auto-expiring, with its own URL. `--dest sandbox` targets your throwaway singleton instead. |
| `sidestep release` | Your **main Xano instance** workspace — the production target. *(Coming soon; prints a notice for now until record-preserving import lands, so a release never wipes production data.)* |

Every `deploy` is a **full replace** of the disposable environment — always fresh, no
merge mode, no flags to get wrong. Deploys are **authenticated over OAuth** — sign in once,
and the CLI refreshes tokens automatically. The target instance comes from your token
(never a stray flag), and the CLI prints what it's about to do before it touches anything.

**CI & agents** run fully headless from two env vars — no browser needed:

```bash
XANO_REFRESH_TOKEN=… XANO_CLIENT_ID=… npx sidestep deploy --bundle ws.json
```

> ⚠️ A deploy is a full replace of the target environment, including its table records,
> before importing. The blast radius is your own disposable ephemeral/sandbox — but anything
> you only ever created by hand in it (or any data it accumulated) is gone. That's exactly
> why production has a separate `release` path.

---

## Already have a Xano workspace? Pull it into TypeScript

`codegen` runs the loop the other way: it reads a workspace and writes it back out as
readable SideStep source — real `s.db.query(...)`, `f.email()`, typed defs — not a JSON dump.
And not a loose pile of files either: you get the same runnable project `sidestep init`
scaffolds, with the pulled workspace filling `xano/`. So a pull deploys:

```bash
sidestep workspace codegen my-app   # your real workspace (the one your login is scoped to)
cd my-app
npm run build
npm run xano:deploy                 # → a live ephemeral URL
```

The other three sources are the same command with a different origin:

```bash
sidestep sandbox codegen my-app          # your sandbox
sidestep ephemeral codegen pr-42 my-app  # a named ephemeral (tenant first, path second)
sidestep codegen ws.json my-app          # a bundle already on disk — offline, no login
```

Inside, `xano/` is shaped the way the workspace is: one directory per kind, with each
object under its parent — queries under the API group that owns them, triggers under
what they fire on. Tables share `table/table.ts`, settings sit in `xano/workspace.ts`,
`_shared.ts` holds anything else referenced from more than one file, and `xano/README.md`
lists anything that did not translate cleanly.
Object identities (`guid`) are preserved, so cross-references stay intact. A statement
this SDK does not model yet round-trips verbatim rather than breaking the pull.

Pulled objects are authored the same way you would write them by hand — `table({...})`,
`query({...})`, `defineFunction({...})` — so the generated tree keeps its types. A pulled
table's columns still check on `fieldName`/`output`/`sortBy`, `InferInput<typeof q>` still
resolves a pulled query's payload, and a pulled agent still types `s.ai.agent.run`.

A pull states what the source workspace actually holds and leaves out what the SDK would
put back anyway. A table's `primary(id)` / `created_at` / `gin(xdo)` indexes are the
engine's standard set, so only the indexes someone created are listed. A trigger comes back
through the factory that built it (`tableTrigger`, `realtimeTrigger`, …) rather than a bare
`satisfies TriggerDef`, which keeps its typed stack handle; the two realtime types that bind
a def handle are the exception, since a stored trigger carries two guids with no way to know
they agree. And two objects that reference each other — a pair of tables joined both ways,
two functions that call each other — can't both be declared first, so the second reference
is a `{name, guid}` const hoisted to the top of the file (`const OrdersRef = {…}`) instead of
an import that would close a cycle. Only the guid is ever read, so it binds exactly.

`xano/README.md` also lists objects that were **already empty in the source** — an
endpoint someone created and never filled in pulls as a def with no `stack`, which looks
identical to a decode that gave up. The report is what tells the two apart.

A few options exist only so a pull can be *faithful*, and reading them in generated code
is the only time you should see them: `table: null` / `fn: null` (a statement whose target
was deleted or never bound), `merge` / `hidden` on a field, `paging: { enabled }` on a
query, and `c.blank(tag)` (the editor's unconfigured value box — **not** a zero or an
empty collection; the engine reads `""` and `"0"` differently, so tidying one into the
other changes what the workspace stores). They describe what the source workspace actually
stored — a pulled `table: null` is a defect to fix upstream, not a shape to copy — and
each carries that warning at the call site. A blank binding also reports, because a
statement wired to a table or function that no longer exists is worth seeing even though
it round-trips exactly.

Then it checks its own work: the project it just wrote is loaded, exported, and diffed
against the workspace it came from. A mismatch names the object and fails the command
(`--no-verify` opts out). So "it compiled" and "it means the same thing" are separate
claims, and you get both.

Re-pulling is a real workflow: a second `codegen` into the same directory refreshes
`xano/` and leaves the rest of the project — your `package.json`, your `frontend/` —
exactly as you left it. No `--force` needed, because the tree carries a marker saying it
was machine-written.

> ⚠️ **`xano/` is a scratch surface, and there is no `sidestep workspace deploy`.**
> Regenerating rewrites it (a directory that isn't a previous pull still needs `--force`),
> it carries schema only — no table rows — and deploying it is a *full replace* of the
> target. Pull from your real workspace, edit, and `deploy` to a disposable ephemeral or
> sandbox. Workspace env var **values** ride inline in `xano/workspace.ts` (that is what a
> deploy sends), so treat a pulled tree as secret-bearing before you commit it.

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

### Seed data

Give a table `seed` rows and they ship into the database on deploy — so a fresh
environment comes up with lookup tables, demo content, or fixtures already in place,
not empty:

```ts
const product = table({
  name: "product",
  schema: {
    sku:   f.text({ required: true }),
    name:  f.text({ required: true }),
    price: f.decimal(),
    tags:  f.text({ array: true }),
  },
  // Rows are validated against the column types before deploy. A column without
  // `required: true` may be omitted (the engine applies its default). Omit `id` and
  // int-PK rows are auto-numbered 1..N (or set `id` on every row); a bad value
  // or unknown column is a loud error, never a silent drop.
  seed: [
    { sku: "SKU-001", name: "Aeron Chair",   price: 1395, tags: ["furniture", "ergonomic"] },
    { sku: "SKU-002", name: "Standing Desk", price: 599,  tags: ["furniture"] },
  ],
});
```

Deploy is a full replace, so re-deploying re-seeds cleanly — no duplicate rows. Seed
data travels only in the deploy package (resolved at deploy time); it never enters the
type-only workspace your frontend imports. For large or generated data, pass a loader
instead of an inline array: `seed: () => import("./products.seed.json")` (a JSON module's
`.default` is unwrapped for you). The loader form costs nothing in typing — the table's
row type and column names stay inferred either way.

---

## 60-second quickstart

The fastest start is `sidestep init`, which scaffolds the whole project — a Vite
+ React frontend under `frontend/`, a sidestep backend under `xano/`, and the
`xano:export`/`xano:deploy` scripts already wired:

```bash
npx sidestep init my-app           # scaffold; prompts to set up AI instructions
cd my-app
npm run dev                        # run the frontend right away
```

`init` flags: `--name <name>` (default: the folder name), `--ai <claude|codex|cursor|none>`
(repeatable; writes `CLAUDE.md`/`AGENTS.md`/Cursor rules — none by default),
`--force` (scaffold into a non-empty folder), `--no-install` (skip `npm install`).
The starter backend is empty but already compiles and deploys — grow it from the
walkthrough in `xano/EXAMPLE.md`.

Prefer to wire it by hand? The same loop, from scratch:

```bash
# 1. Install
npm install @sidestep/core
npm i -D tsx                       # lets the CLI run your .ts entry directly

# 2. Write your workspace in TypeScript
#    xano/index.ts  →  export default workspace("my-app")...

# 3. Sign in once (OAuth — no API keys to copy around)
npx sidestep login                 # opens your browser; you pick the instance + workspace

# 4. Deploy to a live ephemeral environment — this is the dev loop
npx sidestep deploy ./xano/index.ts                     # → prints your ephemeral URL

# 5. Ship a built frontend alongside it (both land on the same ephemeral).
#    --static injects the backend URL for you, so no pre-build wiring is needed:
npm run build                                           # → ./dist
npx sidestep deploy ./xano/index.ts --static ./dist
```

That's the whole loop: **install → write TypeScript → login → deploy → URL.** No dashboards,
no manual imports, no upload scripts. Deploy again to refresh the same environment.

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
- **`sidestep paths ./xano/index.ts`** (alias `routes`) → list every endpoint's verb and
  resolved `api:<canonical>/<name>` path from the CLI, without writing a script — handy for
  wiring a client or curling a live env.
- **`InferInput<typeof someQuery>`** → the request-payload type, derived from a query's
  `input` map at compile time. Required inputs are required keys; enums become literal
  unions; nested objects and lists carry through. **No codegen, always in sync.**
- **`query.toSearchParams(input)`** → the GET transport counterpart to `InferInput`:
  serialize an input map into a `URLSearchParams` (scalars stringify, arrays repeat the
  key, `null`/`undefined` are dropped) instead of hand-building `?id=…`.
- **URL path params** → name the endpoint with `{param}` segments and declare an input per
  segment. `getPath({ params })` fills them, with the keys typed from the name itself:

  ```ts
  const getPost = query({
    name: "blog/{slug}/review/{review_id}",       // segments chain; no wildcards
    verb: "GET",
    apiGroup: api,
    input: { slug: input.text(), review_id: input.int(), verbose: input.bool() },
    stack: [s.db.get({ table: post, fieldName: "slug", fieldValue: inp("slug"), as: "row" })],
    response: ref("row"),
  });

  getPost.getPath({ params: { slug: "hello", review_id: 7 } });
  // → "/api:<canonical>/blog/hello/review/7"
  getPost.toSearchParams({ verbose: true });      // → "verbose=true" (path params dropped)
  ```

  Every `{param}` must have a matching input or `query()` throws — Xano treats an unbound
  marker as inert route text, so the endpoint would answer on the path and see nothing.
  Inputs that aren't in the path (`verbose`) stay ordinary query-string params. Never
  interpolate the path by hand: a value containing `/` would silently address a different
  endpoint, which `getPath` refuses. `realtimeChannel()` paths work identically.
- **`InferRow<typeof post>`** → the table's row type. Rename or retype a column and every
  consumer breaks at compile time — exactly where you want it.
- **`InferResponse<typeof someQuery>`** → the endpoint's **response** type, closing the round
  trip. It auto-derives the common shapes with no codegen: an object-literal response yields
  those keys, and a query that returns a variable filled by a db op derives that op's result —
  the full row for `db.add`/`db.edit`/`db.patch`/`db.add_or_edit` (→ `Row` — each binds the
  full written row rather than null, so it stays non-nullable; a genuine miss throws instead of
  yielding null — `NotFound`/404 for `edit`/`patch`, a unique-constraint error for `add`, while
  `add_or_edit` upserts and never misses), `Row | null` for `db.get` (it binds
  `null` on a miss rather than throwing — handle the not-found path), a row list for
  `db.query`/`db.bulk.patch` (→ `Row[]`), a `boolean` for `db.has`, a `number` count for
  `db.bulk.delete`, and a `get`/`query` `output: [...]` selection narrows to a `Pick` (still
  `| null` for `get`). A dotted entry selects sub-keys of an object column
  (`output: ["id", "meta.url"]`, on a statement or an addon); the narrowing keys off the
  path's root, since an object column's sub-keys aren't declared in the schema.
  Where the shape isn't statically knowable — a value reshaped by a filter/lambda, built by
  control flow, or from an op the engine itself leaves untyped (`db.del`, `db.bulk.add`/`bulk.update`,
  raw `direct_query`) — it resolves to `unknown`; declare `responseShape` to close it.

```ts
import { listPosts, getPost } from "../xano/index.js";
import type { InferResponse } from "@sidestep/core";

type Posts = InferResponse<typeof listPosts>;   // Post[]      — derived from the db.query it returns
type Post  = InferResponse<typeof getPost>;      // Post | null — a db.get misses to null
```

For a **computed or multi-key object response**, author it as a *record of values* —
`response: { success: c.bool(true), id: inp("id") }` — **not** `c.obj({ ... })`. `c.obj` builds
a JSON *constant* by stringifying its argument, so a tagged value nested inside it serializes as
internal representation the engine can't decode (a runtime 500); nesting one is now a compile
error that points you at the record form (issue #42). A **nested plain object** in a record
response (`response: { user: { id: ref("u"), age: 3 } }`) is auto-wrapped for you — no manual
`obj({ ... })` — and raw literals in a call/agent `input` map coerce too
(`s.function.run({ fn, input: { max_age_days: 3 } })` — no `c.int(3)`).

When a response is filtered, computed, or otherwise opaque to the static walk, declare it once
on the query and every caller derives from that single source of truth:

```ts
const getPost = query({
  verb: "GET", apiGroup: blog, name: "get_post",
  input: { id: input.int({ required: true }) },
  stack: [s.db.query({ table: post, where: expr(col("id"), "=", inp("id")), as: "rows" })],
  // A filtered response is opaque to the static walk, so derivation is `unknown`.
  response: withFilters(ref("rows"), fl.first()),
  responseShape: null as InferRow<typeof post> | null,   // declare the real shape once
});
type MaybePost = InferResponse<typeof getPost>;           // InferRow<typeof post> | null
```

(A plain `response: ref("row")` off a `s.db.get` needs no `responseShape` — it already
derives `InferRow<typeof post> | null`, since `db.get` misses to `null`.)

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
in a module separate from your stack-heavy authoring — and for a def whose stack builds a
heavy graph (an agent + its tools via `s.ai.agent.run`), don't import it in the browser at
all: declare its `{ path, verb }` as plain metadata and verify it against the compiled
bundle with `sidestep paths`.

---

## Reference

<details open>
<summary><b>Project structure</b></summary>

Lay objects out however you like and register them explicitly — there's no folder
auto-discovery magic (deliberately):

```
xano/
├── function/     get_user.ts         export const getUser = defineFunction({...})
├── table/        table.ts            export const user = table({...})
│   └── trigger/  on_insert.ts        export const onInsert = tableTrigger({...})
├── query/        public/api_group.ts export const publicApi = apiGroup({...})
│                 public/posts_GET.ts export const posts = query({...})
├── agent/        assistant.ts        export const assistant = agent({...})
├── workspace.ts                      export const workspaceSettings = workspaceConfig({...})
└── index.ts      workspace("my-app").registerTables([...]).registerFunctions([...])…
```

Paths are lower case throughout — an HTTP verb is the one exception, because it is
the method rather than a word. Bindings keep the object's own casing, so a file name
and the symbol it exports can differ.

That is the shape `sidestep codegen` writes. Hand-authored projects are free to use
any other — only `index.ts` registering the objects matters.

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
| `{tableTrigger,realtimeServerTrigger,realtimeChannelTrigger,mcpServerTrigger,agentTrigger,workspaceTrigger,errorTrigger}(...)` | `registerTriggers` | `trigger` |
| `tool({...})` | `registerTools` | `tool` |
| `mcpServer({...})` | `registerMcpServers` | `toolset` |
| `agent({ llm, ... })` | `registerAgents` | `toolset` |
| `task({ schedule, ... })` | `registerTasks` | `task` |
| `middleware({ resultStrategy, ... })` | `registerMiddleware` | `middleware` |
| `addon({...})` | `registerAddons` | `addon` |
| `realtimeServer({ enabled, ... })` | `registerRealtimeServers` | `realtime_server` |
| `realtimeChannel({ server, ... })` | `registerRealtimeChannels` | `channel` |
| `realtimeMessage({ channel, ... })` | `registerRealtimeMessages` | `message` |
| `microservice({ deployment, ... })` | `registerMicroservices` | `microservice` |
| `workspaceConfig({...})` | `registerWorkspace` | `workspace` |

**Triggers** — seven first-class root factories that share one envelope discriminated by
`obj_type` + a per-type `meta`: `tableTrigger` (db), `realtimeServerTrigger`,
`realtimeChannelTrigger`, `mcpServerTrigger`, `agentTrigger`, `workspaceTrigger`,
`errorTrigger`. **A trigger's `stack` is a callback — `stack: (t) => [...]`,
not the plain `stack: []` array the other kinds use.** A trigger's inputs are **implied by type**
(fixed by Xano, not editable) and injected automatically — so triggers take no `input` field, and
the typed stack handle `t` is the only way to reference them (`response: (t) => ...` on
response-bearing types). `t` exposes exactly that type's inputs:

```ts
// Database trigger — t.new/t.old typed against the bound table's row.
tableTrigger({
  name: "on-user-insert",
  table: users,
  actions: { insert: true },
  // Optional row filter, evaluated by the DATABASE before the stack runs — so it
  // names the SQL pseudo-tables with col(), NOT the t handle. Rejected with
  // `truncate`; insert cannot read OLD.*, delete cannot read NEW.*.
  search: cmp(col("NEW.email"), "!=", c.text("")),
  stack: (t) => [
    // t.new("email") is typed to the row; t.action is the op; t.old is null (insert-only).
    s.db.add({ table: auditLog, row: { email: t.new("email"), event: t.action } }),
  ],
});

// Realtime channel trigger — response-bearing; a handle binds it unambiguously.
realtimeChannelTrigger({
  name: "on-room-join",
  channel: room,
  actions: { join: true },          // gating: the return admits or denies the join
  stack: (t) => [s.debug.log({ value: t.client("permissions.dbo_id") })],
});
```

Per-type inputs: **table** `new`/`old`/`action`/`datasource`; **realtimeServer** `action`/`realtime_server`/`client`; **realtimeChannel** `action`/`channel`/`payload`/`client`; **mcpServer**/**agent** `toolset`/`tools`; **workspace** `to_branch`/`from_branch`/`action`; **error** `event`/`id`/`signature`/`error`/`caller`/`statement`/`actor`/`count`/`first_seen`/`last_seen`/`fixed_at`.

**Realtime** — the websocket family, and the only three-level containment chain in the
SDK: `realtimeServer` owns `realtimeChannel`s, which own `realtimeMessage` handlers (a
message is the realtime analogue of a query — its own typed payload and stack). Pass the
**handle**, not a name: a channel path is unique only within its server, so
`realtimeChannel({ server: chatServer })` and `realtimeMessage({ channel: roomChannel })`
are what make the binding unambiguous. A channel's `input` types its **path** params
(`rooms/{room_id}`); a message's `input` types the message **payload**. A server is off
until `enabled: true`. Lifecycle events are triggers: `realtimeServerTrigger` (client
connect/disconnect) and `realtimeChannelTrigger` (join/leave/deliver). Those actions do
not share a posture, and the posture decides what your stack should return:

- **`connect` and `join` gate.** `connect` really does refuse the socket — an error frame,
  then a close with code 4401, before the connection is ever ready — and `join` runs before
  the client becomes a member, so a denial means it never sees a fan-out. Return
  `{ allowed: true }` (an optional `reason` reaches the client) or any truthy value to
  admit. **An empty or falsy return denies**, so a stack that just falls through — or a
  gating trigger with no `response` at all — refuses everyone. Note that a *crash* does the
  opposite: gating actions fail **open**, so a broken stack admits rather than locking
  everyone out over a workspace bug. It is the clean-but-empty return that shuts the door.
- **`disconnect` and `leave` are observational** — the return is ignored and a throw is
  swallowed, because the connection is already gone and cleanup has to complete regardless.
- **`deliver` gates per recipient.** It runs once for each client a message is about to
  reach, which makes it the per-viewer redaction tool ("hide the author's address from
  everyone but the author") and also the most expensive action of the five: a stack per
  recipient per message. It needs `delivery: { perRecipient: true }` on the channel to run
  at all.

  **Its return values don't read like a filter, and this is the easiest thing to get
  backwards in the whole family.** Only an explicit **null** drops the message for that
  recipient. An **object** replaces that recipient's payload. *Everything else* — including
  `false`, `0`, and `""` — delivers the message unchanged, as does a crash. So a yes/no
  redaction check that returns `false` sends the very message it was written to suppress;
  return null instead. Two more details: the delivered payload arrives nested, so read
  `inp("payload").<field>`, and `t.client` is the **sender** while
  `s.realtime.get_session` describes the **recipient** this run is for.

```ts
const chat = realtimeServer({ name: "chat", enabled: true });

const room = realtimeChannel({
  name: "rooms/{room_id}",           // `input` types the PATH params
  server: chat,
  input: { room_id: input.int() },
  publish: { who: "authenticated" },
  // The client-visible transcript a rejoining client is sent.
  conversation: { enabled: true, limit: 50 },
});

realtimeMessage({
  name: "send",                      // `input` types the message PAYLOAD
  channel: room,                     // the handle carries the server too
  input: { body: input.text({ required: true }) },
  deliverTo: "channel",              // or "sender" (request/response) / "others"
  stack: [s.debug.log({ value: inp("body") })],
});

realtimeChannelTrigger({
  name: "on-room-join",
  channel: room,                     // a handle — a bare path is ambiguous
  actions: { join: true },           // gating: the return admits or denies the join
  stack: (t) => [s.debug.log({ value: t.channel })],
});

realtimeChannelTrigger({
  name: "on-room-deliver",
  channel: room,
  actions: { deliver: true },        // runs once PER RECIPIENT, not per event
  stack: (t) => [s.debug.log({ value: t.action })],
});
```

**The client side is derived too** — the same "import the def, don't hardcode the URL"
contract `query().getPath()` and `mcpServer().getUrl()` give. A server handle builds the
socket URL; a channel handle builds the path a client joins:

```ts
chat.getUrl("https://your-instance.xano.io");        // wss://your-instance.xano.io/ws/<canonical>
chat.getUrl("https://host/tenant/xxxx-xxxx-xxxx");   // wss://host/ws/<tenant>:<canonical> — lifted
chat.getUrl(BASE, { tenant: "xxxx-xxxx-xxxx" });     // wss://…/ws/<tenant>:<canonical>
room.getChannel({ room_id: 42 });                    // "rooms/42"
```

`getUrl` takes the instance base URL you already have and normalizes the scheme
(`https`→`wss`, `http`→`ws`); a remote host must end up `wss://` or the socket fails as an
opaque 1006. Both accessors throw rather than guess — the `canonical` comes from the def,
or from `xano.lock` once `sidestep export --lock` has minted it. `getChannel` also throws
on a missing, unknown, or slash-bearing param, so a typo can't silently address a
different channel.

**On a tenant instance, both halves of the client must name the tenant — the URL is all
either half needs, but they spell it differently.** The socket glues it onto the canonical
with a colon *inside one path segment* — `/ws/<tenant>:<canonical>` — which is unlike every
other tenant-addressed URL: HTTP calls take a separate leading segment,
`https://<host>/tenant/<tenant>/api:<canonical>/…`. No request header is required for
either.

Because the two shapes differ, **`getUrl` translates a tenant base URL rather than
concatenating it**: hand it the `https://<host>/tenant/<name>` that `sidestep sandbox
details` prints (and that deploy injects as `window.XANO_HOST`) and the tenant is lifted
into the socket's form, so `chat.getUrl(window.XANO_HOST)` alone reaches the right
database. Pass a *different* `{ tenant }` alongside such a base URL and it throws rather
than pick a winner. One case still needs `{ tenant }` explicitly: a tenant served on **its
own domain**, where HTTP resolves the tenant from the hostname but the websocket tier
cannot — the connection hash is all it reads.

Tokens are tenant-scoped, so one minted through the instance workspace is rejected by a
tenant's realtime server — authenticate and dial through the same tenant. (The `/ws` segment belongs to the instance ingress and is stripped
before the websocket tier reads the rest of the path as the connection hash — only a direct
dial at a local dev websocket port, which bypasses the ingress, wants the bare canonical
with no `/ws`.)

Auth is a bearer token passed as the websocket **subprotocol** (`new WebSocket(url,
token)`); no token means an anonymous client, admitted only where
`anonymousClients: true` — and anonymous access is gated twice, once by the server at
connect and again by the channel at join, so setting it on the channel alone is not enough.
Frames are JSON — `{ action, channel, type, payload, options? }`, where `action` is
`join` | `leave` | `broadcast` | `ack` | `ping` | `presence` and `type` is the
`realtimeMessage` name — and you must `join` before you may `broadcast`:

```ts
const ws = new WebSocket(chat.getUrl(BASE), TOKEN);
const channel = room.getChannel({ room_id: 42 });
ws.onopen = () => setTimeout(() => {          // the server finishes its handshake first
  ws.send(JSON.stringify({ action: "join", channel }));
  ws.send(JSON.stringify({ action: "broadcast", channel, type: "send", payload: { body: "hi" } }));
}, 500);
setInterval(() => ws.send(JSON.stringify({ action: "ping" })), 60_000);  // see below
```

**An idle socket is reaped after about ten minutes, so a listen-only client has to say
something.** That is the common shape — a notification feed, a dashboard, a presence
sidebar: it joins, then never publishes again, and gets disconnected for it. `{ action:
"ping" }` (answered `pong`) exists for exactly this, and any frame resets the clock. A
chatty client never notices; a passive one silently drops off and reconnects forever.

Server frames arrive as `action: join` (the ack — `{ joined: true, params }`, plus
`cursor`/`resumed` on an at-least-once channel), `message`, `replay`, `broadcast`,
`presence_full`/`presence_join`/`presence_leave`,
`conversation_start`/`conversation_end` (replayed transcript frames are flagged
`conversation: true`, so history is distinguishable from live traffic), `pong`, `ack`, and
`error`. Two of those are easy to misread:

- **`broadcast` comes back as a receipt**, not just a verb you send. Its
  `payload.delivered_local` counts recipients on the *answering node only* — it is not a
  delivery confirmation for the channel. It also carries `dropped: true` when the handler
  declined to emit, and `id` on an at-least-once channel.
- **`replay` is not the transcript.** The `conversation_*` frames are the shared "what was
  said before I arrived"; `replay` is the per-client "what I missed while disconnected",
  resumed from that client's own cursor. Both can be on at once, and they are configured by
  different options.

An `error` carries `payload.message` — plus `code`, `limit` and `retry_after` when rate
limited, which is the only error that carries a `code`, so don't switch on it. An `error` is
a per-frame refusal rather than a disconnect, with two exceptions: a failed handshake and a
refused `connect` trigger each send one and *then* close the socket with code 4401.

`options` on a frame carries `{ socketId?, client_id?, channel? }`. `socketId` addresses
another client directly and requires `publish.direct` on the channel (off by default, and
checked *before* `publish.who`). `client_id` is the at-least-once cursor handle described
below — unrelated to the `client_id` on a realtime session.

**The transcript hydrates the client — don't build a hydration endpoint.** On a
`conversation` channel the replay is *pushed* at join, unasked: `conversation_start`
(carrying `payload.count`), then the last `limit` messages as ordinary `action: "message"`
frames — original `type` and `payload`, plus `conversation: true` and the original `ts` —
then `conversation_end`. A client that renders `message` frames is already hydrated; there
is no `GET /messages` to write and no table to read before painting the first view.

**But `enabled: true` on its own does nothing at all.** `limit` defaults to `0`, and `0`
means *retain none* rather than *retain everything* — so `conversation: { enabled: true }`
records nothing, replays nothing, and reports no error. Always pass a `limit`. Three more
consequences worth knowing before you rely on it:

- **What a handler broadcasts *is* the transcript row.** It stores the post-handler payload
  keyed by message type, so broadcast everything a past message needs to render (author
  name, id, `created_at`) — nothing else comes back. And only `deliverTo: "channel"` and
  `"others"` are recorded: a `"sender"` response is invisible to every future joiner by
  construction.
- **`ttl` expires the whole transcript at once, and only when the channel goes quiet.** It is
  an idle timer on the transcript as a unit, refreshed by every write — not a per-message
  age cap. An active channel's transcript never ages out; a silent one loses all of it
  together. `ttl: 0` means no expiry.
- **The transcript is a capped ring, not storage.** Write messages to a table when you want
  durability, search, moderation, or paging *older* than the window — not to backfill a
  joiner.

Presence frames (a `presence: true` channel only) carry the roster: `presence_full` holds
`payload.members`, an array of the whole roster including the receiving client, and
`presence_join`/`presence_leave` hold a single `payload.member`. A member is
`{ id, dbo_id, authenticated, extras, joined_at }` — `id` is the auth row id as a string
(`""` when anonymous), `dbo_id` the auth table's id (`0` when anonymous), `extras` the
connection's extras, `joined_at` epoch seconds. Render from `presence_full` and apply the
deltas; the count is members, not connections, since the roster is refcounted per identity
(a user's second tab fires no second `presence_join`). On join the order is `join` ack →
`presence_full` → (everyone else gets `presence_join`) → conversation replay, and a joined
client can re-request the snapshot with `{ action: "presence", channel }`.

**`delivery: { guarantee: "at_least_once" }` is a contract with the client, not a switch on
the channel.** Setting it changes the transport — a briefly disconnected client can replay
what it missed instead of losing it — but only if the client holds up its end:

```ts
// the client must identify itself durably at join, then acknowledge what it receives
ws.send(JSON.stringify({ action: "join", channel, options: { client_id: DEVICE_ID } }));
// …for each `message`/`replay` frame carrying an `id`:
ws.send(JSON.stringify({ action: "ack", channel, id }));
```

An **authenticated** client is keyed by its identity and needs no `client_id`. An
**anonymous** one has nothing stable to key on, so without `options.client_id` it gets no
cursor, its `ack` frames are ignored, and it quietly falls back to at-most-once — the
guarantee you configured is simply absent, with nothing on the wire to say so. Send the
`client_id` once, in the join frame; later `ack`s don't need to repeat it. The server
confirms each ack with `{ action: "ack", channel, payload: { cursor } }`, the join ack
reports `cursor` and `resumed`, and the gap arrives as `replay` frames, oldest first.

How far back that gap can reach is set by **`conversation`**, even on a channel with no
transcript enabled: `conversation.ttl` if present (here a genuine per-message age cut, and
it wins over `limit`), else `conversation.limit`, else a default of 1000 messages. It is the
one place the two options reach outside the transcript, and the one place `ttl` means
something different than it does above.

Inside a handler, both input surfaces read with `inp()`: `inp("body")` for the message
payload, `inp("room_id")` for the channel's `{room_id}` path param — bound once at join and
read from the connection thereafter, so a sender cannot post into a room it never joined.

**What the handler returns decides what is delivered, and the failure directions are not
symmetric.** A returned value is fanned out to `deliverTo` and stored as the transcript row.
Returning **null** delivers nothing — that is the supported way for a handler to veto its
own message, and the sender is told it was dropped. A payload rejected by the declared
`input` also delivers nothing, with the validation detail going only to the sender. But a
handler that **crashes** fails *open*: the sender's original, unvalidated payload is
broadcast to the channel unchanged, so that one workspace bug cannot black-hole a channel.
A handler doing redaction or authorization should therefore not be the only thing standing
between client input and subscribers.

`s.realtime.get_session({ as })` binds the connection itself for the "who is this sender"
question on an anonymous-client channel. It works in a realtime message stack and in
channel *and* server triggers, and returns a flat object: `authenticated`, `client_id` (the
authed row id as text, `""` when anonymous), `dbo_id`, `socket_id` (the transport id),
`channel`, `params` (bound path params, `{}` when none), `extras`, and `opened_at`. Note
that three different things are called a client id and they are unrelated:
`session.client_id` is the app-facing identity, `session.socket_id` is the transport, and
`options.client_id` on a frame is the at-least-once cursor handle above.

Channel path matching is stricter than it looks, which is what `getChannel()`'s throws are
protecting you from: segment counts must match exactly (so `rooms/{room_id}` does not match
`rooms/42/edit`, which is what lets `org/{org_id}/room/{room_id}` be its own channel),
literal segments are case-sensitive, and an empty segment is rejected rather than collapsed,
so a stray leading or doubled `/` matches nothing at all. A channel that is merely
*inactive* reports the same "no settings for channel name" as one that never existed — by
design, so deactivating doesn't leak that a channel is there.

`rateLimit: { messagesPerMinute }` is checked before the handler runs, so a throttled frame
costs no stack execution, and `0` means unlimited. Treat it as a cost guardrail rather than
a security control: an anonymous client is bucketed per connection, so reconnecting resets
its budget, and the limiter fails *open* if its backing store is unavailable.

Everything above is the *pull* direction — a client sends a frame, a handler answers. For
the *push* direction, `s.realtime.publish({ server, channel, data, message?, authTable?,
authId? })` originates a server-authored event onto a channel from any ordinary stack: "the
auction closed", "the import finished". Pass the `realtimeServer()` handle and the filled-in
path (`channel.getChannel({ room_id: 42 })`, never the template). Three things to know
before you reach for it, because each one bites:

- It is **delivery-only**. The payload is fanned out as-is; naming a `message` type does not
  invoke that handler. A channel `deliver` trigger still runs, because that belongs to the
  channel rather than the message.
- It is **server-authoritative** — it bypasses the channel's `publish.who`, which governs
  clients. Any stack that can run it can publish, so the authorization belongs in your stack.
- It is **fail-soft**. A missing or disabled server, or an unreachable bus, is swallowed by
  the engine: nothing throws, nothing is returned, and a mis-targeted publish is silent.
  SideStep throws on the two references it can actually check, `server` and `channel`, which
  is the only loud failure available.

`authTable`/`authId` stamp an **asserted** identity on the frame for a client to render. They
are attribution, not a credential — nothing validates them and no auth gate reads them.

**The superseded realtime layer.** Xano has had two realtime generations, and they reuse
the same words — "realtime", "channel" — for different objects. Everything above is the
current one. Two superseded surfaces are still supported, because `sidestep codegen` has to
be able to bring back a workspace that holds them:

- `realtimeTrigger({ objId, actions: { message?, join? } })` — a trigger against the old
  workspace-global realtime config. Its `join` action is now
  `realtimeChannelTrigger({ actions: { join: true } })`; its `message` action is now a
  `realtimeMessage()` handler, because a message is an authored unit rather than a trigger
  action.
- `s.api.realtime_event({ channel, data, ... })` — publishes to the old layer. It is **not**
  a way to publish to a `realtimeChannel()`: its `channel` is a string against that layer, so
  aiming it at a current-layer channel path publishes into the void. Reach for
  `s.realtime.publish({ server, channel, data, ... })` instead — it names the owning
  `realtimeServer()`, which is what makes the channel resolvable.

Both are **absent from the `## Object kinds` and `## Statements` catalogs in `llms.txt`** and
named only under `## Legacy` — the same treatment `c.expressionLegacy` gets. The point is
that an agent recognizes them in pulled code without ever reaching for one, and never
mistakes a name match for the two generations being the same object.

**MCP servers & agents** — two first-class root primitives. Both persist under the
`toolset` payload key (obj_type=`toolset`), so an `mcpServer` and an `agent` **sharing a
name collide** (both derive `md5("toolset:"+name)`). A `tool({...})` is its own kind — a
function-like operation both reference by handle.

```ts
// An MCP server exposes tools over the MCP protocol. Auth is PER-TOOL and works
// exactly like a query's auth — name an auth table({ auth: true }); it resolves
// to the table's guid (Xano has no server-level auth gate).
mcpServer({ name: "books", tools: [{ tool: searchTool, auth: users }] });

// An agent is an LLM orchestrator. The typed `llm` block maps onto the engine's
// real agent_settings wire shape (provider config nested under configs.<provider>).
// `xano-free` needs no API key.
const assistant = agent({
  name: "assistant",
  llm: { type: "xano-free", systemPrompt: "Be helpful.", prompt: "Answer the question." },
  tools: [{ tool: searchTool }],
});

// Agents have no public endpoint — you invoke them IN-STACK with `s.ai.agent.run`
// from any host that has a stack: a query, function, task, tool, or trigger
// (bound by handle, remapped on import like the call family).
query({
  name: "ask", verb: "POST", apiGroup: api,
  input: { question: input.text({ required: true }) },
  stack: [s.ai.agent.run({ agent: assistant, args: obj({ question: inp("question") }), as: "answer" })],
  // The completion is at `.result` — a dotted ref projects it, and `InferResponse`
  // types `text` to `string` (no `responseShape` needed). See "Agent run result".
  response: { text: ref("answer.result") },
});
```

`llm` is a provider-discriminated union — `anthropic` / `openai` / `google-genai` /
`xano-free` — each with its provider's typed fields (`apiKey`, `model`, `temperature`,
`reasoningEffort`, `thinkingTokens`, `searchGrounding`, …), mapped to the engine's
camelCase `configs.<provider>` keys. A connection trigger binds its target with
`mcpServerTrigger({ mcpServer })` / `agentTrigger({ agent })`.

**Agent run result.** The `as` variable of `s.ai.agent.run` is a **rich envelope**, not
the bare completion — the model's text is nested under **`.result`**:

```ts
// shape of the `answer` var:
{ result, finishReason, providerMetadata, reasoningDetails, steps, /* toolCalls?, usage?, … */ }
```

So `ref("answer.result")` returns the text; a bare `ref("answer")` returns the whole
metadata object. Both are typed: `ref("answer")` is `AgentRunResult` and the dotted
`ref("answer.result")` projects its `.result` field, so `InferResponse` reflects the real
shape either way (neither is `unknown`). `result` is a `string` for a text agent; for a
structured-output agent it is inferred from the agent's `output.schema` — pass the agent
*handle* to `s.ai.agent.run` and `ref("answer.result")` types to that schema's shape with no
extra hint (see below). The type-only `resultShape` witness is only for overriding that
inference, or for typing an agent referenced by bare name:
`s.ai.agent.run({ agent: "classifier", as: "answer", resultShape: {} as { sentiment: string } })`.

**Structured outputs.** Constrain what the model returns by authoring `output.schema` on
the agent — a named-field record built with the `input.*` catalog, exactly like a function
`input:` map (the engine stores it as `structuredOutputsSchema`):

```ts
const classifier = agent({
  name: "classifier",
  llm: { type: "xano-free", prompt: "Ticket: {{ $args.body }}" },
  output: { schema: { priority: input.enum(["low", "high"]), summary: input.text() } },
});

// The schema is declared once. Pass the handle and `.result` is typed from it:
query({
  name: "classify", verb: "POST", apiGroup: api,
  input: { body: input.text({ required: true }) },
  stack: [s.ai.agent.run({ agent: classifier, args: obj({ body: inp("body") }), as: "answer" })],
  response: ref("answer.result"),  // typed { priority: "low" | "high"; summary: string }
});
```

The authored schema both constrains the model's output *and* types the call site's `.result`
— no second `resultShape` witness needed.

**MCP endpoint URL.** An `mcpServer()` handle derives its endpoint from the def — no
hardcoding, the same contract `query.getPath()` gives API endpoints:

```ts
const books = mcpServer({ name: "books", canonical: "books", tools: [/* … */] });
books.getUrl(HOST);  // https://<host>/x2/mcp/books/mcp/stream   (Streamable HTTP)
books.getPath();     // /x2/mcp/books/mcp/stream
```

It targets **Streamable HTTP** (the deprecated HTTP+SSE transport is not surfaced). The
`mcp` path segment is the token slot — the literal `mcp` means "no URL auth" (pass a
`Authorization: Bearer …` header, or embed a token via `getUrl(HOST, { token })`). The
`canonical` resolves from the def (or `xano.lock`), exactly like a query's. Agents have no
public endpoint (they run in-stack via `s.ai.agent.run`), so `agent()` exposes only
`getCanonical()`, not a URL.

**Run inputs → agent (Twig templating).** At run time Xano renders the agent's **string**
settings through Twig before the LLM call. The `args` you pass to `s.ai.agent.run({ args })`
become the `{{ $args }}` namespace (env vars are `{{ $env.NAME }}`) — this is how an
endpoint's inputs reach the prompt. Templatable: `systemPrompt`, `prompt`/`messages`,
`model`, `maxSteps`, and every **string** provider-config field. Numeric/boolean fields
(e.g. `temperature`) are not templated. Pass a dynamic object arg with **`obj({...})`**
(the dynamic sibling of `c.obj` — it allows nested `inp`/`ref`/… values):
`s.ai.agent.run({ agent, args: obj({ name: inp("name") }) })` reaches `{{ $args.name }}`.

**Background execution (`runtime`).** `s.function.run` and `s.ai.agent.run` both accept a
`runtime` block that moves the call off the request path:

```ts
s.function.run({ fn: sendDigest, runtime: { mode: "async-shared" } });
s.function.run({ fn: rebuildIndex, runtime: { mode: "async-dedicated", cpu: "250m", memory: "512Mi" } });
```

This is **not** a performance knob — it changes what the statement gives you. Xano rewrites
an async call to a different statement that *dispatches and continues*, so it does **not**
return the function's result; don't bind `as` expecting a value. Collect results later with
`s.await({ ids })`. `cpu`/`memory`/`timeout`/`maxRetry` are read at `async-dedicated` only.
Omit `runtime` entirely for a normal synchronous call.

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

**The same wholesale rule applies to `datasources`.** `workspaceConfig` also carries
`defaults` (e.g. `{ db_primary_key: "uuid" }`), `use_custom_names`, `datasources`, and
`datasource_live`. Each is emitted **only when you set it**, so omitting one leaves the
tenant's existing value untouched — but once you set `datasources`, the full list is emitted
and any datasource you don't list is dropped. Secrets and instance-assigned values (crypto
material, integration keys, `domain_prefix`, usage counters) are never emitted; `codegen`
reports them as deliberate omissions rather than round-trip failures.

**Three fields are server-shaped, not authoring surfaces.** `realtime`, `documentation`, and
`swagger` are carried **verbatim**: SideStep models none of their members, so whatever the engine
stored round-trips unchanged — including members this SDK has never heard of. They exist so a
pulled workspace is honest, not to be authored, so omit them. `realtime` in particular is the
**legacy** workspace-level block; the realtime primitives you actually author are
`realtimeServer` / `realtimeChannel` / `realtimeMessage`, each its own object.

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
endpoint collapses every caller into one shared bucket, silently. `export()` **warns** (never blocks)
when an `auth()`-keyed middleware is directly attached to a host where `auth()` may be null — a
`query` with no auth table, a `task`, or a `function`/`tool` (caller-dependent auth). An
authenticated query is skipped. The check is direct-attachment only; tier-inherited attachment is
not caught. It warns rather than throws because a bare `auth()` reference isn't proof of a collapse
(an IP-disambiguated key uses `auth()` where null is fine).

**Microservices** — a container workload deployed alongside the workspace, called from a
stack with `s.api.microservice`. Two mutually exclusive shapes chosen by `kind`: `builtin`
declares containers (image/ports/resources/env/command/args) plus optional `ingresses`, and
`helm` points at a chart and its `values`. Passing both throws at the authoring site, because
the engine serializes them as exclusive groups. `command`/`args` take plain strings and
`containerPort` defaults to `servicePort`, matching what the platform's own scaffold does.

```ts
export const echo = microservice({
  name: "echo",
  deployment: {
    replicas: 2,
    containers: [{
      name: "echo",
      image: "ealen/echo-server:latest",
      ports: [{ servicePort: "8080", containerPort: "80" }],
      resources: { cpu: "50m", ram: "256Mi" },
    }],
  },
});
```

**This surface is early and expected to change**, and two things are worth knowing before you
lean on it. `configs` and `volumes` are typed but **unconfirmed** — authoring either currently
fails upstream, so nothing has shown what a populated one persists as. And **two fields carry
secrets into a pulled tree verbatim**: `chart.values` and `registryAuth.dockerconfigjson`. They
have to, or a pulled microservice could not be redeployed — so a tree holding a
private-registry microservice holds a live credential. `codegen` reports every one it carries;
prefer leaving `dockerconfigjson` unset and supplying it out of band.

### Request history

Every primitive captures **request history** — the per-object execution trace behind Xano's
request/task/trigger debugger. Like middleware, it inherits down a tier chain; author it with a
single scalar `history` field:

```ts
query({ name: "get_user", verb: "GET", history: 100 });   // capture, depth cap 100
task({ name: "nightly", history: false });                // off
tool({ name: "search", history: "all" });                 // unlimited depth
function({ name: "helper" /* history omitted */ });        // inherit from the workspace
```

The scalar maps to Xano's stored block: `false` off, `true` on at the default depth, a **number** =
capture depth (how many statement executions are recorded in each history record — *not* how many
records are retained), `"all"` = unlimited depth. **Omitting `history` inherits**; any value stops
inheriting for that object.

**Inheritance** resolves at request time — **object → container → workspace**. A query inherits from
its API group, a tool from its toolset/agent, and everything else straight from the workspace.
Author the container defaults too:

```ts
apiGroup({ name: "blog", history: false });                     // default for its queries (query_*)
agent({ name: "assistant", history: 100, llm });                // default for its tools (tool_*)

workspaceConfig({
  name: "my-app",
  history: { query: 100, function: true, trigger: "all" },      // terminal {objType}_* map
});
```

Per-kind defaults when inheriting: **query / task / tool capture ON; function / trigger / middleware
OFF**; default depth 100. `workspaceConfig.history` is **wholesale** — once set, every object type
is emitted (an unlisted type falls back to its engine default), so declare every default you want to
keep; omit the field to leave the workspace's existing history untouched. SideStep emits each tier's
stored values + the inherit flag only; the engine computes the fallback. Branch-tier history is not
modeled — SideStep does not touch branches.

### Workspace environment variables

Set a tenant's env vars through the workspace object. Author them as a name→value map; read them at
request time with `env("NAME")` (→ `$env.NAME`):

```ts
workspaceConfig({
  name: "my-app",
  env: {
    STRIPE_KEY: process.env.STRIPE_KEY!,          // sourced from the deploy environment
    APP_BASE_URL: "https://my-app.example.com",   // a plain config value
  },
});

// …read it back inside any stack:
query({ name: "charge", verb: "POST", stack: [
  s.http.request({ url: env("STRIPE_KEY") /* … */ }),
] });
```

**Values are secrets.** Prefer sourcing them from the deploy environment (`process.env.X`) over
committing literals, and don't commit a compiled bundle that contains real values. The
`workspaceConfig({ env })` map is the **setter**; the `env(name)` value helper is the **reader**.
Under the hood a workspace env var is a *setting* (`$env.NAME` compiles to `tag:"setting"` with the
plain name) — the same tag the `sys.*` built-ins use, they just carry `$`-prefixed names
(`sys.apiBaseUrl()` → `$env.$api_baseurl`). Deploying sets the vars you declare; omit the field to leave the
workspace's existing env untouched.

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

**Public-endpoint variant.** On a host with no auth table `auth("id")` is `null`, so an
`auth("id")`-keyed limit silently collapses every anonymous caller into one bucket. Key off the
client IP instead — `sys.remoteIp()` (Xano's `$env.$remote_ip`):

```ts
const publicRl = middleware({
  name: "public_rl",
  exceptionPolicy: "rethrow",
  stack: [
    s.redis.ratelimit({
      key: withFilters(c.text("rl:public:"), fl.concat(sys.remoteIp())), // per-IP, not per-user
      max: c.int(20), ttl: c.int(60), error: c.text("Too many requests."),
    }),
  ],
});

query({ name: "signup", verb: "POST", apiGroup: blog, // public (no auth) ⇒ key by IP
  middleware: { pre: [publicRl] }, stack: [/* ... */] });
```

**Reading the request body in a `pre` middleware.** A `pre` middleware *does* receive the host's
request inputs. Read them with `s.util.get_all_input({ as: "payload" })` — but the result is
**wrapped as `{ type, vars }`**, so a body field lives at `ref("payload.vars.<field>")`, not
`ref("payload.<field>")` (the un-nested path is the usual cause of a `Unable to locate var` 500).
To key a public limit off a submitted field: `get_all_input({ as: "payload" })`, then
`withFilters(c.text("rl:apply:"), fl.concat(ref("payload.vars.candidate_email")))`.

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
vs the engine's column type map. A column **`default` must stay within the BMP** — a 4-byte
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

**Every statement can carry `description` and `disabled`.** They annotate the stack item rather
than argue the statement, so they are ordinary optional arguments on all of them — inline on the
object-arg factories, and a trailing options object on the positional specials:

```ts
s.db.add({ table: users, data: [...], disabled: true, description: "backfill, off for now" })
s.set_var("draft", c.int(1), { disabled: true })
```

`disabled: true` is Xano's commented-out state — the step stays in the stack and the run engine
skips it, so a pull of a workspace with disabled steps keeps them as readable source instead of
opaque blobs. `description` is the note shown beside the step in the editor. Both default to
absent, and both round-trip.

The **call family** (`s.function.run`, `s.api.call`, `s.task.call`, `s.tool.call`, …)
invokes another workspace object — pass the target's def handle (or name) and SideStep
resolves the cross-object reference at export. The **db family** (`s.db.add`/`s.db.edit`/
`s.db.get`/`s.db.query`/`s.db.del`/…) reads and mutates records. Single-record
reads/mutations match one field (`{ fieldName, fieldValue }`, defaulting to `id`); writes
take a partial `row: { … }` — an `s.db.edit` writes **only** the columns you list and leaves
every unmentioned column at its stored value (a `{ votes }` edit bumps `votes` alone, it does
not null the rest). A **nested** cell writes sub-keys of an object column
(`row: { magic_link: { token: inp("token"), used: c.bool(true) } }`); to also set the
column's own value, use `data: [{ name, value, children: [...] }]`. Only `s.db.query` takes a `where` comparison built with
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
  The same surface is available on `addon()` `where`. An array is ANDed, and a bare
  `or(...)` at the top level ORs the top-level clauses rather than nesting them —
  the shape the engine itself stores.

  There is also `mixed(a, { or: b }, { and: c })`, for a container whose terms do
  **not** all join the same way. Xano's editor allows that — every condition row
  after the first carries its own AND/OR choice — so pulled workspaces contain it
  and it has to round-trip. **Don't write new conditions with it.** The stored form
  doesn't record the intended grouping, and the two places such a condition can
  appear disagree about it: a branch (`s.conditional`/`s.while`/`precondition`)
  folds the terms strictly left to right, so `a OR b AND c` means `(a OR b) AND c`,
  while a `db.query` filter inherits the database's AND-before-OR precedence and
  selects `a OR (b AND c)`. Write `and(or(a, b), c)` or `or(a, and(b, c))` — each
  says exactly one of those, in every context. `sidestep pull` reports every mixed
  container it recovers under `ambiguous-condition`.
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
  `sum`/`count` rides `filters`). Write each `name` as a **bare column** (`"status"`) — it is
  alias-qualified to `"<table>.status"` on emit (the engine rejects a bare column in an
  aggregate); an already-dotted `name` (a `bind`ed/joined column) passes through. Byte-verified
  against a live engine.

  ```ts
  s.db.query({
    table: posts,
    returnType: "aggregate",
    aggregate: {
      group: [{ name: "published", as: "published" }],
      eval: [
        { name: "id", as: "count", filters: [{ name: "count" }] },
        { name: "score", as: "total", filters: [{ name: "sum" }] },
      ],
    },
    as: "rollup",
  })
  ```
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
`external: { value, permissions? }` is the classic whole-config paging blob (forces the
gate on). It combines with input-bound `paging` as a **fallback chain**: the engine uses
the blob when it resolves to something non-empty and the per-field binds when it does not,
so a blob fed from an *optional* input with per-field paging behind it is a working
configuration, not a conflict.

**Addons** — enrich each returned row with related data by attaching addons to
`s.db.query`/`get`/`add`/`edit`/`patch` (the row-returning ops).

*Authoring an addon.* An addon is a single table-bound db query (not a statement
stack) — Xano executes it straight off its `context`. Use `addon({ table, where,
output })`: the `table` handle auto-fills the `context.dbo` binding, `where` (the
same `expr(...)` surface as `s.db.query`) is the predicate binding the addon to
the parent row, and `output` names the columns it returns. `sort` orders the
result. `tableAlias` sets that binding's SQL alias (`context.dbo.as`) — the name
`where`/`sort` qualify columns with (`col("merchant.id")`); absent unless set, and
never derived from the table, since Xano sanitizes it and keeps it after a rename. `cardinality` shapes it — `"single"` (one object), `"list"` (array, the
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

**Values** — `c.int/text/bool/decimal/null/obj/array`, `c.now()` (current time as
epoch-ms — the engine-native constant; valid inline in a `where`/`cmp`),
`c.expression("…")` (a raw Xano Expression Engine expression — **not validated**, see below),
`ref(var)`, `inp(input)`,
`col(name)`, plus context refs `auth(path?)`, `env(name)`, `setting(name)`, `sys.*()`
(built-in request/system vars — see below), `out(name)`
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

**Raw expressions (`c.expression`)** — the Xano Expression Engine, as a string carried
through verbatim to `tag:"const:expr2"` (what the expression editor writes):

```ts
s.set_var("greeting", c.expression('"Hello, " ~ $input.first_name')),
s.set_var("total", c.expression("$input.qty * $input.unit_price")),
```

⚠️ **The string is NOT validated.** SideStep does not parse it, does not type-check it,
and cannot tell a working expression from a typo. Nothing inside it participates in
`InferResponse`, so a var referenced in the string is invisible to the type system — a
rename that updates every typed `ref()` will not touch it. A malformed expression fails at
**runtime**; one that is merely wrong (`$var.tota1`) returns a wrong answer rather than an
error. Play at your own risk until validation exists.

Reach for the typed surfaces first — `ref`/`inp`/`col` for references, `withFilters(...,
fl.*)` for transforms, and `obj({...})` for a dynamic object (it *builds* a checked
expression for you). Use `c.expression` only for syntax those cannot express: `~` string
concatenation, inline arithmetic, conditionals. It is **not** the `expr()` condition
builder — `expr(col("id"), "=", inp("id"))` builds a comparison for a `where`, while this
builds a value from raw source.

`c.expressionLegacy(...)` is the same passthrough for the older `const:expr` form. It
exists so `sidestep codegen` can bring back a workspace that still holds one — **do not
author it**. It is deliberately absent from the `## Values` catalog in `llms.txt` and named
only under `## Legacy`, so an agent recognizes it in pulled code without ever picking it
for new code.

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

**System / request variables (`sys.*`).** Xano exposes built-in request context — client IP,
HTTP method, data source, and so on. In XanoScript these read as `$env.$remote_ip` — note the
**second `$`**: they are *settings* with a `$`-prefixed name, the same tag `env()` and `setting()`
emit (a workspace env var is just a setting with a plain name). That prefix is the footgun:
`env("remote_ip")` does **not** read the caller's IP — it reads a workspace env var literally named
`remote_ip` (almost always unset → null). `sys.*` spells the `$`-prefixed names for you:

| accessor | var | type | | accessor | var | type |
|---|---|---|---|---|---|---|
| `sys.remoteIp()` | `$remote_ip` | text | | `sys.datasource()` | `$datasource` | text |
| `sys.requestMethod()` | `$request_method` | text | | `sys.branch()` | `$branch` | text |
| `sys.requestUri()` | `$request_uri` | text | | `sys.tenant()` | `$tenant` | text |
| `sys.requestQueryString()` | `$request_querystring` | text | | `sys.release()` | `$release` | int |
| `sys.httpHeaders()` | `$http_headers` | object | | `sys.platform()` | `$platform` | int |
| `sys.requestAuthToken()` | `$request_auth_token` | text | | `sys.isDebugger()` | `$debugger` | bool |
| `sys.apiBaseUrl()` | `$api_baseurl` | text | | | | |

`setting("$<name>")` remains the escape hatch for anything `sys` doesn't cover. The one that
matters most in practice is `sys.remoteIp()` — the rate-limit key for **public** endpoints,
where `auth("id")` is null (see the rate-limit recipe above).

**Inputs** — `input.*` mirrors `f.*` exactly: every engine-legal field type is a valid
function/query input. Use `input.object(children)` and `input.list(element)` for structured
shapes. `input.url()` names a URL-typed text field. **Comparisons** use `= != > < >= <=`
(JS `== === !==` are normalized).

**Validate input at the boundary.** Field types don't enforce arbitrary rules, so reject
bad input in the stack with `s.precondition` — it raises a **status-bearing** error
(`error_type: "badrequest"` → HTTP 400) a client can detect via `res.ok`, unlike `s.throw`,
which returns 200 with an error body. Its `error` takes a plain string for a fixed message
(`error: "url must start with http"`) or a `Value` when the message is computed. Example: a link shortener stores user URLs and later
navigates to them, so a `javascript:`/`data:` URL is a stored-XSS / open-redirect vector —
guard the scheme before persisting:

```ts
import { s, c, inp, expr, withFilters, fl } from "@sidestep/core";

s.precondition({
  // `fl.regex_test` runs PHP `preg_match(pattern, subject)`. It is PATTERN-piped:
  // the piped value is the regex, the arg is the text tested — the REVERSE of
  // `istarts_with`, whose piped value is the subject (#22). Build the pattern with
  // `c.regex(...)` — it delimiter-wraps for you (a bare `c.text("^…")` is an invalid
  // PCRE that matches nothing, so `withFilters` rejects it, #128). `^https?://`
  // matches http/https and rejects `javascript:`, `data:`, `httpfoo://` alike.
  expr: expr(withFilters(c.regex("^https?://", "i"), fl.regex_test(inp("url"))), "=", c.bool(true)),
  error_type: "badrequest",                       // → HTTP 400 (not a 200 throw)
  error: c.text("url must be an http(s) URL"),
})
```

**Normalize on the input, not in the stack.** `methods` run at bind, before your stack — so
`input.email({ methods: ["lower"] })` / `input.text({ methods: ["trim"] })` make `inp("email")` /
`inp("name")` read already-normalized. Don't reroll the transform into a `var` (`inp("name")|trim`);
put `trim`/`lower`/`upper` on the input and read the clean value directly.

**Email/password auth (signup + login).** The trap: `input.password()` **hashes on bind**, so a
password typed that way is already a hash before your stack runs — `check_password` then compares
hash-vs-hash and login *always* fails. The fix is to take the password as **plain text** and let
the `f.password` *column* do the hashing on write; `check_password` compares the plaintext
submission against the stored hash.

```ts
const usersTbl = table({ name: "users", schema: {
  email: f.email({ required: true }), name: f.text(), password: f.password(),
} });

// Signup — plaintext in; the f.password COLUMN hashes on write.
query({ name: "signup", verb: "POST", apiGroup: authApi,
  input: { email: input.email({ required: true }), name: input.text(),
           password: input.text({ required: true, methods: ["min:6"] }) }, // NOT input.password()
  stack: [
    s.db.add({ table: usersTbl,
      row: { email: inp("email"), name: inp("name"), password: inp("password") }, as: "user" }),
    s.security.create_auth_token({ table: usersTbl, id: ref("user.id"), as: "token" }),
  ],
  response: ref("token") });

// Login — plaintext compared against the stored hash.
query({ name: "login", verb: "POST", apiGroup: authApi,
  input: { email: input.email({ required: true }),
           password: input.text({ required: true }) },                     // NOT input.password()
  stack: [
    s.db.get({ table: usersTbl, fieldName: "email", fieldValue: inp("email"),
               output: ["id", "email", "password"], as: "user" }),
    s.precondition({ expr: expr(ref("user"), "!=", c.null()),
      error_type: "accessdenied", error: c.text("Invalid email or password.") }),
    s.security.check_password({ text_password: inp("password"),            // plaintext
      hash_password: ref("user.password"), as: "ok" }),
    s.precondition({ expr: expr(ref("ok"), "=", c.bool(true)),
      error_type: "accessdenied", error: c.text("Invalid email or password.") }),
    s.security.create_auth_token({ table: usersTbl, id: ref("user.id"), as: "token" }),
  ],
  response: ref("token") });
```

Reach for `input.password()` only when you specifically want its bind-time hash **and** are not
also feeding it to `check_password` (issue #109).

</details>

<details>
<summary><b>CLI</b></summary>

```bash
sidestep init my-app                         # scaffold a full project (frontend/ + xano/)
sidestep init my-app --ai claude --no-install  # add CLAUDE.md; skip npm install

sidestep export ./xano/index.ts              # bundle to stdout
sidestep export ./xano/index.ts --out ws.json
sidestep compile ./xano/functions/get-user.ts  # a single function's JSON

sidestep export ./xano/index.ts --lock       # opt into xano.lock (created beside the entry)
sidestep export ./xano/index.ts --frozen-lock  # CI guard: fail if the export would change the lock
sidestep lock rename table users members     # move a lock entry after renaming in code
sidestep lock prune ./xano/index.ts --yes    # drop lock entries nothing exports anymore
sidestep lock adopt live-export.json --yes   # seed the lock from a live engine export

sidestep login                               # OAuth sign-in (once) — pick the instance + workspace at consent
sidestep workspace details                   # which instance/workspace am I bound to, and via which credential?
sidestep deploy ./xano/index.ts              # compile + import into a live ephemeral (the dev loop) → URL
sidestep deploy ./xano/index.ts --dest sandbox             # …or your throwaway singleton sandbox
sidestep deploy ./xano/index.ts --static ./frontend/dist   # also deploy a static frontend (onto the ephemeral)
sidestep deploy ./xano/index.ts --static ./frontend/dist --static-env PK=pk_live_1   # + extra public config
sidestep deploy --bundle ws.json             # deploy an already-exported bundle
sidestep ephemeral list                      # list your ephemeral environments (--all-workspaces spans every workspace)
sidestep ephemeral get <tenant>              # base URL, state, and expiry for one (<tenant> = the tenant name, e.g. ewap-8wz9-9e13, NOT the display name — `ephemeral list` shows it in bold)
sidestep ephemeral delete <tenant> --yes     # destroy one
sidestep ephemeral impersonate <tenant>      # open it in the builder (--guest = read-only; --url-only prints the URL instead)
sidestep release ./xano/index.ts             # promote to your main instance workspace (coming soon)
sidestep sandbox export                      # export the DEPLOYED sandbox workspace as a JSON bundle → ./sandbox.json
sidestep sandbox export --format multidoc --name backend               # …or the deployed sandbox as XanoScript → backend.xs
sidestep sandbox export --format multidoc --path -                     # …stream the multidoc to stdout (deploy first)
sidestep sandbox details                     # print the sandbox base URL + tenant details (pretty on a TTY, JSON when piped)

sidestep workspace details                   # which workspace your token is scoped to (instance, id, name, guid)
sidestep workspace export --out ws.json      # your REAL workspace as a JSON bundle
sidestep workspace codegen my-app            # …or as a runnable project (the pull direction)
sidestep sandbox codegen my-app              # same, from your sandbox
sidestep ephemeral codegen <tenant> my-app   # same, from an ephemeral (tenant first, path second)
sidestep codegen ws.json my-app              # …or from a bundle already on disk (offline, no auth)

sidestep profile me                          # print the scoped user + instance base URL (pretty on a TTY, JSON when piped)
sidestep logout                              # revoke the refresh token + clear the shared cache (--local for the project one)
sidestep version                             # print the installed @sidestep/core version
sidestep help                                # grouped command reference (also the no-arg default)

sidestep validate ./xano/index.ts            # import into a live instance, diff each object back
sidestep validate ./xano/index.ts --runtime  # also run each deployed function on the engine
sidestep validate ./xano/index.ts --capture  # write the fetched JSON as fixture candidates
```

After a command succeeds the CLI checks npm (at most once an hour, cached in
`~/.sidestep/update-check.json`) and prints a one-line nudge to **stderr** when a newer
`@sidestep/core` is published — never to stdout, so piped bundles stay clean. The suggested
command adapts to how you installed it (`npm i -g …` for a global install, `npm i -D …`
when it's a project dependency). The check is best-effort and bounded (a slow or offline
registry never delays a command), and stays silent under CI or when stderr isn't a terminal.
Opt out with `SIDESTEP_NO_UPDATE_CHECK=1` (or the conventional `NO_UPDATE_NOTIFIER=1`).

Emitters that write to disk (and the programmatic CLI) are Node-only — import them from
`@sidestep/core/node`. The string emitters (`emit`, `emitBundle`, `serializeBundle`) stay
on the browser-safe `@sidestep/core` entry.

```ts
import { emitBundle } from "@sidestep/core";        // pure string — browser-safe
import { writeBundle } from "@sidestep/core/node";  // writes a file — Node only
```

</details>

<details>
<summary><b>Validating against a live instance (<code>sidestep validate</code>)</b></summary>

`sidestep validate` proves your compiled output against a **real, running Xano
instance** — not a static snapshot. It compiles your workspace, imports it into a
**fresh ephemeral environment created for that run**, exports it back, and diffs it
against what you compiled, so you catch three classes of problem a local build can't:

1. **Import accepts** — the engine actually accepts the bundle (malformed-but-shaped output is rejected here).
2. **Round-trip parity** — the workspace the engine stores, re-exported in the same bundle format, matches your compiled JSON after normalization (full object logic included). Every authored kind is diffed — tables, functions, queries, triggers, tasks, and more — each object matched by identity and reported per kind.
3. **Runtime** (`--runtime`) — each deployed function actually runs on the engine, with logs surfaced on failure.

It talks only to public meta API routes — the **same** archive import `sidestep
deploy` uses, plus the workspace export — and never touches XanoScript. There is one
way into an instance, so a transport bug is one `validate` reproduces rather than
routes around.

It is non-destructive: nothing you own is written to. Each run creates its own
ephemeral environment, imports into that, and deletes it afterwards — including when
the import is rejected or a transport error is thrown. The environment carries a
short expiry, so even a killed process leaves nothing permanent behind. A fresh
environment per run is also what makes the diff trustworthy: the objects read back
can only have come from this bundle, never from what a previous run left.

**Setup** — copy `.env.example` to `.env` (gitignored) and fill in a base URL +
token. Switching between a cloud dev instance and a local Docker one is just a
different `XANO_VALIDATE_INSTANCE`:

```bash
# .env
XANO_VALIDATE_INSTANCE=https://your-instance.xano.io   # or http://localhost:8080 for local Docker
XANO_VALIDATE_TOKEN=your-meta-bearer-token
# XANO_VALIDATE_WORKSPACE_ID=…                          # optional; PARENT workspace the run's env is created under (default 1)
```

```bash
sidestep validate ./xano/index.ts                      # import + round-trip diff, reports per object (every authored kind)
sidestep validate ./xano/index.ts --runtime            # + run each deployed function
sidestep validate ./xano/index.ts --capture            # + write fetched JSON to ./validate-out (fixture candidates)
sidestep validate ./xano/index.ts --instance http://localhost:8080   # override the target for one run
sidestep validate --bundle ws.json                     # validate an already-exported bundle
```

Config comes from the environment (a `.env` is autoloaded; a real env var wins),
`--instance` overrides per run, and the token is env-only — never a flag. This
harness is deliberately separate from the `auth.json` credential the rest of the
CLI uses. A non-zero exit means a check failed; `--verbose` prints full diffs and raw
engine detail instead of a projected summary.

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

`login` also **pins the numeric workspace** you consented to into the credential, so every
later command acts on exactly that workspace without looking it up again. There is **no
`--workspace` flag** — a credential addresses exactly one instance and one workspace. Run
`sidestep workspace details` to see which.

The credential caches by default in a **shared** `~/.sidestep/auth.json`, reusable
from **any** project directory — so a single `sidestep login` covers all your projects.
Override the OAuth host with `--origin`/`$XANO_ORIGIN` and the loopback port with `--port`.

**Credential formats.** `auth.json` holds one credential, discriminated by `type`:

```jsonc
// type: "oauth" — written by `sidestep login`. Do not hand-edit.
{ "type": "oauth", "instance": "https://your-instance.xano.io", "workspace_id": 3, /* …tokens… */ }
```

```jsonc
// type: "token" — WRITE THIS YOURSELF. A meta API bearer token for the same
// meta APIs, for automation. No login flow, no refresh, no rotation.
{
  "type": "token",
  "instance_base_url": "https://your-instance.xano.io",
  "workspace_id": 3,
  "meta_api_token": "your-meta-api-token"
}
```

Both formats work at **either** location (project-local `./.xano/auth.json` or global
`~/.sidestep/auth.json`) on the same precedence ladder below, and both determine the same
thing: one instance, one workspace. A `token` credential is never created, refreshed, or
revoked by the CLI — `sidestep logout` just deletes the file, and the token itself stays
valid until you revoke it wherever you minted it. Save it with owner-only permissions
(`chmod 600`) and keep it out of git.

> **Upgrading:** this format is a break. An `auth.json` written before it is rejected with a
> message naming the fix — run `sidestep login` again.

**Project-local credentials** — pass `--local` to `login` to cache tokens in a
**project-local** `./.xano/auth.json` instead (which `login` **auto-adds to `.gitignore`**),
scoping the sign-in to that directory. Every command that **reads** credentials
(`deploy`/`details`, `profile me`, token refresh) resolves them **project-local first, global
as a fallback**: it uses `./.xano/auth.json` when present, otherwise `~/.sidestep/auth.json` —
so a `--local` project keeps working without repeating the flag. `login` and `logout` do
**not** fall back: they target the shared global cache unless you pass `--local`. An explicit
`--config`/`$XANO_CONFIG` always wins over everything.

`deploy <file>` runs the exact same pipeline as `export` (including `xano.lock`
seeding), then create-or-refreshes the target environment and imports the compiled
workspace into it as a full replace. `deploy --bundle <path>` skips the compile and uploads a
bundle a previous `export` wrote (handy in CI). A **projected, secret-free summary** prints to stdout
as JSON — `baseUrl` plus the workspace `id`/`name`, and the static URL (plus a `verified`
boolean reporting whether the frontend was confirmed live) when `--static` is used — while the
human-readable progress (and the live URLs) echoes to stderr. The raw
workspace blob is deliberately never dumped: it carries per-tenant secrets that must not land
in shell history or CI logs.

**Where it goes** — the instance your **token is bound to** (the token's `aud`), never a
flag. `sidestep deploy` create-or-refreshes an **ephemeral** (default) or resolves your
throwaway **sandbox** (`--dest sandbox`); production promotion is the separate
`sidestep release` path (coming soon) to your main instance workspace.

**Static host** — `deploy --static <dir>` archives a directory and deploys it to a
static host after the backend import. Its target follows the destination: with `--dest
ephemeral` the frontend lands **on the ephemeral itself** (backend + frontend in one
environment); with `--dest sandbox` it lands on your **own (parent) workspace**, since the
sandbox tenant does not serve static hosting. For the parent-workspace case the CLI resolves
which workspace from your token (`GET /api:meta/auth/me` — the scoped workspace guid mapped
to its numeric id) and uploads the archive to
`/api:meta/workspace/{id}/static_host/default/build` with your ordinary bearer. That route
auto-creates the `default` host and **auto-deploys to `dev`**, returning the live URL — so
the static step is independent of the backend deploy (the backend still runs first because
it's the primary action).

**Liveness verification** — the build endpoint returning `200` only means the archive was
*accepted*; the edge may still be starting a cold host (which `503`s for tens of seconds) or
briefly routing the previous build. So after the upload the CLI polls the deployed URL until
the static server reports it is serving **this** build — its `X-Xano-Canonical` response header
matches the canonical returned for the build just pushed — then prints `Frontend is live`. It
polls every second for the first 30s, then every two seconds out to 120s. An unconfirmed poll
is a **warning, not a failure** (the build uploaded fine and usually comes online moments
later; the exit code stays `0` and the summary records `"verified": false`). Verification is
skipped when the response carries no canonical to compare against. Pass **`--no-verify`** to
skip the wait entirely — useful for fast iterative deploys or when the deployed URL isn't
reachable from the machine running the CLI.

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
prebuilt `frontend/dist` can retarget any sandbox with no rebuild.

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

**CI & agents** run non-interactively either way: from `$XANO_REFRESH_TOKEN` +
`$XANO_CLIENT_ID` (both copied once from `auth.json` after a local `sidestep login`; the
target instance is read from the refresh token's `aud` and the workspace resolved per run),
or by dropping a `type: "token"` credential file in place — which needs no login at all and
carries its instance and workspace with it.

> **Automated agents:** authenticate with `$XANO_REFRESH_TOKEN` + `$XANO_CLIENT_ID`; do
> **not** invoke `sidestep login` (it blocks on interactive browser consent). Xano rotates
> refresh tokens on use, so a stored one may be single-use — mint one per job if exchanges
> fail. `deploy` writes to a disposable environment, so it's fine to run in a
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
| Object kinds | **12 / 30** — `function`, `table`, `query`, `api_group`, all 6 `trigger`s, `tool`, `mcp_server`, `agent`, `task`, `middleware`, `addon`, `workspace` |
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

**Write TypeScript. Run `sidestep deploy`. See it live.**

See [`@sidestep/auth`](https://www.npmjs.com/package/@sidestep/auth) for a real,
reusable extension package · [`llms.txt`](llms.txt) for the full authoring surface ·
MIT licensed

</div>
