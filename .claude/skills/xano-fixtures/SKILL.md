---
name: xano-fixtures
description: >-
  Use this whenever the user is working with byte-exact test fixtures — a.k.a.
  goldens, the conformance corpus, or the byte-verify list — in the
  @sidestep/core SDK, where compiled output must match what a real Xano engine
  persists as JSON. Reach for it to: add, wire, source, capture, or promote a
  fixture/golden for a statement or kind; get a captured object into
  test/fixtures/ or off the pending list; prove something byte-matches or
  round-trips against a real (live/local/Docker) engine before trusting it; or
  debug a red corpus/golden test — a round-trip mismatch, a normalize() diff, an
  extra/missing key, a wrong const:* tag, run[] nesting — and decide whether it's
  a normalize/strip rule or a genuine encoder bug. Skip for: statement/factory
  feature work in src/, CLI auth/token setup, conceptual XanoScript questions,
  deploy errors, or release chores.
---

# Xano conformance fixtures

Fixtures are the SDK's **byte-fidelity oracle**: raw *persisted* JSON that a real
Xano engine returns after importing an object. A conformance test passes only
when `normalize(compile(authored))` deep-equals `normalize(fixture)`. That
equality is the whole game — it proves the SDK's encoder emits exactly what the
engine would persist, not merely something plausible.

This skill covers the full loop: **source a golden → vendor it → wire a corpus
row → run the tests → interpret the diff → guard the broader surface.**

Two hard rules from the project's CLAUDE.md, non-negotiable in anything you
write:
- Treat Xano as a **third party we don't control**. We validate against it; we
  don't "fix" it from here.
- **Never leak Xano source detail** (internal statement/function names beyond the
  public `mvp:*` wire names, repo names, file paths) into shipped code, the
  README, or `.env.example`. Test files already reference an internal source dir;
  mirror what's there, don't expand it.

## The mental model (read this first)

- **Fixture** = one object's persisted JSON, under `test/fixtures/<category>/<name>.json`.
  Categories: `statements/`, `tables/`, `fields/`, `query/`, `misc/`, `triggers/`,
  `toolset/`, `workspace/`. Plus the top-level `golden-set-var-function.json`.
- **Corpus row** = a hand-written `{ fixture, build }` entry in
  `test/conformance/corpus.test.ts` that pairs a fixture file with the authoring
  expression that should reproduce it. **A fixture file with no row is never
  exercised.** Discovery is the `STATEMENT_CORPUS` array itself — there is no
  glob, no manifest index.
- **normalize()** (`src/validate/normalize.ts`) strips engine-generated noise
  (server keys, empty-default envelope members, number/string serialization
  quirks) from both sides so the diff reflects only *authored logic*. It ships in
  `src/` because `sidestep validate` needs it at runtime;
  `test/helpers/normalize.ts` is a one-line re-export. One source of truth.
- **`sidestep validate`** imports a compiled bundle into a disposable sandbox
  tenant, reads the objects back, and diffs them. `--capture` writes the
  fetched-back JSON as fixture **candidates** — the live-engine way to source a
  golden instead of vendoring by hand. Note the **granularity**: capture round-trips
  *functions*, so each candidate file is a whole **function object** (with a `run[]`
  array of statements). A *statement* fixture is a single statement — one `run[N]`
  entry — not the whole function. Promotion has to account for that (see
  [Capture from live](#capture-a-golden-from-a-live-instance)).

## Decision: which task am I doing?

| The ask | Go to |
|---|---|
| "Add / wire up fixture for `<statement>`" | [Add a fixture](#add-a-fixture) |
| "Capture a golden from a live instance" | [Capture from live](#capture-a-golden-from-a-live-instance) |
| "The corpus / golden test is failing" | [Interpret a diff](#interpret-a-failing-diff) |
| "Keep examples/sandbox in sync" | [examples/sandbox](#examplessandbox) |
| "Ship / release checklist" | [Release hygiene](#release-hygiene) |

---

## Add a fixture

The single highest-leverage work — see the `@TODO(byte-verify)` worklist at the
top of `test/conformance/corpus.test.ts` for the pending list. Four steps:

**1. Get the persisted golden JSON.** Two sources:
- **Capture from a live instance** (preferred when you have one configured) —
  see [Capture from live](#capture-a-golden-from-a-live-instance). This fetches
  exactly what today's engine persists.
- **Vendor from the existing golden set** — the worklist comment names the source
  dir. Copy the object's JSON verbatim.

**2. Vendor it into `test/fixtures/`.** Drop the raw JSON at
`test/fixtures/statements/<name>.json` (or the matching category). Keep the
engine's exact output — do **not** hand-edit it to "look right". The whole point
is that it's an unmodified engine artifact. Server keys (`id`, `guid`,
`created_at`, `_xsid`, `@guid`, `@index`, …) stay in the file; `normalize()`
strips them at compare time.

**3. Wire the corpus row.** Add to `STATEMENT_CORPUS` in
`test/conformance/corpus.test.ts`:

```ts
{ fixture: "<name>", build: () => encodeStatement(<factory>(<args>)) }
```

Read the fixture's `input[]` array to recover the authoring args — each input
entry's `tag` tells you the value constructor:

| Fixture `tag` | Author with |
|---|---|
| `const` (plain — a **text** literal) | `c.text("...")` |
| `const:int` | `c.int(10)` |
| `const:decimal` | `c.decimal(1.5)` |
| `const:bool` | `c.bool(true)` |
| `const:null` | `c.null()` |
| `const:obj` | `c.obj({...})` |
| `const:array` | `c.array([...])` |
| `input:<name>` | `inp("<name>")` |
| a `filters:[...]` chain | `withFilters(value, [filter("json_decode"), ...])` |

Note the text case: a text literal serializes as the **bare** tag `const`, *not*
`const:text` (there is no `const:text` — check the fixture's actual tag, and see
the `TAGS` set in `src/types/xdo.ts` for the full list). Every other primitive
carries a `const:<type>` suffix.

Pick the build helper by family (mirror the nearest existing row):
- **Generated declarative statements** → `stmt("mvp:<name>", { ...authored })`
  (the local `stmt` helper wraps `getStatementFactory`), or an ergonomic factory
  like `mathAdd(...)` / `bitwiseAnd(...)` from `src/statements/generated/catalog.js`.
- **Control-flow / block specials** → the hand factory: `forLoop({...})`,
  `foreachLoop({...})`, `returnValue(...)`, `die(...)`, `setVar(...)`.

`bitwise_and` is the canonical "quick declarative" template; `for` / `foreach`
are the templates for nested-body statements.

**4. Validate — two levels, and you owe both when touching a fixture.**

*Frozen check (always, offline):* run the corpus test against the vendored file.

```bash
npm test -- corpus
```

Green = your compiled output matches the vendored JSON after normalization. This
is the deterministic, no-network gate that runs in CI and for every contributor —
it's why the fixture exists at all.

*Live check (required whenever you add or change a fixture):* actually run the
`sidestep validate` CLI so the object is proven against a **real running engine**,
not just a frozen sample.

```bash
sidestep validate <entry.ts>            # import-accepts + round-trip parity, live
sidestep validate <entry.ts> --runtime  # also invoke the deployed logic and assert
```

A frozen golden can drift from the engine, or be stale/hand-vendored — the corpus
test would still pass against it. Running the CLI is the only thing that confirms
the object still imports and round-trips on a live engine, which is the entire
reason the command exists. **Do not treat a fixture as done on the corpus test
alone.** (If you sourced the golden by
[capturing from live](#capture-a-golden-from-a-live-instance), that capture run
*was* the live check — you don't need to repeat it.)

> **The target is a disposable instance, never prod.** `sidestep validate`
> imports with `reset: true` — it **wipes and re-imports** the target workspace so
> the round-trip reads a clean state. Point it only at an instance you can safely
> destroy: a local Docker Xano or a throwaway dev workspace you operate. Never a
> production workspace with real data. The point is a *real engine on the same
> version as prod*, not the prod instance itself.

A diff from either level is the same fork: a missing normalize rule or a real
encoder bug — go to [Interpret a failing diff](#interpret-a-failing-diff).

Then guard the broader surface before you call it done:

```bash
npm run typecheck && npm run lint && npm test
```

---

## Capture a golden from a live instance

`sidestep validate` sources goldens straight from a running engine, so you're not
hand-vendoring frozen samples.

**One-time setup** — copy the template and fill it in (`.env` is gitignored;
never commit a token, never add the token as a CLI flag):

```bash
cp .env.example .env
# XANO_VALIDATE_INSTANCE=https://<your-instance>   (or http://localhost:8080 for local Docker)
# XANO_VALIDATE_TOKEN=<meta bearer token you already hold>
# XANO_VALIDATE_WORKSPACE_ID=  (optional)
```

Cloud-dev ↔ local Docker is **just a base-URL change** — same public
`/api:meta/...` routes.

**Capture:**

```bash
# from an SDK authoring entry (defineFunction / Xano registry, same input as `sidestep export`)
sidestep validate <entry.ts> --capture --out validate-out

# or from a prebuilt bundle
sidestep validate --bundle bundle.json --capture --out validate-out

# useful flags: --runtime (also invoke + assert), --instance <url>, --workspace <id>, --verbose
```

Each captured file in `validate-out/` is a **candidate, not a fixture**, and it's
a whole **function object** (the round-trip works at function granularity). Capture
never writes into `test/fixtures/` for you — that gate is deliberate. Promoting is
a reviewed manual step, and *what* you promote depends on the fixture's category:

- **Statement fixture** (`test/fixtures/statements/<name>.json`) → the golden is a
  **single statement**, so extract the matching entry from the function's `run[]`
  array (usually `run[0]` for a one-statement capture entry) and write *that*, not
  the whole function. Compare against a neighbor like
  `test/fixtures/statements/lambda.json` to confirm the shape
  (`context`/`name`/`as`/`input`/`_xsid`/`@guid`/`@index`) — no `run`, no function
  envelope. Authoring a one-statement capture entry keeps this a clean `run[0]`.
- **Function fixture** (e.g. `golden-set-var-function.json`) → promote the whole
  captured function object as-is.

Then wire a corpus row (steps 3–4 above). Keep server keys intact either way —
`normalize()` strips them at compare time; don't hand-trim.

Without `--capture`, `sidestep validate` still proves the loop live: import
accepts → round-trip parity → (with `--runtime`) execution. Reach for it when you
want to confirm a fixture reflects *today's* engine, not just a frozen file.

---

## Interpret a failing diff

A conformance failure is a fork, and naming which branch you're on is the point:

**Branch A — normalizer gap (not a bug).** The engine augmented output with a
key/shape the SDK legitimately never authors, and `normalize()` doesn't strip it
yet. Symptom: the diff is server noise, empty-default envelope members, or a
number-vs-string serialization quirk — nothing about the *authored logic*
differs. Fix: extend `src/validate/normalize.ts` deliberately. This helps the
whole corpus, so add the narrowest rule that's correct, and note why. See
[references/normalizer.md](references/normalizer.md) for the existing strip
categories before adding a new one — your case may already be covered by a rule
that isn't firing (often a wrong path or a nesting level).

**Branch B — authored output is wrong.** The compiled output carries the wrong
value, tag, envelope, or omits/adds authored content. Symptom: the diff touches
something the author actually specified. The fix lives on the **authoring side**,
never the fixture and never the normalizer — but check the cheaper cause first:

1. **Your corpus `build` row is mis-authored** (the common case). You recovered the
   args wrong — e.g. `c.int("123")` where the golden's tag is a plain-`const` text
   literal (`c.text("123")`). Fix the `build` expression in
   `test/conformance/corpus.test.ts`; no `src/` change needed. Re-read the fixture's
   `input[]` tags against the value-constructor table under
   [Add a fixture](#add-a-fixture).
2. **A genuine encoder bug** — only if, *after* the build row authors the right
   constructor, compile still emits the wrong shape. Then fix the encoder in `src/`
   (statement factory, value constructor in `src/values/value.ts`, or envelope
   logic).

Never make a test pass by editing the golden to match wrong output — that defeats
the oracle.

Quick triage: if you can explain the diff as "engine bookkeeping the author never
asked for" → Branch A. If you'd have to explain it as "the author's intent
changed" → Branch B.

`sidestep validate --verbose` (against a live instance) shows the raw round-trip
diff when the frozen fixture is ambiguous about which branch you're on.

---

## examples/sandbox

`examples/sandbox/` is the **breadth oracle** (does everything still
compile/export as one signed workspace bundle), distinct from fixtures (the
byte-exact oracle). It is *not* a fixture source. Touch it when you add or change
an authoring primitive.

- Regenerate after adding a statement/filter/field/value/kind:
  ```bash
  npm run examples:gen      # regenerates statement + filter + index examples
  npm run examples:check    # regenerates the barrel + type-checks the sandbox against src/
  ```
- The sandbox export guarantee is enforced by `test/examples.test.ts`:
  ```bash
  npm test -- examples
  ```
- Keep the sandbox showing **best-practice** usage of each primitive — it's read
  by humans and agents as the canonical example.

Note the codegen link: `npm run codegen` reads persisted goldens to pin each
statement's engine-only `output` flag and envelope profile into
`src/statements/generated/`. New goldens can therefore shift generated specs —
if `codegen` output changes, that's expected, review it.

---

## Release hygiene

Before shipping fixture-related work, run the project checklist:

```bash
npm test            # corpus + golden + examples + everything
npm run typecheck
npm run lint
```

Then confirm no source leakage — the shipped surface (`src/`, `README.md`,
`.env.example`) names no internal Xano symbol, repo, or path:

```bash
git grep -nE 'cloud-client|transform-temp|extensions/MVP' -- src README.md .env.example
```

That grep must come back empty for shipped paths (test files may reference the
source dir; shipped code may not). Version bump + `npm run manifest` belong to the
release step, not mid-fixture work.

---

## Key files

- `test/conformance/corpus.test.ts` — the `STATEMENT_CORPUS` manifest + assertions + `@TODO(byte-verify)` worklist
- `test/conformance/harness.ts` — `loadFixture(relPath)`, `normalize`, `normalizedPair`
- `test/compile.golden.test.ts` — the top-level function golden (`golden-set-var-function.json`)
- `src/validate/normalize.ts` — the shared normalizer (strip rules); [references/normalizer.md](references/normalizer.md)
- `src/validate/capture.ts` — `--capture` candidate writer
- `src/emit/validate-command.ts`, `src/emit/cli.ts` — the `sidestep validate` command
- `src/statements/generated/catalog.ts` — ergonomic factories (`mathAdd`, `bitwiseAnd`, …)
- `src/values/value.ts` — `c.*` value constructors, `inp`, `filter`, `withFilters`
