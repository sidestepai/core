---
title: "feat: sidestep workspace/sandbox deploy + profile me (real-workspace deploy with lock reconciliation)"
status: active
date: 2026-07-19
deepened: 2026-07-19
type: feat
depth: deep
origin: none (direct planning)
---

# feat: sidestep workspace/sandbox deploy + profile me

**Home repo:** `@sidestep/core` (`~/sidestep/core`). Repo-relative paths below are relative to that root unless prefixed `cloud-client:`.

**Target repos:** two.
- `@sidestep/core` — the CLI, deploy client, lock reconciliation (most units).
- `cloud-client` — the new real-workspace deploy meta-API endpoint and the sandbox-endpoint retrofit. Cross-repo paths are prefixed `cloud-client:` and are relative to `~/git/cloud-client`.

---

## Summary

Add a `sidestep workspace deploy` command that ships a compiled workspace to the **real** workspace the OAuth token is scoped to — the backend JSON bundle plus optional static-host assets — with `--reset` for a clean clear-then-import. Restructure the CLI into noun-verb commands: the current `push` is removed and replaced by `sidestep sandbox deploy`, and a new `sidestep profile me` returns the scoped user and, most importantly, the instance base URL. Both deploy endpoints return the server's authoritative post-import lock so the CLI can reconcile `xano.lock` against the backend's identity truth.

---

## Problem Frame

`sidestep push` today compiles a `packageExport` bundle and POSTs it as JSON to the **sandbox** meta-API endpoint (`/api:meta/sandbox/bundle`) — a transient dev loop, not a real deploy. There is no path to deploy that same bundle to a real workspace: the only real-workspace ingestion routes in `cloud-client` accept XanoScript multidoc (`workspace/{id}/multidoc`) or an encrypted archive (`workspace/{id}/import`), neither of which is the JSON bundle sidestep produces. So a new real-workspace bundle endpoint is genuinely required — the "API like the sandbox one" this work adds.

Three things compound on top of that gap:

1. **Identity authority lives on the backend.** The engine syncs by guid and, critically, canonical uniqueness is **instance-wide** — importing the same lock into a second workspace regenerates canonicals, and guid-matched updates keep the *server's* canonical, ignoring the incoming one. After a deploy, the local `xano.lock` can therefore diverge from the workspace's real identities. Nothing reconciles that today.

2. **Workspaces get large.** `packageExport` bundles are big, repetitive JSON. Uncompressed uploads risk request body-size limits and slow transfers.

3. **Agents need the instance base URL.** To wire a static frontend to its backend before uploading the static host, an agent needs the API base URL. Sidestep already binds the instance to the token's `aud`, but no command surfaces it.

This plan closes the deploy gap and folds in lock reconciliation, payload compression, and the `profile me` discovery command while the surface is open.

---

## Key Technical Decisions

| # | Decision | Rationale |
|---|---|---|
| KTD-1 | Two endpoints, CLI orchestrates. New `cloud-client: POST /api:meta/workspace/deploy` mirrors the sandbox path (`Migrate::importWorkspace` with `partial=true`, plus `workspace_clear` on reset). Static host stays on the existing `static_host/{host}/build` endpoint. | The JSON-bundle → real-workspace endpoint is the only missing primitive; static host already works. Combining a JSON body and a multipart archive into one request is awkward and buys nothing. |
| KTD-2 | Target workspace is resolved **server-side from the token's workspace scope** — no `{workspace_id}` in the path, no `--workspace` flag. Deploy never creates a workspace. | Mirrors how the sandbox endpoint resolves the tenant from the caller and how the instance is bound to the token `aud`. The OAuth token already carries a scoped workspace (`OauthScopeEnforce` `xano:workspace` claim). |
| KTD-3 | Deploy is **three distinct modes, not one flag** (see Reset Semantics): default in-place deploy (no data loss), `--prune` (remove server objects absent from the bundle, records kept), and `--reset` (full `workspace_clear` including **table records + sequences**, then import). Clear+import run in **one DB transaction**, on the **partial/guid-matched** path. `--reset` is a deliberate, git-as-truth "rebuild from scratch" mode, gated by a typed workspace-name confirmation (`--confirm-workspace` for CI) + a backend audit record — not by a production-classification subsystem or mandatory snapshot (those are Open Questions, not built here). | Splitting the modes prevents a `--reset` meant as "clean rebuild" from being confused with "remove stale objects but keep data" (`--prune`) — dropping a table cascades records, so the record-preserving intent is only reachable via `--prune`. Recovery for `--reset` is a re-deploy from git, so heavy server-side snapshot/production-gating is redundant. Atomicity + canonical preservation hold **only if** verified (Prerequisites — DDL isn't transactional on all engines; CREATE-path canonical honoring is unproven). |
| KTD-4 | Both deploy endpoints return the server's **authoritative post-import lock** (`LockFile` shape). Reconciliation is **mode-dependent**: default/`--prune` deploy = **server-wins merge, preserve local-only entries**; `--reset` = **replace the local lock wholesale** with the server lock. The `workspace` / `workspace:realtime` canonical keys are an **exception to server-wins**: a mismatch between local and server value **refuses the deploy** (the project is likely pointed at a different workspace than last time) rather than silently overwriting — **overridable via `--adopt-workspace`**, which rebinds the lock's workspace key to the server value for the legitimate first-real-deploy (sandbox-minted lock) or intentional re-point case. Post-commit reconciliation is **best-effort, non-fatal** (an unvalidatable server lock skips write-back with a warning + distinct exit code — an explicit exception to R11's fatal-broken-lock rule). | The backend is the identity authority; canonical uniqueness is instance-wide. On `--reset` the workspace *is* exactly the bundle, so keeping local-only orphan entries preserves provably-dead identities and can collide with server-regenerated canonicals and throw during write-back. The workspace-key guard is the project↔workspace binding (nothing else ties a `xano.lock` to a workspace). Best-effort reconcile keeps a committed deploy from reporting failure just because the lock couldn't be rewritten. |
| KTD-5 | Payload compression: the CLI gzips the bundle; the endpoint **gunzips by gzip magic-byte detection** (`1f 8b`), falling back to raw JSON. Applied to both the new workspace endpoint and the sandbox endpoint. | Bundles compress ~80–90%. Magic-byte detection is self-contained and does not depend on proxy/`Content-Encoding` request decompression, and raw JSON still decodes so nothing else has to change at once. |
| KTD-6 | CLI restructures to noun-verb subcommands: `workspace deploy`, `sandbox deploy`, `profile me`. `push` is **removed outright** (no alias). Existing top-level verbs (`login`, `logout`, `compile`, `export`, `lock`) are unchanged. | The user confirmed no one depends on `push` yet. Noun-verb keeps the two deploy targets clearly separated; leaving the mature auth/compile verbs alone avoids gratuitous churn. |
| KTD-7 | `profile me` reuses the existing `cloud-client: GET /api:meta/auth/me` for user identity and attaches the **instance base URL from the token binding** (already returned by `getAccessToken`). No new backend endpoint. | The Xano CLI's `profile me` proves the shape; sidestep is better positioned because it derives the instance from the token `aud` rather than config. The base URL is the headline field an agent needs. |
| KTD-8 | Static host: `--static <dir>` archives the directory **client-side** and POSTs it to the existing `static_host/{host}/build` endpoint (default host `default`, deploys to the `dev` env). The `workspace_id` that endpoint needs is taken from the deploy response's `workspace` object, or resolved via `auth/me`/workspace-list for a static-only run. | Reuses the working static-host path. Client-side archiving keeps the endpoint untouched. |
| KTD-9 | All new Node-only modules (deploy client, static-host archiver, profile command) are **lazily imported** from the command dispatcher, preserving the browser-safe `index.ts` split (no `node:*` in the authoring bundle). | Existing R10/KTD6 discipline from the OAuth migration — a workspace def imported in a frontend bundle must never pull in `node:http`/`node:zlib`/`child_process`. |
| KTD-10 | The `workspace/deploy` endpoint's authz is **fail-closed and defense-in-depth**: reject any token that is not an OAuth token carrying **exactly one** non-empty `xano:workspace` scope claim (no membership-default, no "first workspace" fallback); resolve guid→id rejecting null/`false`/disabled/soft-deleted; then run `enforce_workspace(resolved_id)` **independently** so membership authz is checked separately from the scope claim; and require `allow_push=true` with **no `force` bypass**. | Resolving the target from the token and then feeding it into `require_workspace_match` is a tautology that structurally bypasses the existing unbound-token guard. Legacy/non-OAuth tokens are treated as "all scopes" by the scope enforcer, so they must be rejected on this destructive endpoint. `allow_push` is the only server-side, per-workspace opt-in the client cannot skip — the multidoc endpoint's `force`/`explore` bypasses must not be inherited. |
| KTD-11 | The gunzip path is **bounded**: cap the compressed body size, inflate via a **streaming decoder that aborts once a decompressed-size cap is exceeded** (never inflate-then-check), enforce a max compression-ratio, and cap the parsed bundle's object/node count before import. | The endpoint gunzips an authenticated-but-possibly-low-privilege, attacker-influenced body; a few-KB gzip bomb can inflate to GBs and exhaust the instance before authz semantics matter. A valid-but-huge bundle is a second DoS vector. |
| KTD-12 | The `LockFile` is a **versioned cross-repo contract** with `@sidestep/core` as the single source of truth. A shared golden fixture is asserted by contract tests in **both** repos; the endpoint **echoes the lock version it built**; the CLI accepts `version ≤ known`, tolerates unknown entry fields, and treats unknown/newer version or unknown kind/key as **skip-reconcile-with-warning**. | The identity rules (which kinds carry guid/canonical, the `payloadKey:name` grammar, the fixed workspace keys, `version`) live in TypeScript and auto-extend when a kind is added; the PHP builder has no such propagation, so shape skew is a *when*, not an *if* — and the failure lands *after* an irreversible mutation. |

---

## High-Level Technical Design

### Command surface (after restructure)

```
sidestep compile <file>                         (unchanged)
sidestep export  <file>                          (unchanged)
sidestep lock    <rename|prune|adopt> …          (unchanged)
sidestep login | logout                          (unchanged)
sidestep workspace deploy <file>|--bundle <path> [--prune|--reset] [--static <dir>]   (new)
sidestep sandbox   deploy <file>|--bundle <path> [--reset]                            (replaces `push`)
sidestep profile   me                            (new)
```

`workspace deploy` and `sandbox deploy` share one deploy core (compile-or-load bundle → auth → gzip → POST → reconcile lock); they differ only in endpoint (`/api:meta/workspace/deploy` vs `/api:meta/sandbox/bundle`) and whether `--static` is honored.

### Deploy data flow (workspace deploy)

```mermaid
sequenceDiagram
  participant CLI as sidestep CLI
  participant Lock as xano.lock
  participant WS as workspace/deploy (cloud-client)
  participant SH as static_host/build (cloud-client)

  CLI->>Lock: seed identities, compile bundle (exportBundleJson)
  CLI->>CLI: gzip bundle
  CLI->>WS: POST gzip bundle (Bearer token, ?reset=…)
  WS->>WS: resolve workspace from token scope
  WS->>WS: (reset) workspace_clear
  WS->>WS: Migrate::importWorkspace(partial=true) in txn
  WS->>WS: build authoritative lock from imported objects
  WS-->>CLI: { base_url, workspace, lock }
  CLI->>Lock: reconcile (server lock wins per key), write back
  opt --static <dir>
    CLI->>CLI: archive <dir>
    CLI->>SH: POST archive (workspace_id from response)
    SH-->>CLI: { build, url }
  end
  CLI-->>CLI: response body → stdout; URLs/progress → stderr
```

### Lock reconciliation

The endpoint emits the authoritative identity of every authorable object after import. The CLI overlays that onto the local lock — server value wins for any key present in both, local-only keys are preserved:

```
reconcile(local, server) =
  for each key in server.objects: result[key] = server.objects[key]   // server authority
  for each key in local.objects not in server.objects: keep local[key] // no destructive prune
  → writeLockFile(path, result)   // atomic, idempotent
```

*Directional guidance, not implementation spec.*

---

## Reset Semantics

`--reset` in the original draft conflated three separable effects. The plan splits them so an operator can never silently destroy user data:

| Mode | Flag | Effect on logic/schema | Effect on objects absent from bundle | Effect on table records |
|---|---|---|---|---|
| Default deploy | (none) | in-place upsert by guid | left in place | untouched |
| Prune | `--prune` | in-place upsert by guid | **removed** | untouched |
| Full reset | `--reset` | recreated from bundle | removed (workspace cleared) | **permanently deleted** + sequences reset |

- **`--reset` is a first-class, intended workflow, not an emergency valve.** Git (the workspace authored in TypeScript + the committed `xano.lock`) is the source of truth, so "nuke the workspace and rebuild it 100% from scratch — records and all" is a deliberate mode. Recovery is a re-deploy from git, which is *why* a mandatory server-side snapshot is not required (see below): the durable copy already lives in the repo.
- "Reset schema but keep records" is **not achievable** via `workspace_clear` (dropping a table cascades its records) — the plan states this so nobody plans for an impossible mode. Record-preserving cleanup is `--prune`.
- **Safety for `--reset` is confirmation + audit, kept deliberately light** given git-as-truth: the CLI **echoes the resolved workspace name back in a typed confirmation** (interactive), or requires `--confirm-workspace=<name>` matching the resolved name for the non-interactive CI path (honoring the existing `--yes`); the backend writes an **audit record before the clear** (actor + token id, target workspace guid+id, bundle hash/size, reset flag) via the existing `mvp:log` path, regardless of transaction outcome. A `--reset` `dry-run` (reporting what will be wiped/replaced) shares the destructive endpoint's full authz chain (KTD-10). **Production-class gating and a server-side pre-clear snapshot are NOT built in this plan** — "production-classed workspace" is not a confirmed cloud-client primitive and git-as-truth makes a server snapshot redundant; both are recorded as Open Questions rather than budgeted work.
- After any record import, sequences are reconciled to `max(id)+1` rather than left at the reset value, to avoid primary-key collisions on later inserts.
- **Identity survives a from-scratch reset only if the lock does its job.** Because the recreated objects are CREATEs (nothing to guid-match after the clear), a from-scratch reset preserves public URLs *only* when the committed `xano.lock` carries stable guids/canonicals that the CREATE path honors — this is exactly what PG-3 verifies. Without a committed lock, a `--reset` rotates canonicals.

---

## Prerequisites & Verification Gates

These must be resolved **before** the corresponding units are built. They are not runtime discoveries — several are "verify-or-do-not-ship" gates because the entire safety model rests on them.

- **PG-1 (blocking, before U2/U11): master-issued OAuth JWT validation.** 100% of the destructive endpoint's safety rests on the instance-side meta-API actually verifying the master signature / `aud` / JWKS. If it trusts the bearer's `extras.oauth` without verification, `scope` and `xano:workspace` are attacker-forgeable and all of KTD-10 is security theater. Prove with adversarial tests: a wrong-key-signed token, a mismatched-`aud` token, and a tampered-claims token are each rejected (401); a validly-signed token naming a workspace the caller has no membership for is rejected. This was never confirmed even for the sandbox.
- **PG-2 (blocking, before trusting `--reset`): transaction atomicity of clear+import on the real route.** Confirm clear and import share **one transaction on one connection** on the new endpoint (not inherited from the sandbox path), and that the DB engine supports **transactional DDL** — on MySQL/MariaDB, DDL auto-commits and cannot roll back, which would make "a failed import can't leave the workspace wiped" simply false. Confirm sequence resets roll back with the transaction. Add a failure-injection test on the real route that forces import failure after the clear and asserts full restoration of schema, logic, **all records**, and every canonical/guid.
- **PG-3 (blocking, before enabling `--reset` on published workspaces): canonical/guid preservation across a clear.** The "identity preserved on the partial path" claim only covers guid-*matched updates*; after a full clear every object is a **CREATE**, and the known rule (guid-matched updates keep the *server's* canonical, discarding the incoming) is evidence *against* the create path honoring the bundle's tokens. Verify: does the bundle carry per-object `guid` + `canonical`, and does the partial-CREATE path honor them? Export → `--reset` a copy → assert each object's canonical and guid are byte-identical before/after. If not preserved, `--reset` silently rotates every public URL (published endpoints, webhooks, saved links break with no error) and must be blocked for workspaces with published/public endpoints. The endpoint should compute a pre-clear→post-import canonical diff and return it so the CLI can surface "N public URLs changed" as a hard warning.
- **PG-4 (before U9): `extras` blob contents.** Enumerate what `auth/me`'s `extras`/`extras.oauth` actually contain on a real instance; confirm no token material, secrets, or membership internals would be printed, AND confirm whether `extras.oauth.workspace` carries a numeric id/name or only a guid (drives U9's backend affordance). `profile me` projects only `id`, `name`, `email`, and the instance URL — never the raw `extras` (CLI output lands in shell history and CI logs).
- **PG-5 (before U8): static-host endpoint authorization.** The reused `static_host/{workspace_id}/build` endpoint takes a **client-supplied numeric `workspace_id`** in its path (unlike the token-resolved `workspace/deploy`). Confirm it independently enforces token↔workspace membership against that path id (the KTD-10 independence), so a token scoped to workspace X cannot overwrite workspace Y's static build by supplying Y's id. If it doesn't, that check is required before U8 ships.
- **PG-6 (before U2): `allow_push` on real workspaces.** The whole client-unskippable gate rests on `allow_push=true`. Confirm the flag **exists on real (non-sandbox) workspaces**, its default, and the enable mechanism. If it defaults `true`, a freshly created workspace is immediately wipeable by any validly-scoped token — in that case require a **distinct per-workspace deploy-enable flag** rather than treating `allow_push` as the gate.

---

## Output Structure

New/changed files in `@sidestep/core` (cloud-client additions listed in their units):

```
src/
  emit/
    cli.ts                 (modified: noun-verb dispatch, ParsedArgs additions, remove push)
    deploy-command.ts      (new: shared deploy core for workspace/sandbox deploy)
    profile-command.ts     (new: profile me)
  deploy/
    client.ts              (new: gzip + POST + response parse, Node-only)
    static-host.ts         (new: archive a dir + POST to static_host build, Node-only)
  lock/
    reconcile.ts           (new: browser-safe server-lock merge)  — or added to lock.ts
test/
  workspace/
    cli-sandbox-deploy.test.ts   (renamed from cli-push.test.ts)
    cli-workspace-deploy.test.ts (new)
  deploy/
    reconcile.test.ts            (new)
    static-host.test.ts          (new)
  profile/
    cli-profile-me.test.ts       (new)
```

---

## Implementation Units

### U1. cloud-client: gzip-decode + authoritative-lock helpers

**Goal:** Two shared backend primitives both deploy endpoints depend on — a request-body gunzip and a routine that serializes a workspace's post-import identities into the sidestep `LockFile` shape.

**Requirements:** advances R7, R8, R12.

**Dependencies:** none.

**Target repo:** `cloud-client`.

**Files:**
- `cloud-client: extensions/MVP/includes/xano/helper/mvp/Migrate.php` (or a new sibling helper) — add a `bundleToLock(workspace, payload)` routine that walks imported objects and emits `{version:1, objects:{"payloadKey:name":{guid,canonical?}}}` plus the fixed `workspace`/`workspace:realtime` canonical keys.
- `cloud-client: extensions/MVP/includes/xano/xs/statement/mvp/` — a small statement (e.g. `GunzipMaybe.php`) or inline helper that detects the gzip magic bytes (`0x1f 0x8b`) and `gzdecode`s, else returns the body verbatim.

**Approach:** The lock builder mirrors the identity rules in `src/lock/lock.ts` / `src/refs/guid.ts`: only referenceable kinds carry a guid; only `app`/`toolset` and the workspace keys carry a canonical. Read the authoritative guid/canonical from the persisted objects after `importWorkspace`, not from the incoming bundle (the incoming canonical may be ignored on guid-matched update). The returned lock is **bundle-scoped** — it enumerates the objects the import touched, not the whole workspace — so a caller's lock never absorbs unrelated pre-existing objects. Emit the **lock version** the builder targeted (KTD-12). The gunzip helper is **bounded** per KTD-11: size cap on the compressed body, streaming inflate that aborts once a decompressed cap is exceeded, compression-ratio ceiling — never inflate-then-check.

**Patterns to follow:** the payload-key vocabulary in `Migrate.php::packageExport` (singular engine names); the lock key/canonical rules in `src/lock/lock.ts:44-97`; the golden-fixture convention in `test/compile.golden.test.ts` / `test/workspace/lock-export.test.ts`.

**Test scenarios:**
- Happy path: a workspace with tables + api-groups + toolsets produces a lock whose `objects` keys are `dbo:*`, `app:*`, `toolset:*`; only `app`/`toolset` entries carry `canonical`.
- Edge: an object whose server canonical was regenerated (uniqueness collision) reports the **server's** canonical, not the incoming one.
- Bundle-scoped contract: a partial deploy where a pre-existing non-bundle workspace object exists — that object is **absent** from the returned lock.
- Cross-repo shape parity: the emitted lock asserts byte/shape-equal against the shared golden fixture that `@sidestep/core` also tests (KTD-12).
- Gunzip: a gzip-magic body round-trips to the original JSON; a raw-JSON body passes through untouched; a truncated/corrupt gzip body raises a clear error (not a silent empty import); a gzip-bomb body aborts at the decompressed-size cap without exhausting memory.

**Verification:** unit-level PHP tests (or the repo's statement test harness) assert the emitted lock shape and gunzip branch selection.

---

### U2. cloud-client: `POST /api:meta/workspace/deploy` endpoint

**Goal:** The real-workspace bundle import endpoint — the missing counterpart to `sandbox/bundle`.

**Requirements:** R1, R2, R3, R8, R12, R15, R16.

**Dependencies:** U1, U11 (the JWT-validation gate must pass before this endpoint can be trusted); PG-6 (`allow_push` behavior on real workspaces); PG-2, PG-3 (verification gates for the `--reset` path).

**Target repo:** `cloud-client`.

**Files:**
- `cloud-client: extensions/MVP/includes/xano/app/workspace/mvp/app/meta/workspace.yaml` (or a new `deploy.yaml` under `meta/`) — define `workspace/deploy|POST` (+ a `workspace/deploy/dry-run|POST` mirroring the multidoc dry-run).
- `cloud-client: extensions/MVP/includes/xano/xs/statement/mvp/` — an import statement modeled on `TenantPackageImport.php`, targeting a real workspace resolved from the token.

**Approach:** Body = the (gzip-or-raw, bounded per KTD-11) bundle; `mode ∈ {default, prune, reset}`; on `reset`, the request must **echo the target workspace guid** (guard against a token accidentally bound to prod). Authz per KTD-10 (fail-closed, defense-in-depth): require an OAuth token with exactly one non-empty `xano:workspace` claim; resolve guid→id rejecting null/`false`/disabled/soft-deleted; run `enforce_workspace(resolved_id)` **independently**; require `allow_push=true` with **no `force` bypass**; reject legacy/non-OAuth tokens (or fall back to the documented membership-only posture — see Open Questions). Write an **audit record before any clear**. Then, in one transaction: on `reset`, snapshot then `mvp:workspace_clear {reset_sequences:true}`; on `prune`, delete objects absent from the bundle; `Migrate::decodeWorkspace`; `Migrate::importWorkspace(..., partial:true)`; reconcile sequences to `max(id)+1`; build the authoritative lock (U1) and a pre→post **canonical diff**. Response: `{ base_url, workspace, lock, canonical_changes }` where `workspace` carries the **numeric id** the static-host path needs (see Open Questions / U8). Standardize the URL field name. **Serialize per workspace:** acquire a per-workspace advisory/row lock so two concurrent deploys (or a default deploy racing a `--reset`) cannot interleave into corrupt state or a torn lock — a second concurrent deploy gets a `409`, not an interleaved import.

**Patterns to follow:** `cloud-client: sandbox.yaml:150-191` (endpoint shape), `TenantPackageImport.php:48-97` (transaction + import + response), `enforce_workspace.yaml` + `RequireScope.php` + `OauthScopeEnforce.php` (authz), `multidoc/dry-run` (dry-run pattern).

**Execution note:** Start from a failing request/response contract test against a scratch workspace — the authz + token-workspace-resolution path is the riskiest seam and should be proven first. PG-2/PG-3 verifications gate the `reset` path.

**Test scenarios:**
- Happy path: a valid bundle imports; response carries `workspace` (with numeric id) and a bundle-scoped `lock`.
- `reset` clears then imports in one transaction; a forced import failure leaves the workspace **unchanged** — schema, logic, **all records**, and every canonical/guid restored (failure injection).
- `prune` removes objects absent from the bundle but leaves table records intact.
- Reset without the echoed workspace guid is rejected; reset on a production-classed workspace without override is rejected.
- Auth (KTD-10): a token with zero, empty, or multiple `xano:workspace` claims is rejected fail-closed; a legacy/non-OAuth token is rejected (or membership-only per decision); guid→id resolving to a disabled/soft-deleted workspace is rejected; `force` does not bypass `allow_push`.
- Canonical diff: a deploy that regenerates a canonical returns it in `canonical_changes`.
- Concurrency: two overlapping deploys to the same workspace → one imports, the other gets `409` (never interleaved).
- Dry-run: `workspace/deploy/dry-run` reports the create/update/remove set and enforces the **same** KTD-10 authz chain as the destructive route (no lighter gate).
- Gzip and raw bodies import identically; a gzip bomb is rejected at the cap.

**Verification:** contract tests deploy a fixture bundle to a scratch workspace and assert object counts, identity stability across a second deploy, and rollback on injected failure.

---

### U3. cloud-client: retrofit `sandbox/bundle` for gzip + lock response

**Goal:** Bring the sandbox endpoint to parity — accept gzip and return the authoritative lock — so `sandbox deploy` reconciles identically.

**Requirements:** R7, R8 (sandbox parity).

**Dependencies:** U1.

**Target repo:** `cloud-client`.

**Files:**
- `cloud-client: extensions/MVP/includes/xano/app/workspace/mvp/app/meta/sandbox.yaml:150-191`
- `cloud-client: extensions/MVP/includes/xano/xs/statement/mvp/TenantPackageImport.php`

**Approach:** Gunzip the body via the U1 helper before `json_decode`; add `lock` (from U1) to the existing `{base_url, workspace}` response. No change to sandbox tenant resolution or reset semantics.

**Patterns to follow:** the existing `TenantPackageImport.php:76-96` transaction and response.

**Test scenarios:**
- Existing raw-JSON sandbox imports are byte-for-byte unaffected except the added `lock` field.
- A gzip body imports identically to its raw equivalent.
- The returned `lock` matches the sandbox workspace's imported objects.

**Verification:** existing sandbox tests pass; new assertions cover the `lock` field and gzip branch.

---

### U4. CLI noun-verb dispatch + ParsedArgs; remove `push`

**Goal:** Parse and route `workspace deploy` / `sandbox deploy` / `profile me`; delete the `push` command.

**Requirements:** R4, R5, R6.

**Dependencies:** none.

**Files:**
- `src/emit/cli.ts` (dispatch in `run()`, `parseArgs`, `ParsedArgs`, `USAGE`)
- `src/emit/push-command.ts` (deleted)

**Approach:** Recognize a two-token command for the noun-verb set: when `argv[0]` ∈ {`workspace`, `sandbox`, `profile`}, consume `argv[1]` as the verb and shift positionals so the entry `<file>` is still `positionals[0]`. Keep single-token verbs (`compile`/`export`/`lock`/`login`/`logout`) working unchanged. Add `--static <dir>`, the mutually-exclusive `--prune` / `--reset` mode flags, and the `--confirm-workspace=<name>` / `--adopt-workspace` safety flags to `ParsedArgs`. Remove the `push` branch; an invoked `sidestep push` falls through to the unknown-command error with a one-line pointer to `sandbox deploy`. Preserve the `--profile` hard-fail guard.

**Patterns to follow:** the existing lazy-dispatch blocks in `src/emit/cli.ts:301-322`; the flag-parse loop `:99-144`.

**Test scenarios:**
- `workspace deploy <file>` and `sandbox deploy <file>` parse with the entry as `file` and route to the deploy module.
- `profile me` routes to the profile module.
- `--static <dir>` and `--static=<dir>` both populate `ParsedArgs.static`.
- `sidestep push …` errors with a message naming `sandbox deploy`.
- An unknown verb under a known noun (`workspace frobnicate`) errors with usage.
- Existing `compile`/`export`/`lock`/`login`/`logout` dispatch unchanged (regression).

**Verification:** parse-level unit tests; the full suite still routes legacy commands.

---

### U5. Deploy API client (gzip + POST + response parse)

**Goal:** A Node-only module that gzips a bundle, POSTs it to a given endpoint with the bearer token, and parses `{ base_url, workspace, lock }`.

**Requirements:** R7, R8, R12.

**Dependencies:** U4.

**Files:**
- `src/deploy/client.ts` (new)

**Approach:** Input: bundle string, endpoint path, `ResolvedAuth`, `reset`. gzip via `node:zlib`; POST with `Content-Type: application/json`, bearer auth, `?reset=true` when set, bounded by the existing 120s timeout. **Do not send `Content-Encoding: gzip`** — an intermediary that honors it would inflate the body before the app, delivering raw JSON and silently bypassing the endpoint's KTD-11 streaming-inflate guard (KTD-5 deliberately relies on magic-byte detection at the app, not transport decompression). Parse the response; tolerate older responses lacking `lock`. Reuse `getAccessToken` from `src/auth/token.ts` — do not reimplement token logic. Keep progress on stderr, response body on stdout.

**Patterns to follow:** the fetch + error-surface shape in the deleted `src/emit/push-command.ts:81-106`; the Node-only-lazy discipline in `src/emit/logout-command.ts`.

**Test scenarios:**
- Posts a gzipped body (magic bytes present) to the given endpoint URL with `Authorization: Bearer <token>`.
- `reset` appends `?reset=true`.
- Parses `{base_url, workspace, lock}`; a response without `lock` yields an undefined lock (no throw).
- A non-2xx response surfaces an actionable error including status + body.
- Timeout aborts rather than hanging.

**Verification:** fetch-stub unit tests mirroring `test/workspace/cli-push.test.ts` patterns.

---

### U6. Lock reconciliation (server-lock merge + write-back)

**Goal:** Reconcile the server's authoritative lock into the local `xano.lock`, mode-dependently, without letting a lock-write problem fail a committed deploy.

**Requirements:** R8, R9, R17.

**Dependencies:** none (usable independently; consumed by U7).

**Files:**
- `src/lock/reconcile.ts` (new, browser-safe pure merge) — or a `reconcileServerLock` export added to `src/lock/lock.ts`
- write-back via existing `writeLockFile` in `src/lock/io.ts`

**Approach:** Pure `reconcileServerLock(local, server, {reset}): LockFile`. Non-reset = overlay `server.objects` onto `local.objects` (server wins), preserving local-only keys. `reset` = **replace wholesale** with `server.objects` (the workspace is exactly the bundle, so local-only orphans are provably dead and would collide on write). In both modes the `workspace` / `workspace:realtime` keys are an **exception to server-wins**: if the local value exists and differs from the server's, **do not overwrite — raise a mismatch signal** so U7 can refuse/hard-warn (the project is likely pointed at a different workspace). Validate the merged model (reuse `validateLockModel`). **Version negotiation (KTD-12):** accept server `version ≤ known`; on unknown/newer version, or a kind/key `validateLockObjects` rejects, **skip write-back and signal a non-fatal warning** (an explicit exception to R11's fatal-broken-lock rule — the deploy already committed). On a first deploy with no local lock, **offer to create `xano.lock` from the server lock** rather than silently discarding authoritative identities. The command layer resolves the lock path (same rule as `export`) and calls `writeLockFile`.

**Patterns to follow:** `mergeObserved` / `adoptFromBundle` / `validateLockModel` in `src/lock/lock.ts:504-666`; `resolveLockPath` in `src/emit/cli.ts:348-352`; atomic write in `src/lock/io.ts:31-42`.

**Test scenarios:**
- Non-reset: a server entry overwrites a differing local guid/canonical; a local-only key is preserved; a server-only key is added.
- `reset`: local-only orphan entries are **dropped** (wholesale replace).
- Workspace-key guard: a `workspace` canonical present locally and differing from the server's raises the mismatch signal rather than overwriting; a matching (or absent-local) one reconciles normally.
- Version negotiation: a server lock with an unknown/newer `version` or unknown kind/key skips write-back with a non-fatal warning (deploy success preserved), not a throw.
- An empty/absent server lock leaves the local lock untouched.
- First deploy, no local lock: offers to create one from the server lock.
- Write is idempotent — unchanged bytes are not rewritten.

**Verification:** pure-function unit tests over crafted local/server pairs + a write-back integration test.

---

### U7. `workspace deploy` + `sandbox deploy` commands (shared core)

**Goal:** Wire the shared deploy core that both commands drive.

**Requirements:** R1, R4, R5, R7, R8, R11, R18.

**Dependencies:** U4, U5, U6, U9 (the shared target-workspace resolver, used here as a pre-flight step); PG-2, PG-3 (verification gates for the `--reset` path).

**Files:**
- `src/emit/deploy-command.ts` (new)

**Approach:** One `runDeployCommand(args, target)` where `target` selects the endpoint (`workspace` → `/api:meta/workspace/deploy`, `sandbox` → `/api:meta/sandbox/bundle`). For `workspace` target, **resolve and display the target workspace `{id, name}` to stderr BEFORE the POST** (reusing the U9 resolver — `DEFAULT_SCOPE` already carries `workspace:read`, so no auth-model change per KTD-9); for `--reset`, require an explicit confirmation that **names the resolved workspace** — interactively a typed name, or `--confirm-workspace=<name>` (must match the resolved name, honoring the existing `--yes`) for the non-interactive CI path, so `--reset` is usable unattended without hanging. Resolve `workspace_id` up front so `--static` never depends on the deploy response. Reuse `exportBundleJson(args)` for `<file>` or `--bundle` (mutually exclusive). `getAccessToken` → gzip+POST (U5) → **reconcile lock (U6) strictly before any static step** (so a later static failure never loses the reconciled lock — do not move write-back after static). On a workspace-key mismatch signal from U6, **refuse the deploy unless `--adopt-workspace`** is passed (which rebinds the lock's workspace key to the server value — the sanctioned path for a first real deploy from a sandbox-minted lock or an intentional re-point). Surface `canonical_changes` from the response as a hard "N public URLs changed" warning. Then, for `workspace` target with `--static`, run U8; **on static failure after a committed backend deploy, exit non-zero with a distinct code** and a message naming the resumable retry (both steps are independently idempotent — this is the compensation strategy, not a rollback). stdout carries the response body; stderr the resolved URLs/warnings.

**Patterns to follow:** the deleted `push-command.ts` control flow; `exportBundleJson` in `src/emit/cli.ts:385-444`.

**Execution note:** Reuse the existing `test/workspace/cli-push.test.ts` scenarios as the starting harness for `sandbox deploy` (they should pass essentially unchanged against the new command name).

**Test scenarios:**
- `sandbox deploy <file>` compiles and POSTs to `/api:meta/sandbox/bundle` (the migrated push suite).
- `workspace deploy <file>` resolves+prints the target workspace before POSTing to `/api:meta/workspace/deploy`.
- `--reset` requires a confirmation naming the resolved workspace; an unconfirmed `--reset` aborts before any POST; `--confirm-workspace=<name>` matching the resolved name proceeds unattended, a mismatched name aborts.
- Workspace-key mismatch (local `workspace` canonical ≠ server's) refuses the deploy; the same deploy with `--adopt-workspace` proceeds and rebinds the lock's workspace key.
- After a deploy whose response carries a `lock`, `xano.lock` is reconciled; reconcile happens **before** the static step.
- `--static` failure after a committed backend deploy exits with a distinct non-zero code and a resumable message; the reconciled lock is intact.
- `canonical_changes` in the response is surfaced as a warning.
- `--bundle` uploads without compiling; passing both a file and `--bundle` errors.
- `--static` on `sandbox deploy` errors (per Open Questions).
- A non-2xx deploy surfaces an actionable error.

**Verification:** command-level fetch-stub tests; lock-file assertions after a deploy.

---

### U8. Static-host archive + upload (`--static <dir>`)

**Goal:** Archive a static-host directory client-side and deploy it to the workspace's static host.

**Requirements:** R10, R11.

**Dependencies:** U7, U9 (the shared numeric-`workspace_id` resolver); PG-5 (static-host endpoint authz).

**Files:**
- `src/deploy/static-host.ts` (new, Node-only)

**Approach:** Archive `<dir>` into the format the build endpoint expects (verify: zip vs tar.gz), multipart-POST to `cloud-client: /api:meta/workspace/{workspace_id}/static_host/{host}/build` (host `default`, env `dev`) with the bearer token. `workspace_id` is the **numeric id from the shared resolver** (U9), obtained **up front** — decoupled from the deploy response so combined and static-only runs share one path and a static retry needs no prior bundle deploy. The static-host path requires the **numeric** id (not a canonical/guid); assert the resolver yields that form. Surface the returned build URL on stderr. Bound the archive with a **client-side total-size cap** before upload (the static-host archive is a second authenticated, attacker-influenced payload path alongside the bundle gunzip — KTD-11's caps are bundle-path only); confirm the build endpoint enforces its own server-side size limit or record it as a gap. Keep the archiver isolated and stubbable (mirror the isolated side-effecting shape of `src/auth/loopback.ts`).

**Patterns to follow:** the staged `upload/token` → `upload` flow (`cloud-client: upload.yaml`) as the large-archive alternative; the multipart `static_host/{host}/build` contract (`cloud-client: static_host.yaml:265-341`).

**Test scenarios:**
- A directory archives and POSTs multipart to the build endpoint with the resolved `workspace_id` and bearer token.
- The returned build URL is surfaced on stderr.
- Static-only mode resolves `workspace_id` without a bundle deploy.
- A missing/empty `<dir>` errors before any upload.
- A non-2xx build response surfaces an actionable error.

**Verification:** fetch-stub tests asserting the multipart request; an archive round-trip test over a fixture directory.

---

### U9. `profile me` command

**Goal:** Return the scoped user and the instance base URL for agent consumption, and provide the shared target-workspace resolver the deploy path pre-flights on.

**Requirements:** R13, R14, R19.

**Dependencies:** U4; PG-4 (extras contents confirmed).

**Files:**
- `src/emit/profile-command.ts` (new, Node-only lazy)
- a shared resolver (in this module or `src/deploy/`) returning `{instance, workspace_id (numeric), workspace_name}` — consumed by U7's pre-flight and U8.
- `cloud-client:` a small backend affordance (see Approach) — the token-scoped workspace's `{id, name}` is not derivable client-side today.

**Approach:** `getAccessToken(args)` → `{access_token, instance}`; GET `cloud-client: /api:meta/auth/me` with the bearer. **Project only** `id`, `name`, `email`, the token-scoped workspace `{id, name}`, and the **`instance` base URL** (headline, from the token binding) — **never emit the raw `extras` blob** (it lands in shell history and CI logs; may carry `extras.oauth`/membership internals; PG-4 confirms scope). JSON-to-stdout is the primary mode; a human summary mode is out of scope.

**Backend affordance for `workspace_id` (feasibility gap).** The token's scoped workspace is a **guid** (`extras.oauth.workspace`); `auth/me` returns `{id, name, email, extras}` with no numeric workspace id/name, and the workspace-list output exposes no guid to match against — so the numeric `workspace_id` the pre-flight display and static-host path need is **not resolvable client-side today**. Add the smallest backend affordance that closes this: have `auth/me` (or a dedicated `workspace/resolve` endpoint) return the token-scoped workspace `{id, name}`, or add `guid` to the workspace-list output so the CLI can match `extras.oauth.workspace`. Pin the exact call chain here so U7/U8 don't each invent one.

**Patterns to follow:** `~/git/cli` `profile me` output shape (adapted so the instance base URL comes from the token, and `extras` is projected not dumped); the Node-only-lazy pattern in `src/emit/logout-command.ts`.

**Test scenarios:**
- Calls `auth/me` with the cached bearer token and prints JSON to stdout.
- The emitted JSON carries the instance base URL as a top-level field and the scoped workspace `{id, name}`.
- The raw `extras` blob is **not** present in the output (only the projected fields).
- The resolver returns a numeric `workspace_id`.
- Not-signed-in (no token cache, no `XANO_REFRESH_TOKEN`) errors with the same actionable message as deploy.
- A non-2xx `auth/me` surfaces an actionable error.

**Verification:** fetch-stub unit tests asserting the endpoint, headers, and output shape.

---

### U10. Docs + test migration

**Goal:** Bring `README.md` and the test suite in line with the new command surface.

**Requirements:** R6 (docs), all (coverage).

**Dependencies:** U4–U9.

**Files:**
- `README.md` (replace the `push`/sandbox section with `workspace deploy`, `sandbox deploy`, `profile me`; document `--reset`, `--static`, lock reconciliation, compression, and the CI env-var path)
- `test/workspace/cli-push.test.ts` → `test/workspace/cli-sandbox-deploy.test.ts` (rename + retarget)
- new test files per the Output Structure

**Approach:** Rewrite `README.md:347-466` for the noun-verb commands; keep the destructive-write and CI-agent warnings, extended to real-workspace deploy. Migrate the push suite to `sandbox deploy` and add the new-command suites.

**Test scenarios:** `Test expectation: none for the README change` — docs only. Test files carry the scenarios enumerated in U2–U9.

**Verification:** `README` examples match actual command strings; `npm test` green.

---

### U11. cloud-client: OAuth JWT-validation + authz-hardening gate (prerequisite)

**Goal:** Prove — before the deploy endpoint is trusted — that the instance-side meta-API verifies master-issued OAuth JWTs and enforces the KTD-10 fail-closed authz, so the destructive endpoint's safety is not forgeable. This is PG-1 realized as adversarial tests plus the authz assertions the new endpoint depends on.

**Requirements:** R15, R16.

**Dependencies:** none — **gates U2**.

**Target repo:** `cloud-client`.

**Files:**
- `cloud-client: extensions/MVP/includes/xano/xs/statement/mvp/OauthScopeEnforce.php` (and a **deploy-specific auth guard/wrapper**) — hardening + tests.

**Approach:** **Scope the new fail-closed behavior to the deploy endpoints, not the shared statement.** `OauthScopeEnforce` is referenced by many OAuth-scoped endpoints (`AuthChallenge.php`, `ScopeSet.php`, `extension/MVP.php`, …); tightening "exactly-one-workspace-claim" or legacy-token rejection *inside* it would change authz for every consumer. Prefer a deploy-endpoint-specific guard that composes the shared enforcer with the stricter assertions; if the shared statement must change, add regression coverage for the other consumers and flag it in Risks. First, an adversarial verification pass (PG-1): a token signed by a wrong/non-master key, a mismatched-`aud` token, and a tampered-claims token are each rejected (401); a validly-signed token naming a workspace the caller has no membership for is rejected. If verification is absent, this is a **do-not-ship gate**, not a runtime discovery. Then codify KTD-10: exactly-one-`xano:workspace` binding (reject zero/empty/multiple), guid→id rejecting null/disabled/soft-deleted, independent `enforce_workspace`, `allow_push` with no `force` bypass, and an explicit decision on legacy/non-OAuth tokens (reject vs documented membership-only).

**Patterns to follow:** `OauthScopeEnforce.php:63-114`; `enforce_workspace.yaml`; `RequireScope.php`.

**Execution note:** Characterization-first — write the adversarial rejection tests against the current behavior before changing anything, so the gate's pass/fail state is explicit.

**Test scenarios:**
- Wrong-key / mismatched-`aud` / tampered-claims tokens are each rejected.
- A validly-signed token for a non-member workspace is rejected.
- Zero / empty / multiple `xano:workspace` claims → fail-closed reject.
- A legacy/non-OAuth token hits the decided posture (reject, or membership-only + `allow_push`).
- `force` does not bypass `allow_push`.

**Verification:** the adversarial suite passes (or the gate is documented as failing and deploy build is blocked); authz assertions hold against a scratch workspace.

---

## Scope Boundaries

- **In scope:** the new `workspace/deploy` endpoint (+ its `dry-run` sharing the same authz), sandbox-endpoint gzip+lock retrofit, the three CLI commands, the three deploy modes (default / `--prune` / `--reset`), lock reconciliation, payload compression, static-host client upload, `profile me`, and the small backend affordance that resolves the token-scoped workspace `{id, name}`.
- **Out of scope:**
  - Creating or selecting workspaces from the CLI — the token's scope names the target.
  - A XanoScript-multidoc deploy path — sidestep deploys the JSON bundle.
  - Static-host **prod** promotion (dev→prod) — the build endpoint deploys to `dev`.
  - Changes to the OAuth/token model beyond consuming its workspace scope.
  - A human-formatted `profile me` summary/table mode.

### Deferred to Follow-Up Work

- Capture the now-verified live engine behaviors (rename-syncs-as-update, adopt-avoids-duplicate-sync, workspace-canonical provisioning on import) back into a `docs/solutions/` learning — the `xano.lock` plan tracked these only as `@TODO(verify)`, and real-workspace deploy is what finally exercises them.
- Static-host `dev→prod` promotion command.

---

## Risks & Dependencies

| Risk | Impact | Mitigation |
|---|---|---|
| Instance-side meta-API may not validate master-issued OAuth JWTs (`aud`/JWKS/workspace scope). If false, `scope`/`xano:workspace` are attacker-forgeable and all authz is theater. | An attacker mints a token naming any workspace and triggers a wipe. | **PG-1 / U11 — do-not-ship gate.** Adversarial rejection tests must pass before U2 is built. |
| Token-resolution tautology: deriving the target from the token and feeding it to `require_workspace_match` bypasses the fail-closed unbound-token guard. | Unbound/legacy tokens reach a destructive endpoint. | KTD-10 / U11 required assertions: exactly-one binding, independent `enforce_workspace`, reject legacy tokens, `allow_push` no-`force`. |
| `--reset` silently rotates every public URL if the partial-CREATE path doesn't honor the bundle's canonical/guid across a clear. | Published endpoints, webhooks, saved links break with no error. | **PG-3** verification; endpoint returns a canonical diff; CLI hard-warns "N public URLs changed"; block `--reset` on workspaces with published endpoints if not preserved. |
| `--reset` permanently deletes table **records** (not just schema/logic). | User/PII data loss; DR + compliance exposure. | Three-mode split (KTD-3): `--prune` keeps records; `--reset` requires typed workspace-name confirmation, production gate, server-side pre-clear snapshot + audit record. |
| Atomicity ("failed import can't leave the workspace wiped") may be **false**: `workspace_clear` runs DDL, which auto-commits on MySQL/MariaDB and can't roll back; sequence resets may not roll back on Postgres. | A mid-import failure leaves a permanently wiped production workspace. | **PG-2** — confirm single-transaction/single-connection + transactional DDL on the real route; failure-injection restore test; pre-clear snapshot as defense in depth. |
| Cross-repo `LockFile` shape skew: the PHP builder re-derives rules that auto-extend in TypeScript; a rejected key/version throws in the CLI **after** the deploy committed. | Deploy succeeds but reconcile fails; command exits non-zero on a committed change. | KTD-12: versioned contract, shared golden fixture tested in both repos, version echo; **post-commit reconcile is best-effort/non-fatal** with a distinct exit code. |
| Combined `--static` deploy is **not atomic** across the two endpoints: backend commits, static upload fails. | Split-brain — new backend, stale/absent frontend. | Both steps independently idempotent; resolve `workspace_id` up front; reconcile lock before static; static failure → distinct exit code + resumable retry message (U7). |
| Project↔workspace mis-binding: a token scoped to workspace X deploys a project locked for workspace Y. | Wrong workspace silently overwritten. | Pre-flight target display (U7); `workspace`-key mismatch guard refuses/hard-warns (KTD-4). |
| Decompression bomb on the gunzip path (authenticated but low-privilege). | Instance memory/CPU exhaustion before authz matters. | KTD-11: compressed-size cap, streaming inflate with abort, ratio ceiling, parsed object-count cap. |
| `reset_sequences:true` restarts ids at 1. | PK collisions on later inserts; external consumers of record ids resolve wrong-but-valid rows. | Reconcile sequences to `max(id)+1` post-import; confirm whether the bundle carries record data (Open Questions). |
| Full-workspace clear+import holds exclusive-class locks for the whole transaction. | Concurrent traffic blocked (effective downtime); statement-timeout aborts mid-run. | State expected lock scope/duration; whether a maintenance window is needed; timeout handling (Documentation/Operational note). |
| Two deploys race the same workspace (agents/CI are the named consumers) — no server-side mutex today. | Interleaved imports → corrupt state / torn `xano.lock`. | Per-workspace advisory/row lock serializes deploys; second concurrent deploy gets `409` (U2). |
| Hardening the shared `OauthScopeEnforce` statement changes authz for every OAuth endpoint, not just deploy. | Platform-wide authz regression. | Deploy-specific guard composes the shared enforcer (U11); regression coverage if the shared statement must change. |
| Static-host archive upload is a second attacker-influenced payload path without KTD-11's caps; its endpoint takes a client-supplied `workspace_id`. | DoS / cross-workspace static overwrite. | Client-side archive size cap (U8); PG-5 verifies the endpoint's own membership check + size limit. |
| Token-scoped `workspace_id` not resolvable client-side (guid-only in `auth/me`). | Static-only deploy and `profile me` workspace projection have no data source. | Backend affordance returns the scoped workspace `{id, name}` (U9 / PG-4). |
| `profile me` could leak the raw `auth/me` `extras` blob to stdout/logs. | Token material / membership internals exposure. | PG-4 + KTD/U9: project only `id`/`name`/`email`/instance URL; never the raw blob. |
| Request body-size limits (`client_max_body_size`, `post_max_size`) on large bundles. | Deploy fails for big workspaces. | Compression (KTD-5); verify limits + staged `upload/token` flow as a fallback for very large payloads. |
| Archive format mismatch for `static_host/build`. | Build endpoint rejects the upload. | Verify expected format (zip vs tar.gz) against `static_host_build`; execution-time confirmation in U8. |

---

## Open Questions

- **Legacy/non-OAuth token posture on the destructive endpoint.** `OauthScopeEnforce` treats a token with no `extras.oauth` as "all scopes." Decide: hard-reject non-OAuth tokens on `workspace/deploy` (recommended), or document a membership-only + `allow_push` fallback. Blocks U11's assertion set.
- **`allow_push` vs a separate `allow_reset` preference, and the `explore`-role bypass** (see PG-6). `allow_push` is the client-unskippable gate — require it (no `force` bypass). Open: gate `--reset` behind a *distinct* `allow_reset` so enabling push doesn't implicitly authorize a full wipe; and whether the existing `|or(role eq "explore")` bypass should apply to a full-wipe deploy (likely not).
- **Production-class gating + pre-clear snapshot — build or drop.** The deepening pass proposed both; they are **descoped from this plan** (no confirmed "production-classed workspace" primitive in cloud-client, and git-as-truth makes a server snapshot redundant for `--reset` recovery). Open: do the primitives exist, and does anyone want production-gating despite git-as-truth? Build in a follow-up if so.
- **Bundle record data + reset intent.** `--reset` is an intended from-scratch rebuild regardless (git is source of truth), so the empty-end-state is deliberate. Still confirm whether the bundle *can* carry seed records — it drives whether `max(id)+1` sequence reconciliation is a live concern or a documented no-op.
- **Extend `dry-run` preview to default/`--prune` modes?** The dry-run is tracked for `--reset`; the everyday non-destructive modes mutate a real workspace with only a printed target name. Deciding whether preview-before-mutate applies to all modes is a UX call (product-lens).
- **Response identity field: name AND form.** Standardize the URL field (sandbox returns `base_url`; older CLI referenced `url`). Critically, the `workspace` object must carry the **numeric id** the `static_host/{workspace_id}/build` path needs — not a canonical/guid — since the static endpoint isn't token-resolved. Pin both (ties to U9's backend affordance / PG-4).
- **`--static` on `sandbox deploy`.** Hard error (lean) vs ignore-with-warning — sandboxes have no static host in this flow. Lean: hard error, to avoid a silent no-op.
- **Server lock scope on `--reset`.** Reconciliation replaces wholesale on reset; confirm the returned lock is the complete post-clear authoritative set (after a clear, bundle-scoped == complete, so this holds — verify in U2's contract test).

---

## Alternatives Considered

- **Adapt the client to an existing real-workspace route (`workspace/{id}/multidoc` or `/import`) instead of a new endpoint.** Rejected: those accept XanoScript or an encrypted archive, not sidestep's JSON `packageExport` bundle, so the CLI would have to emit a different artifact than `export`/sandbox deploy produce — losing the single-bundle invariant. The tradeoff is that the new endpoint must re-prove JWT validation/authz from scratch (PG-1, U11); worth naming because the multidoc route already carries real-workspace authz.
- **Decouple lock reconciliation from deploy** (return the lock as a side artifact; user runs `lock adopt` deliberately). Rejected as the default: it removes the post-commit reconcile-failure class that KTD-4/KTD-12 spend complexity absorbing, but at the cost of the "reconcile after every deploy" ergonomics the user asked for. The best-effort/non-fatal reconcile (KTD-4) keeps the ergonomics while containing the failure mode; `lock adopt` remains available as the manual escape hatch.

---

## Requirements

**Deploy to a real workspace**
- R1. `sidestep workspace deploy <file>|--bundle <path>` imports the compiled bundle into the real workspace the token is scoped to.
- R2. The target workspace is resolved server-side from the token; the command never creates or selects a workspace.
- R3. Deploy offers three modes — default in-place, `--prune` (remove absent objects, keep records), `--reset` (full clear incl. records) — clear+import in one transaction on the partial path; `--reset`'s data destruction is gated (R18).

**Command surface**
- R4. The CLI exposes noun-verb commands `workspace deploy`, `sandbox deploy`, `profile me`.
- R5. `sandbox deploy` replaces `push` with equivalent behavior against the sandbox endpoint.
- R6. `push` is removed; existing `compile`/`export`/`lock`/`login`/`logout` are unchanged; docs reflect the new surface.

**Transport & identity**
- R7. The CLI gzips the bundle; both endpoints accept gzip-or-raw bodies.
- R8. Both deploy endpoints return the authoritative post-import lock; the CLI reconciles it into `xano.lock` with server authority and no destructive prune.
- R9. Reconciliation preserves local-only lock entries and validates the merged model before writing.
- R12. Deploy reuses the existing OAuth token surface (`getAccessToken`) and instance binding; no token-model changes.

**Static host**
- R10. `sidestep workspace deploy --static <dir>` archives the directory and deploys it to the workspace's static host (`default`, `dev`).
- R11. Static-host deploy runs after the bundle import (combined) or standalone (static-only), resolving `workspace_id` as needed.

**Profile discovery**
- R13. `sidestep profile me` returns the scoped user (from `auth/me`) and the instance base URL (from the token binding) as JSON on stdout.
- R14. The instance base URL is a top-level field an agent can read to configure a frontend before a static-host upload.

**Safety & correctness**
- R15. The `workspace/deploy` endpoint is fail-closed and defense-in-depth (KTD-10): exactly-one workspace binding, independent membership check, `allow_push` with no `force` bypass, legacy-token posture decided.
- R16. Master-issued OAuth JWT validation is verified adversarially before the endpoint is trusted (PG-1); if absent, deploy build is blocked.
- R17. Lock reconciliation is mode-dependent (merge on default/prune, replace on reset), guards the workspace-canonical keys against silent overwrite, and is best-effort/non-fatal post-commit with cross-repo version negotiation.
- R18. `--reset` is a deliberate git-as-truth rebuild, made safe by construction: three explicit modes, typed workspace-naming confirmation (`--confirm-workspace` for CI), a backend audit record, pre-flight target display, and a non-atomic-static compensation path. Recovery is a re-deploy from git; production-class gating and server snapshots are Open Questions, not built here.
- R19. `profile me` never emits the raw `auth/me` `extras` blob — only projected identity + instance URL.

---

## Sources & Research

- CLI/auth surface to reuse: `src/emit/cli.ts` (dispatch, `exportBundleJson`), `src/emit/push-command.ts` (deploy control flow — being replaced), `src/auth/token.ts` (`getAccessToken` → `{access_token, instance}`), `src/lock/lock.ts` + `src/lock/io.ts` (lock model, `validateLockModel`, `writeLockFile`), `test/workspace/cli-push.test.ts` (deploy test patterns).
- Backend endpoints: `cloud-client: sandbox.yaml:150-191` + `TenantPackageImport.php:48-97` (sandbox import, response `{base_url, workspace}`, transactional reset), `cloud-client: Migrate.php` (`importWorkspace:2649`, `decodeWorkspace:2499`, `packageExport:1903`), `cloud-client: WorkspaceClear.php` (`workspace_clear`), `cloud-client: static_host.yaml:265-341` (static host build), `cloud-client: upload.yaml:19-224` (staged upload token flow), `cloud-client: workspace.yaml:4-98` (workspace list), `cloud-client: auth.yaml:1-18` + `OauthScopeEnforce.php` + `RequireScope.php` + `enforce_workspace.yaml` (authz).
- `profile me` shape: `~/git/cli` `src/commands/profile/me/index.ts` (calls `auth/me`, prints user + `extras.instance`; instance base URL is config-`instance_origin` there — sidestep derives it from the token instead).
- Prior plans: `docs/plans/2026-07-18-001-feat-push-oauth-auth-plan.md` (token model, instance-from-`aud`, CI env path, Node-only-lazy discipline, unverified instance-side JWT validation), `docs/plans/2026-07-16-001-feat-xano-lock-identity-lockfile-plan.md` (guid/canonical sync semantics, partial-vs-full import, instance-wide canonical uniqueness, `lock adopt`; "live push/deploy to an instance" deferred here), `docs/plans/2026-06-24-002-feat-sidestep-full-workspace-sdk-plan.md` (bundle `packageExport` shape).
