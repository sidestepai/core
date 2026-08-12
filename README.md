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
what they fire on. Each table gets its own `table/<name>.ts`, settings sit in `xano/workspace.ts`,
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
runs, and more. **All 215 engine statement surfaces are authorable** — every field name
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
  // rows are keyed for you — 1..N for an int PK, a stable uuid for a uuid PK (or
  // set `id` on every row); a bad value
  // or unknown column is a loud error, never a silent drop.
  seed: [
    { sku: "SKU-001", name: "Aeron Chair",   price: 1395, tags: ["furniture", "ergonomic"] },
    { sku: "SKU-002", name: "Standing Desk", price: 599,  tags: ["furniture"] },
  ],
});
```

Deploy is a full replace, so re-deploying re-seeds cleanly — no duplicate rows. Seed
data travels only in the deploy package (resolved at deploy time); it never enters the
compiled workspace bundle.

For data in a file, use `seedFile`:

```ts
seed: seedFile("./products.seed.json", import.meta.url),
```

The path resolves against the file that declares the table, and it is read with `node:fs`
at deploy time. A thunk (`seed: () => import("./products.seed.json")`) also works and is
the right shape for *computed* seeds — but be aware it does **not** keep seed values out of
a frontend build: the `import()` lives in your module, so a bundler emits the JSON as a
served chunk, and any frontend that imports a def whose module graph reaches that table
ships the seed to the browser. `seedFile` stores a path string, which a bundler has nothing
to follow.

Either way, keep secrets out of `seed` — it is throwaway fixture data for disposable
environments. As a backstop, `sidestep deploy --static` refuses to publish a frontend build
containing seed values from columns your schema marks `access: "internal"` or `sensitive`
(pass `--allow-seed-in-static` if the data is deliberately public).

Typing is unaffected by the form you choose — the table's row type and column names stay
inferred.

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
- **Endpoint names hold `A-Z a-z 0-9 _ - /` and `{}`** — nothing else, capped at 200 chars.
  A `.` is the trap: Xano does not reject `name: "export.zip"`, it stores the endpoint with
  an *empty* name, so it deploys clean and then 404s `Unable to locate request.` on every
  request. `query()` throws instead. Name it `export_zip` or `export/zip` and set the file
  extension in the response headers. Same rule for `realtimeChannel` and `tool` names;
  `realtimeMessage` is narrower still (no `/` or `{}`).
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
`InferRow` erase to nothing — use `import type`). That cost is a **floor**, not a function of
how lean the def is: on a trivial Vite app, one def imported for one `getPath()` measured
37 kB minified against 784 B for a hand-written path string, and splitting modules reduces
the incremental cost of further defs but never the floor.

**Generate a route manifest instead.** It keeps the derived-not-hardcoded contract at
almost no bundle cost:

```bash
sidestep routes ./xano/index.ts --emit xano/routes.gen.ts
```

The emitted file is plain data plus one interpolator and imports nothing at all — the same
app builds to 1.7 kB. Route names and their `{param}` keys are still checked at compile
time, so a backend rename is a compile error rather than a 404:

```ts
import { routePath, ROUTES } from "../xano/routes.gen";

fetch(BASE + routePath("blog/{slug}", { slug }), { method: ROUTES["blog/{slug}"].verb });
```

Realtime is in the same file when the workspace has any: `socketUrl(server, baseUrl)` for the
websocket URL and `channelPath(channel, params)` for the path a frame's `channel` field takes,
both keyed and `{param}`-checked exactly like the routes. `socketUrl` is the equivalent of
`realtimeServer().getUrl()` down to the tenant rule — a base URL that names a tenant
(`https://host/tenant/ab-cd`, what deploy injects as `window.XANO_HOST`) is rewritten to the
socket's own `wss://host/ws/ab-cd:<canonical>` form, which is the one address a frontend has no
way to reconstruct:

```ts
import { socketUrl, channelPath } from "../xano/routes.gen";

const ws = new WebSocket(socketUrl("chat", window.XANO_HOST), token);
ws.send(JSON.stringify({ action: "join", channel: channelPath("rooms/{room_id}", { room_id }) }));
```

Add `--strict` in CI to fail when the committed manifest is out of date. A hand-typed
`ROUTES` table is the option that gives up both the bundle saving and the rename safety.

---

## Reference

**Where the exhaustive reference lives.** Every kind, statement, filter, and field type is
typed, so your editor's autocomplete is the fastest lookup — tab-complete `s.`, `f.`, `c.`,
`fl.`, `input.`. For the written catalog, the package ships two machine-readable files that
are generated from the SDK's own sources and can never drift from it: **`llms.txt`** (the
canonical tour — every signature, plus the engine behavior each one depends on) and
**`manifest.json`** (per-entry detail: full field schemas with engine defaults, filter
argument lists, stored-name mappings). Both are readable by people too.

What follows is the part neither of those replaces: the shape of a project, and the
behavior that will bite you.

<details open>
<summary><b>Project structure</b></summary>

Lay objects out however you like and register them explicitly — there's no folder
auto-discovery magic (deliberately):

```
xano/
├── function/     get_user.ts         export const getUser = defineFunction({...})
├── table/        table.ts            export const user = table({...})
│   └── trigger/  on_insert.ts        export const onInsert = tableTrigger({...})
├── query/        public.ts           export const publicApi = apiGroup({...})
│                 public/posts_GET.ts export const posts = query({...})
├── agent/        assistant.ts        export const assistant = agent({...})
├── realtime_server/ chat.ts               export const chat = realtimeServer({...})
│                 chat/room.ts              export const room = realtimeChannel({...})
│                 chat/room/send.ts         export const send = realtimeMessage({...})
├── workspace.ts                      export const workspaceSettings = workspaceConfig({...})
└── index.ts      workspace("my-app").registerTables([...]).registerFunctions([...])…
```

Objects nest under whatever owns them. Anything with children — an API group, a
realtime server, a channel — is a file named for itself sitting *beside* the folder
holding its children, so `chat.ts` opens in a tab you can tell apart and a group with
no queries needs no folder at all. Realtime is the deepest, being the only three-level
hierarchy in a workspace — server, then channel, then message — and a trigger sits in
a `trigger/` folder at whichever level it fires on.

Paths are lower case throughout — an HTTP verb is the one exception, because it is
the method rather than a word. Bindings keep the object's own casing, so a file name
and the symbol it exports can differ.

That is the shape `sidestep codegen` writes, and its `index.ts` re-exports every object
by name — import from the tree's root rather than from a file, since a file path moves
when an object's parent or its `_shared.ts` placement changes. Hand-authored projects are
free to use any other layout; only `index.ts` registering the objects matters.

`workspace("my-app")` is the natural entry point — sugar for
`new Xano().registerWorkspace({ name: "my-app" })`, returning the same chainable registry.
Authoring is **declarative def-objects** passed to factories; there is no callback/chaining
builder. `xano.export()` returns the importable `packageExport` bundle, and
`sidestep export`/`deploy` read the module's default export.

</details>

<details>
<summary><b>Object kinds</b></summary>

Every top-level Xano object is a registered kind with a factory and a `Xano.register*`
method: `defineFunction`, `table`, `query`, `apiGroup`, `tool`, `mcpServer`, `agent`,
`task`, `workflowTest`, `middleware`, `addon`, `realtimeServer`, `realtimeChannel`,
`realtimeMessage`, `microservice` (its own section below), `workspaceConfig`, and the seven
trigger factories below. Signatures and payload keys are in `llms.txt`; what follows is what
the types don't tell you.

**Triggers take a callback stack.** `stack: (t) => [...]`, not the plain array every other
kind uses — because a trigger's inputs are **implied by its type** (fixed by Xano, not
editable) and injected automatically. So triggers take no `input` field, and the typed
handle `t` is the only way to read them (`response: (t) => ...` on response-bearing types).
The seven types are `tableTrigger`, `realtimeServerTrigger`, `realtimeChannelTrigger`,
`mcpServerTrigger`, `agentTrigger`, `workspaceTrigger`, and `errorTrigger`; they share one
stored envelope discriminated by `obj_type`.

```ts
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
```

**A workflow test is an end-to-end test, and its `datasource` is the trap.** `workflowTest`
takes no `input` and no `response` — it calls other objects and asserts on what they bind.
Leave `datasource` off: the default `""` runs against an **empty** datasource. Naming one
makes the engine **clone** that datasource before every run, so pointing a test at
production-sized data is slow enough to fail the run outright. `"live"` warns at compile
time; every other name is your call.

```ts
workflowTest({
  name: "signup_works",
  tags: ["smoke"],
  // datasource omitted on purpose — "" is an EMPTY datasource, not "no datasource".
  stack: [
    s.function.call({ fn: createUser, input: { email: "a@b.c" }, as: "created" }),
    s.expect.to_be_defined({ expr: ref("created") }),
    s.expect.to_equal({ expr: ref("created.status"), value: c.text("ok") }),
  ],
});
```

**Realtime** — the only three-level containment chain in the SDK: `realtimeServer` owns
`realtimeChannel`s, which own `realtimeMessage` handlers (a message is the realtime
analogue of a query — its own typed payload and stack). Pass the **handle**, not a name: a
channel path is unique only within its server. A channel's `input` types its **path** params
(`rooms/{room_id}`); a message's `input` types the message **payload**. A server is off
until `enabled: true`.

```ts
const chat = realtimeServer({ name: "chat", enabled: true });

const room = realtimeChannel({
  name: "rooms/{room_id}",           // `input` types the PATH params
  server: chat,
  input: { room_id: input.int() },
  publish: { who: "authenticated" },
  conversation: { enabled: true, limit: 50 },   // client-visible transcript
});

realtimeMessage({
  name: "send",                      // `input` types the message PAYLOAD
  channel: room,                     // the handle carries the server too
  input: { body: input.text({ required: true }) },
  deliverTo: "channel",              // or "sender" (request/response) / "others"
  stack: [s.debug.log({ value: inp("body") })],
});
```

The client side is derived too, the same way `query().getPath()` works — `chat.getUrl(BASE)`
builds the socket URL (`wss://…/ws/<canonical>`, with a tenant base URL translated into the
socket's `/ws/<tenant>:<canonical>` form) and `room.getChannel({ room_id: 42 })` builds the
path a client joins. Both throw rather than guess. In a **browser bundle**, reach for the
generated manifest's `socketUrl`/`channelPath` instead — same addresses, same checks, without
importing the defs (see
[The payoff: a type-safe frontend, for free](#the-payoff-a-type-safe-frontend-for-free)).

Five traps account for most realtime bugs. The full wire protocol — every server frame,
the presence roster shape, the at-least-once client contract — is in `llms.txt`.

- **An empty return denies, and so does a crash.** `connect` and `join` are gates: return
  `{ allowed: true }` or any truthy value to admit. A stack that falls through, or a gating
  trigger with no `response`, refuses everyone — and a raise refuses too, because the gate is
  seeded with a deny it keeps when the stack throws. Both failure modes lock the door, so the
  risk to plan for is a self-inflicted lockout, not a breach: guard every drill inside a gate
  with `ref(path, { safe: true })`, since `db.get` binds `null` on a miss. `export()` warns on
  the missing `response`; nothing can warn about the raise. Gating is opt-in — a server with
  no `connect` trigger admits everyone.
- **Only `null` drops a message.** In a `deliver` trigger (per recipient) and in a message
  handler, `false`/`0`/`""` all deliver the message unchanged, and a crash broadcasts the
  sender's original unvalidated payload. Return `null` to suppress. So a redaction check
  written as a boolean sends the very message it was meant to hide.
- **`conversation: { enabled: true }` alone stores nothing.** `limit` defaults to `0`, and
  `0` means retain none. Always pass a `limit`. What a handler broadcasts *is* the stored
  row, so broadcast everything a future joiner needs to render it.
- **An idle socket is reaped after ~10 minutes.** A listen-only client (feed, dashboard,
  presence sidebar) must send `{ action: "ping" }` or any frame periodically, or it silently
  drops and reconnects forever.
- **`s.realtime.publish` is the push direction, and it is fail-soft.** It bypasses the
  channel's `publish.who` (authorization belongs in your stack), does not invoke the named
  message's handler, and swallows a missing or disabled server — a mis-targeted publish is
  silent. Pass the server handle and a filled-in path (`room.getChannel({ room_id: 42 })`),
  never the template.

**The superseded realtime layer.** Xano has had two realtime generations and they reuse the
same words. `realtimeTrigger(...)` and `s.api.realtime_event(...)` belong to the old
workspace-global layer; they are supported only so `codegen` can bring back a workspace that
holds them, and they are named under `## Legacy` in `llms.txt` rather than in its catalogs.
Aiming `s.api.realtime_event` at a current-layer channel publishes into the void — use
`s.realtime.publish({ server, channel, data })`, which names the owning server and so can
resolve the channel.

**MCP servers & agents** — both persist under the `toolset` payload key, so an `mcpServer`
and an `agent` **sharing a name collide**. A `tool({...})` is its own kind, referenced by
handle from either.

```ts
// Auth is PER-TOOL and works like a query's: name an auth table({ auth: true }).
mcpServer({ name: "books", tools: [{ tool: searchTool, auth: users }] });

const assistant = agent({
  name: "assistant",
  llm: { type: "xano-free", systemPrompt: "Be helpful.", prompt: "Answer the question." },
  tools: [{ tool: searchTool }],
});

// Agents have NO public endpoint — invoke them in-stack from any host with a stack.
query({
  name: "ask", verb: "POST", apiGroup: api,
  input: { question: input.text({ required: true }) },
  stack: [s.ai.agent.run({ agent: assistant, args: obj({ question: inp("question") }), as: "answer" })],
  response: { text: ref("answer.result") },
});
```

- **The run result is an envelope, not the completion.** The model's text is at **`.result`**
  — `ref("answer")` is the whole metadata object (`finishReason`, `steps`, …). Both are
  typed, so `InferResponse` reflects either.
- **`llm` is a provider-discriminated union** — `anthropic` / `openai` / `google-genai` /
  `xano-free` (which needs no API key) — each with its provider's typed fields.
- **Structured output types the call site.** Author `output: { schema: { … } }` on the agent
  with the `input.*` catalog and `.result` is typed from it wherever the handle is passed —
  no second witness. The type-only `resultShape` is only for overriding that, or for an
  agent referenced by bare name.
- **String settings are Twig-templated at run time.** The `args` you pass to
  `s.ai.agent.run` become `{{ $args }}` (env vars are `{{ $env.NAME }}`), which is how an
  endpoint's inputs reach the prompt. Numeric and boolean fields are not templated. Build a
  dynamic arg with `obj({...})`, not `c.obj`.
- **`mcpServer().getUrl(HOST)`** derives the Streamable-HTTP endpoint from the def, the same
  contract as `query.getPath()`. Agents expose only `getCanonical()`.

**Background execution.** `s.function.run` and `s.ai.agent.run` take a `runtime` block
(`{ mode: "async-shared" }`, or `"async-dedicated"` with `cpu`/`memory`/`timeout`/`maxRetry`)
that moves the call off the request path. This is **not** a performance knob: Xano rewrites
an async call to a statement that dispatches and continues, so it does not return the
function's result — don't bind `as` expecting a value. Collect results later with
`s.await({ ids })`.

</details>

<details>
<summary><b>Microservices</b></summary>

A microservice is a container workload deployed alongside the workspace and called from a
stack with `s.microservice.request`. Two mutually exclusive shapes chosen by `kind`: `builtin`
declares containers (image/ports/resources/env/command/args) plus optional `ingresses`, and
`helm` points at a chart and its `values`; passing both throws.

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

Call it by passing the def itself. `port` folds into the single `"name:port"` host string
the engine reads, and is optional — a microservice exposing exactly one `servicePort`
resolves to it, and one exposing several requires it. A port the microservice doesn't expose
is a type error where the def's ports are known, and a build-time throw otherwise:

```ts
s.microservice.request({ as: "res", host: echo, path: "/health" });
```

Only `host` and `path` are required. `method`, `params`, `headers`, `timeout`, and
`follow_location` default to the engine's own values (`GET`, `{}`, `[]`, `10`, `true`) and are
always written — this statement's schema requires them, so they can't be left off the wire;
you just don't have to type them.

`host` binds by name, not by guid, because that is how the engine resolves it — so renaming
a microservice fixes every call site at once. A plain `"name:port"` string is also accepted
and is the only way to reach an instance-level microservice, which isn't a workspace object;
nothing checks that spelling, so prefer the def wherever there is one.

A container takes time to come up, so `sidestep deploy` waits for it: after the import it
reads each microservice and reports whether it is ready, still starting, or failed, then
lists them. A microservice that hasn't come up in time is a warning, not a failed deploy: the
backend is already live and the container usually follows moments later. Skip the wait with
`--no-verify`. The same report is available any time from `sidestep ephemeral get <env>`,
`sidestep sandbox details`, and `sidestep workspace details`.

`tenantDeploy: "manual"` rows are reported but never waited on — nothing starts them for you.
Reach for it when the row should exist without a workload behind it; `examples/sandbox` uses
it so deploying the examples doesn't wait on containers.

**This surface is early and expected to change.** `configs` and `volumes` are typed but
unconfirmed against a live engine. And two fields carry secrets into a pulled tree
verbatim — `chart.values` and `registryAuth.dockerconfigjson` — because otherwise a pulled
microservice could not be redeployed. Prefer leaving `dockerconfigjson` unset and supplying
it out of band.

</details>

<details>
<summary><b>Middleware, request history &amp; env vars</b></summary>

A `middleware({...})` is reusable logic (`input`/`stack`/`response` + `resultStrategy:
"merge"|"replace"` + `exceptionPolicy`). To run one, *attach* it with a host's
`middleware: { pre, post }` field on `query`/`apiGroup`/`defineFunction`/`task`/`tool`
(not triggers). Prefer a def handle over a bare name, the same rule as `auth`/`apiGroup`
references; `{ middleware: mw, active: false }` keeps an entry but disables it.

```ts
query({
  name: "get_user", verb: "GET", apiGroup: blog,
  middleware: { pre: [rateLimit], post: [audit] },
  stack: [/* ... */], response: ref("user"),
});
```

- **`exceptionPolicy` decides whether a guard is a guard.** `"silent"` **is the default**
  and swallows the throw, so a rate limit or auth check authored without an explicit policy
  is **not enforced**. `"rethrow"` aborts the request and surfaces the authored
  `error`/status (a tripped `s.redis.ratelimit` → 429) while still running `post`;
  `"critical"` is the same but skips the `post` chain. That is the only difference.
- **Inheritance is override, not merge.** Providing a phase overrides it; omitting a phase
  inherits the parent tier's chain, resolved at request time **Query → API Group →
  Workspace**. `pre: middleware.clear()` overrides a phase with nothing.
- **Setting `workspaceConfig.middleware` at all emits the whole map.** Any host/phase you
  don't list is emitted empty, which **clears** that tier on deploy. Omit the field entirely
  to leave the workspace's existing middleware untouched. The same wholesale rule applies to
  `datasources`.
- **`auth()` is `null` on a public host**, and a `pre` middleware runs after auth resolution.
  A rate limit keyed by `auth("id")` on a public endpoint collapses every caller into one
  bucket, silently. `export()` warns on direct attachment of an `auth()`-keyed middleware to
  a host where `auth()` may be null.
- A `resultStrategy: "replace"` middleware attached `post` rewrites the response at runtime,
  which `InferResponse` can't see — declare `responseShape` on the endpoint.
- `workspaceConfig` also carries `realtime`, `documentation`, and `swagger`, which are
  server-shaped and carried verbatim rather than authored. `realtime` there is the **legacy**
  workspace-level block, not the realtime primitives you author.

**The canonical rate-limit middleware.** Build the per-user key with the filter chain
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

query({ name: "create_post", verb: "POST", apiGroup: blog, auth: users, // authed ⇒ per-user
  middleware: { pre: [writeRl] }, stack: [/* ... */], response: ref("post") });
```

On a **public** endpoint key off the client IP instead — `sys.remoteIp()` — since
`auth("id")` is null there. And note the **shared-bucket rule**: co-attaching one middleware
object to N hosts means all N share the same key and therefore one counter, so `max: 10` is
a global budget across them. Vary the key (fold the host name into the prefix) for an
independent limit per host.

**Reading the request body in a `pre` middleware.** It does receive the host's inputs, via
`s.util.get_all_input({ as: "payload" })` — but the result is **wrapped as `{ type, vars }`**,
so a body field lives at `ref("payload.vars.<field>")`. The un-nested path is the usual cause
of an `Unable to locate var` 500.

**Request history** — the per-object execution trace behind Xano's debugger, authored as a
single scalar `history` field: `false` off, `true` on at the default depth, a **number** =
capture depth (statement executions recorded per record, *not* records retained), `"all"` =
unlimited. **Omitting it inherits**; any value stops inheriting. Inheritance resolves
**object → container → workspace** (a query from its API group, a tool from its
toolset/agent, everything else straight from the workspace). Per-kind defaults when
inheriting: query / task / tool capture **on**; function / trigger / middleware **off**.
`workspaceConfig.history` is wholesale in the same way the middleware map is.

```ts
query({ name: "get_user", verb: "GET", history: 100 });   // capture, depth cap 100
apiGroup({ name: "blog", history: false });               // default for its queries
workspaceConfig({ history: { query: 100, trigger: "all" } });  // name inherited from workspace("…")
```

**Workspace environment variables** — author them as a name→value map on the workspace
object; read them at request time with `env("NAME")`:

```ts
workspaceConfig({
  name: "my-app",
  env: {
    STRIPE_KEY: process.env.STRIPE_KEY!,          // sourced from the deploy environment
    APP_BASE_URL: "https://my-app.example.com",   // a plain config value
  },
});
```

**Values are secrets.** Prefer sourcing them from the deploy environment over committing
literals, and don't commit a compiled bundle holding real ones. Deploying sets the vars you
declare; omit the field to leave the workspace's existing env untouched.

</details>

<details>
<summary><b>Tables &amp; fields</b></summary>

`f.*` covers the full column catalog — scalars, `f.timestamp`, the four file resources, the
six `f.geo.*` types, `f.enum(values)`, `f.vector(size)`, `f.object(children)`. Foreign keys
are `f.tableRef(table)`, whose link resolves to the target table's guid at export. Any
scalar becomes a **list column** with `{ array: true }`, surfacing as `string[]` in
`InferRow`. Tables take a named-map schema, filter methods carry args (`"min:8"`), and
`views[]` encode through the shared comparison encoder.

- **A column `default` must stay within the BMP.** A 4-byte character (codepoint > U+FFFF,
  e.g. an emoji) is mangled into invalid UTF-8 by the engine's default pipeline, so it is
  rejected at export rather than 500ing at deploy with Postgres `22021`. Accents, `€`, and
  most CJK are fine; otherwise put the value on an endpoint input, applied at runtime bind.
- **`id` and `created_at` auto-inject** at the head of the schema unless `system: false` or
  you declare them (`idType: "uuid"` for a uuid key). Both are usable wherever a column name
  is expected and both appear in `InferRow`. The standard indexes — `primary(id)`,
  `btree(created_at desc)`, plus `gin(xdo)` when the table stores fields as JSON —
  auto-prepend, de-duped against your own. Declare yours as
  `{ type, fields: [{ name, op? }] }`; `"unique"` is shorthand for `"btree|unique"`.
- **`use_xdo` picks the storage mode** — every field as JSON under the internal `xdo` column,
  or a real Postgres column per field. It is a workspace setting (default `false`) each table
  mirrors, overridable per table with `table({ useXdo })`, resolved at `export()` so the two
  can register in any order.

</details>

<details>
<summary><b>Statements, values &amp; inputs</b></summary>

The `stack` of a function/query/tool is a list of statements, all reachable through one
discoverable, typed namespace — `s`:

```ts
stack: [
  s.set_var("total", c.int(0)),
  s.math.add({ name: "total", value: c.int(5) }),
  s.array.find({ as: "hit", expr: ref("items"), if: expr(ref("$this"), "=", c.int(1)) }),
  s.conditional({ when: expr(ref("total"), ">", c.int(0)), then: [s.return(ref("total"))] }),
  s.function.run({ fn: getUser, as: "u", input: { id: ref("total") } }),
]
```

Tab-complete `s.` to explore. Each declarative statement takes one typed args object;
control-flow specials (`s.set_var`, `s.conditional`, `s.for`, `s.foreach`, `s.while`,
`s.group`, `s.switch`, `s.try_catch`, `s.return`, …) keep their authored signatures. **Every
statement also carries `description` and `disabled`** — inline on the object-arg factories,
a trailing options object on the positional specials. `disabled: true` is Xano's
commented-out state: the step stays in the stack and the engine skips it.

**Fields with a fixed set of values take a bare literal.** Where the engine accepts only
certain spellings, the field's type is that set, so autocomplete offers them and a typo is a
compile error rather than a runtime failure after deploy:

```ts
s.ai.external.mcp.tool.run({ url, tool, connection_type: "stream" }) // ✅ "sse" | "stream"
s.ai.external.mcp.tool.run({ url, tool, connection_type: "streaming" }) // ❌ compile error, and throws
s.ai.external.mcp.tool.run({ url, tool, connection_type: inp("mode") }) // ✅ resolved at runtime
```

`"stream"` and `c.text("stream")` encode identically — use whichever reads better. A value
the SDK can't evaluate (an `inp`/`ref`, or anything with a filter chain) is never checked,
so a computed field stays authorable.

**The db family.** Single-record reads and mutations match one field
(`{ fieldName, fieldValue }`, defaulting to `id`) — there is no composite `(a, b)` form; for
a two-column lookup use `s.db.query` with a `where` array. Writes take a partial `row: {…}`,
and an `s.db.edit` writes **only** the columns you list, leaving every unmentioned column at
its stored value. Only `s.db.query` takes a `where`, and its `where`/`sort`/`paging`/`output`
are applied **by the engine**, not in your stack.

What each op binds decides your response type: `s.db.get` binds **`null`** on a miss (it does
not throw — null-check it), `s.db.add`/`edit`/`patch` bind the **full written row** including
auto-assigned `id`/`created_at`, `s.db.del` binds `null`, and `edit`/`del` **throw**
`NotFound` (404) when nothing matches. `InferResponse` derives all of that automatically.

`s.db.query` mirrors the whole Xano query builder — `returnType`, `bind` joins, computed
`eval` columns, `aggregate` groups, `distinct`, and the full operator set via
`cmp(left, op, right)` with `and(...)`/`or(...)` for boolean groups. Signatures are in
`llms.txt`; four behaviors are worth knowing here:

- **A join condition spells its two sides differently.** The joined table's column takes its
  `as` alias; this query's own columns stay bare:
  `bind: [{ table: users, as: "author", join: "left", where: expr(col("author_id"), "=", col("author.id")) }]`.
  Qualifying your own column by the table's name (`col("posts.author_id")`) resolves only if
  the query also sets `tableAlias` — the alias the qualifier is matched against. Unqualified,
  the engine reads the operand as a text literal and fails at runtime with a parse error
  naming the *other* operand, so `db.query` rejects that spelling at export instead.

- **Paging changes the response shape.** Supplying `paging` with metadata on (the default)
  returns a **paging envelope** — `{ items, curPage, nextPage, prevPage, offset, perPage,
  itemsReceived }`, plus totals when `totals: true` — instead of a bare `Row[]`, and
  `InferResponse` reflects that. Pass `metadata: false` to keep the bare array. Read
  `nextPage` (`number | null`) as the typed has-next signal.
- **Don't author `mixed(...)` conditions.** Xano's editor allows a container whose terms
  don't all join the same way, so pulled workspaces contain it and it round-trips — but the
  stored form doesn't record the intended grouping, and the two places it can appear
  disagree: a branch folds terms strictly left to right (`a OR b AND c` = `(a OR b) AND c`)
  while a `db.query` filter inherits SQL's AND-before-OR precedence (`a OR (b AND c)`). Write
  `and(or(a, b), c)` or `or(a, and(b, c))` — each says exactly one thing in every context.
- **An aggregate `name` is written bare** (`"status"`) and alias-qualified on emit; the
  engine rejects a bare column in an aggregate, and an already-dotted joined column passes
  through. The statement also declares the alias it qualified with, so the qualified name
  resolves — nothing to set by hand.

**Addons** enrich each returned row with related data, attached to the row-returning ops
(`query`/`get`/`add`/`edit`/`patch`). An addon is a single table-bound db query rather than a
statement stack: `addon({ table, where, output, cardinality })`, where `where` binds it to
the parent row and `cardinality` shapes the graft (`"single"` object, the default `"list"`,
`"count"`, `"exists"`, `"aggregate"`).

```ts
export const authorAddon = addon({
  name: "author",
  table: userTable,
  where: expr(col("id"), "=", inp("user_id")),   // bind to the parent row
  output: ["id", "name"],
  cardinality: "single",
  input: { user_id: input.int({ required: true }) },
});

s.db.query({
  table: post,
  addon: [{ addon: authorAddon, as: "_author", input: { user_id: out("author") } }],
  as: "rows",
});
```

Attaching a typed handle merges the graft onto the row shape in `InferResponse` with no cast;
a **bare-name** reference grafts `unknown`. Author `as` relative to a row (`_author`) — when
the query returns a paging envelope the `items[]` offset is added for you. If an alias
**shadows an existing column** the build throws, because the engine would silently overwrite
that column at runtime (Xano convention: prefix with `_`).

**Values** — `c.int/text/bool/decimal/null/obj/array`, `c.now()`, `ref(var)`, `inp(input)`,
`col(name)`, the context refs `auth(path?)`/`env(name)`/`setting(name)`/`sys.*()`, and
`out(name)` for a parent-row column in an addon input. `withFilters(value, fl.a(), fl.b())`
attaches the value pipeline from a typed catalog of filters generated from the engine's own
sources.

- **`c.obj`/`c.array` take plain JSON literals only.** A nested tagged value
  (`inp`/`ref`/`auth`/`c.*`) is a compile error. For a computed object — a response, or an
  `api.request` `params` — use a record of values (`{ count: ref("count") }`). For a dynamic
  object argument use `obj({...})`, which builds a checked expression.
- **An `obj({...})` member may carry a filter chain.** That matters most for the null-safe
  drill: `db.get` binds `null` on a miss, so `obj({ city: ref("row.address.city", { safe: true }) })`
  is the normal shape — no per-member `s.set_var` to hoist it out. `c.now()`, `env()` and
  `sys.*()` are members too.
- **A bare scalar works in any `fl.*` argument.** `fl.get("a.b", 0)` encodes identically to
  `fl.get(c.text("a.b"), c.int(0))`; strings, numbers and booleans are all wrapped for you.
  Objects and arrays still need `c.obj`/`c.array`.
- **`col()` does not resolve to a stored value inside a `db.edit` `row`.** To
  read-modify-write a column — incrementing a counter — `db.get` the row first and pipe its
  bound value through a filter. `col()` evaluates to `null` there, so `fl.add(1)` computes
  `null + 1` and the engine aborts.

  ```ts
  s.db.get({ table, fieldValue: inp("id"), as: "current" }),
  s.db.edit({ table, fieldValue: inp("id"), row: { clicks: withFilters(ref("current.clicks"), fl.add(c.int(1))) } }),
  ```

  That pair is **not atomic** — concurrent writers can lose an increment, and no atomic
  increment statement exists. A genuinely safe counter needs the arithmetic in the database
  via `s.db.direct_query`, which in turn needs the table's *physical* Postgres name; that
  name is assigned at import and is not knowable from a `table()` def, so it has to be
  hardcoded after inspecting the deployed table. A typed path requires an engine change
  ([issue #35](https://github.com/sidestepai/core/issues/35)).
- **A JavaScript body is written as a function, not a `c.text` string.** The lambda
  statement (`s.lambda`) and eight filters (`fl.map`/`filter`/`some`/`every`/`find`/
  `findIndex`/`reduce`/`lambda`) run JavaScript against a small, closed set of injected
  identifiers — and which ones are in scope depends on the surface. Write the body inline
  and the **surface is implied by where it sits**: the bindings are the function's
  parameters, typed from the position, so your editor supplies them and a wrong name is a
  compile error rather than a wrong value in production.

  ```ts
  // reduce's accumulator is `$result`. Autocomplete says so; `$acc` does not compile.
  withFilters(ref("prices"), fl.reduce({ initial_value: 0, code: ({ $result, $this }) => $result + $this })),

  // A map body, typed as a map body — nothing names the surface.
  withFilters(ref("prices"), fl.map(({ $this, $index }) => $this * ($index + 1))),

  // The statement surface binds ambient state only: `$this` here is a compile error.
  s.lambda({ as: "total", code: ({ $var }) => $var.subtotal * 1.2 }),
  ```

  The parameters are a fiction — only the **body** is sent, and the engine injects the
  bindings as free identifiers — so destructure them. `(b) => b.$this * 2` would emit
  `return b.$this * 2` with `b` undefined at runtime, and the SDK refuses it.

  For a body built away from its call site, `lam.*` names the surface explicitly:

  ```ts
  const rate = 0.2;
  // Nothing from the enclosing scope crosses implicitly — declare what the body needs.
  s.lambda({ as: "vat", code: lam.fn(({ $var }, { rate }) => $var.total * rate, { surface: "s.lambda", capture: { rate } }) }),
  ```

  Omit `surface` and the check is deferred to wherever the body lands, which is the thing
  that knows. `lam.file("./lambdas/total.ts")` (from `@sidestep/core/node`) reads a
  default-exported function of the same shape from its own type-checked module — the
  deterministic option under a bundler, where a function's own source is whatever the
  bundler emitted. `lam.raw(code)` is the text escape hatch, guarded identically. The full
  binding table per surface is in `llms.txt` under **Lambda bodies**.

  Three things to know, all live-verified against a real engine:

  - A body that **throws does not fail the request** — the engine returns its diagnostic
    text as the value with HTTP 200, so the failure arrives as bad data rather than an
    error. That is engine behavior and not interceptable from an SDK; validate before
    consuming a lambda result numerically, and prefer an authored body, which cannot fail
    that way for a binding reason.
  - The body is a **function body, not a module**: it must `return`, and a top-level
    `import` is a syntax error. Reach a dependency with dynamic `import()`.
  - `console` output goes to the **request log**, not stdout.

  A plain `c.text(...)` body is still accepted and gets the same build-time check — the
  guard sits at the call site, not inside `lam.*` — so an unknown `$identifier` fails
  whichever way you write it ([issue #221](https://github.com/sidestepai/core/issues/221)).
- **`c.expression("…")` is carried through verbatim and NOT validated.** SideStep does not
  parse it or type-check it; nothing inside participates in `InferResponse`, so a var named
  there is invisible to a rename that updates every typed `ref()`. A malformed expression
  fails at runtime; one that is merely wrong (`$var.tota1`) returns a wrong answer. Reach for
  it only for syntax the typed surfaces can't express — `~` concatenation, inline arithmetic,
  conditionals — and note it is **not** the `expr()` condition builder.
  (`c.expressionLegacy` exists only so `codegen` can return an older stored form.)

**System / request variables (`sys.*`).** Xano's built-in request context reads as
`$env.$remote_ip` in XanoScript — note the **second `$`**: these are settings with a
`$`-prefixed name, the same tag `env()` emits. That prefix is the footgun, because
`env("remote_ip")` reads a workspace env var literally named `remote_ip` (almost always
unset → null) rather than the caller's IP. `sys.*` spells the prefixed names for you:

| accessor | var | | accessor | var |
|---|---|---|---|---|
| `sys.remoteIp()` | `$remote_ip` | | `sys.datasource()` | `$datasource` |
| `sys.requestMethod()` | `$request_method` | | `sys.branch()` | `$branch` |
| `sys.requestUri()` | `$request_uri` | | `sys.tenant()` | `$tenant` |
| `sys.requestQueryString()` | `$request_querystring` | | `sys.release()` | `$release` |
| `sys.httpHeaders()` | `$http_headers` | | `sys.platform()` | `$platform` |
| `sys.requestAuthToken()` | `$request_auth_token` | | `sys.isDebugger()` | `$debugger` |
| `sys.apiBaseUrl()` | `$api_baseurl` | | | |

`setting("$<name>")` covers anything `sys` doesn't. The one that matters most in practice is
`sys.remoteIp()`, the rate-limit key for public endpoints.

**Inputs** — `input.*` mirrors `f.*` exactly: every engine-legal field type is a valid
function/query input, with `input.object(children)` and `input.list(element)` for structured
shapes. Comparisons use `= != > < >= <=`.

**Validate input at the boundary.** Field types don't enforce arbitrary
rules, and `s.precondition` raises a **status-bearing** error (`error_type: "badrequest"` →
HTTP 400) a client can detect via `res.ok` — unlike `s.throw`, which returns 200 with an
error body:

```ts
s.precondition({
  // `fl.regex_test` is PATTERN-piped: the piped value is the regex and the arg is the
  // text tested — the reverse of `istarts_with`. Build the pattern with `c.regex(...)`,
  // which delimiter-wraps it (a bare `c.text("^…")` is an invalid PCRE matching nothing).
  expr: expr(withFilters(c.regex("^https?://", "i"), fl.regex_test(inp("url"))), "=", c.bool(true)),
  error_type: "badrequest",
  error: c.text("url must be an http(s) URL"),
})
```

**Normalize on the input, not in the stack.** `methods` run at bind, before your stack, so
`input.email({ methods: ["lower"] })` makes `inp("email")` read already-normalized. Don't
reroll `trim`/`lower`/`upper` into a var.

**Email/password auth.** The trap: `input.password()` **hashes on bind**, so a password
typed that way is already a hash before your stack runs, and `check_password` then compares
hash against hash — login always fails. Take the password as **plain text** and let the
`f.password` *column* hash it on write; `check_password` compares the plaintext submission
against the stored hash.

```ts
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

Reach for `input.password()` only when you specifically want its bind-time hash **and** are
not also feeding it to `check_password`.

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
sidestep <command> --help                    # that command's usage, subcommands, and flags (`sidestep deploy --help`)
sidestep <noun> <verb> --help                # scoped to one verb (`sidestep workspace codegen --help`)
sidestep completion zsh                      # shell completion script (also bash, fish) — see below

sidestep validate ./xano/index.ts            # import into a live instance, diff each object back
sidestep validate ./xano/index.ts --runtime  # also run each deployed function on the engine
sidestep validate ./xano/index.ts --capture  # write the fetched JSON as fixture candidates
```

### Shell completion

`sidestep completion <bash|zsh|fish>` prints a completion script covering every command, verb, flag,
and closed value set (`--dest ephemeral|sandbox`, `--format json|multidoc`, `--ai claude|codex|cursor|none`).
It is generated from the CLI's own command table, so it never drifts from what the CLI accepts — but it
is baked at generation time, so re-run it after upgrading.

```bash
# zsh
sidestep completion zsh > "${fpath[1]}/_sidestep"   # then restart your shell

# bash
sidestep completion bash > ~/.sidestep-completion.bash
echo 'source ~/.sidestep-completion.bash' >> ~/.bashrc

# fish
sidestep completion fish > ~/.config/fish/completions/sidestep.fish
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

- **`llms.txt`** — the concise plaintext grounding doc for **authoring**: object def shapes,
  statements, values, fields, filters, and the non-obvious rules in `## Gotchas`. It does not
  document the CLI — `sidestep <command> --help` and the `cli` array below do, from the same
  registry that generates the shell completions.
- **`manifest.json`** — the exhaustive reference tier, reached by targeted lookup (grep or
  `jq` one entry; never read it whole). Every object kind (factory, `Xano.register*` method,
  payload key), every statement surface (the `s.<path>` accessor, stored `mvp:` name, and a
  typed field schema for the 154 declarative statements), the value constructors, the tag
  catalog, the filter catalog, and every CLI command and flag — plus live coverage counts.

Both derive from the SDK's own sources of truth (so they can't drift), regenerate with
`npm run manifest`, and are available at runtime via `buildManifest()` / `renderLlmsTxt()`.

</details>

<details>
<summary><b>Coverage &amp; scope</b></summary>

SideStep emits only (the engine imports/executes). Fidelity is proven by deep-equal against
the real Xano engine golden fixtures, and a coverage report prints on every test run.

| Surface | Coverage |
|---|---|
| Object kinds | **24 / 30** — counted over the engine's catalog, where each trigger type is its own kind |
| Statements (via `s`) | **215 / 215 (100%)** — every engine statement surface has a factory |

The six engine kinds you cannot author here are `tablemap`, `run.job`, `run.service`, the
superseded `realtime_channel`, and — correctly, since they are instance state rather than
workspace source — `branch` and `market_item`. `llms.txt` names them with
their reasons, and both numbers are regenerated from the SDK's own catalogs rather than
written down, so this table cannot drift from what the code does.

The statement catalog is generated from the engine's own schemas (`npm run codegen`), with
the non-declarative remainder hand-authored. **Reachable ≠ byte-verified**: every surface is
authorable, but a structural special without a persisted golden yet emits a shape *modeled*
on the engine schema, to be deep-equal'd against fixtures as they are captured.

**Out of scope** — reimplementing the engine's XanoScript parser, executing objects at
runtime (SideStep only compiles), and generating engine-side numeric ids/timestamps.
(Object guids and canonicals *are* handled — deterministically derived or frozen via
`xano.lock`.)

**Deferred (by design)** — folder auto-discovery, and the `service` / `vault` / `branch`
payload sections. (Round-trip decompile is no longer deferred: that is
`sidestep codegen`, above; nor is `workflow_test` — it is a first-class kind, see
`workflowTest` above.) `InferResponse`
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
