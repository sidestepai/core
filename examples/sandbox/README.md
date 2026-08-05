# Sandbox — implementation examples

A **full, deployable sandbox** demonstrating every primitive and statement in
`@sidestep/core`. One file per statement / filter / field type / value
constructor / object kind, wired together into a single Xano workspace that
type-checks and `export()`s as one coherent bundle.

This exists to (1) let a human eyeball how each piece of the API looks in real
code, and (2) give agents concrete, verified usage examples to learn from.

## Coverage

| Area | Count | Location |
|---|---|---|
| Statements (`s.*`) | 214 | `statements/**` |
| Value filters (`fl.*`) | 345 | `filters/**` |
| Field types (`f.*`) | 24 | `fields/**` |
| Value constructors (`c.*`, `ref`, `inp`, `col`, `auth`, `expr`, …) | 17 | `values/**` |
| Object kinds (`table`, `query`, `trigger`, `agent`, `workflowTest`, …) | 17 | `kinds/**` |

## Conventions

- **One primitive per file.** The directory mirrors the API path — e.g.
  `s.cloud.aws.s3.upload_file` lives at
  `statements/cloud/aws/s3/upload_file.ts`. Single-segment control-flow
  statements are grouped under `statements/control-flow/`.
- **Param gates → multiple exports.** When a statement/primitive has distinct
  authoring modes, each gate is its own exported `defineFunction` with a
  `/** Gate N — … */` note (see `statements/db/add.ts`, `statements/db/query.ts`,
  `values/const/obj.ts`, `kinds/trigger.ts`).
- **Everything is exercised.** A statement that binds an `as` output captures it
  and returns it via `response: ref("…")`, so the whole path is real.
- **Shared handles** (`users`, `posts`, `api`, `doubleFn`) live in `_shared.ts`
  and are reused across examples so cross-object references resolve.

## Regenerate & validate

The statement (codegen'd), filter, and field examples are produced by scripts;
the specials, object kinds, and value primitives are hand-authored. Generators
**never overwrite** existing files, so hand-tuned examples are safe.

```bash
npm run examples:gen     # (re)generate statements + filters + the _auto barrel
npm run examples:check   # regenerate the barrel and type-check the whole sandbox
npm test -- examples     # assert the sandbox exports as a valid workspace bundle
```

`_auto.ts` is generated — it collects every `statements/`, `filters/`,
`values/`, and `fields/` example and buckets it by kind for `index.ts`. The
object-kind examples in `kinds/` are hand-wired in `index.ts`.

The example tree type-checks against **source** via `tsconfig.json` here (which
aliases `@sidestep/core` → `../../src`). It is excluded from the package's own
build and typecheck; the runtime export guarantee is enforced by
`test/examples.test.ts`.
