# The normalizer — strip categories & the strip-rule-vs-bug call

`src/validate/normalize.ts` recursively walks parsed JSON and removes anything the
**engine** generates that the **SDK** legitimately never authors, so a conformance
diff reflects only authored logic. Read this before extending it — a "missing"
rule is often an existing rule that isn't firing (wrong key, wrong nesting level,
value not at its exact default).

## What it strips today

**1. Whole keys deleted from both sides (`STRIP_KEYS`)**
- Server/persistence columns: `id`, `created_at`, `updated_at`, `deleted_at`, `guid`, `_draft`
- Auto xsids / runtime keys: `_xsid`, `@guid`, `@index`, `stack_id`, `index`
- Deploy-target / market blobs (out of scope): `workspace`, `branch`, `market_item`
- Engine-stored source text: `xanoscript`
- Storage-mode flag the older table goldens predate: `use_xdo`

**2. Empty-default envelope members (`isDefaultEnvelopeMember`)** — dropped only
when the value equals its listed empty default; a *non-default* value is kept and
compared. The reason: the SDK emits the **full** persisted envelope (every member
present with empty defaults), while older parser-generation fixtures **omit** the
empties. Dropping at-default reconciles the two generations without hiding real
values. Covered members and their default: `mocks:{}`, `runtime:null`,
`settings_registry:null|[]`, `addon:[]`, `disabled:false`, `as:""`,
`description:""`, `sql_name:""`, `ignore:false`, `expand:false`,
`ignore_empty:false`, `children:[]`, `example:{}`, `shared_workspace.is_shared:false`.

**3. `output` canonicalization (`isEmptyOutput`)** — a statement `output` of
`{filters:[]}` (lean) and `{items:[],filters:[],customize:false}` (full) are the
same "no output customization" state; both are dropped. A populated `items` or
`customize:true` is kept and recursed. (The `output:[]` **array** on
query/function envelopes is unrelated and passes through normally.)

**4. `customize` empty forms** — `""` and `{}` both mean "no customization" and
appear interchangeably within the same table; canonicalized to `""`.

**5. Number-vs-string serialization coercion** — `const:int`/`const:decimal`
values serialize as `10` in some goldens and `"10"` in others; the SDK emits the
documented string form. `value` numbers and `arg[]` number elements are coerced
to strings so the comparison ignores this generation artifact.

**6. Table (`dbo`) top-level `as`** — old export goldens store `as:<name>` on a
table; a live table never does. Dropped on both sides (a `dbo` is detected by
having `schema` but no `context`).

## Deciding: extend the normalizer, or fix the encoder?

The diff is telling you one of two stories. Name it before you touch anything.

**Extend `normalize.ts` (Branch A) when** the divergence is *engine bookkeeping the
author never asked for*:
- a server/runtime key not yet in `STRIP_KEYS`
- an envelope member present-with-empty-default on one side, absent on the other
- a number-vs-string serialization of the same logical value

Add the **narrowest** rule that's correct — prefer an at-default guard over a
blanket key strip, so a meaningful non-default value still gets compared. Every
rule you add also loosens the whole corpus, so a too-broad rule can mask a future
real bug. Document *why* the divergence is an artifact, mirroring the existing
doc-comments.

**Fix the authored side (Branch B) when** the divergence is *authored intent*:
- wrong `tag` (e.g. `const:int` where the golden is a plain-`const` text literal)
- wrong or missing `value`, filter chain, or input entry
- an envelope/nesting shape that changes what the object *does*

Check the cheaper cause first: the corpus `build` row is usually the culprit —
you recovered the args with the wrong `c.*` constructor. Fix the `build`
expression in `test/conformance/corpus.test.ts`. Only if compile *still* emits the
wrong shape after the build row is correct is it a genuine encoder bug in `src/`
(statement factory, value constructor, envelope logic). **Never** edit the fixture
to match wrong output, and **never** add a normalizer rule that strips away the
evidence of a real bug — either one turns the oracle off.

Litmus test: *"Could I explain this diff to a Xano engineer as something their
engine adds automatically?"* Yes → Branch A. *"I'd have to say the author meant
something different"* → Branch B.

When a frozen fixture is ambiguous, run `sidestep validate --verbose` against a
live instance — the live round-trip diff shows exactly what today's engine adds.
