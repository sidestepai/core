#!/usr/bin/env bash
# End-to-end test for the ephemeral CLI lifecycle against a LIVE Xano instance.
#
#   deploy(create) → list → get → deploy(refresh) → export(json) → export(multidoc)
#   → hit the live backend → delete → get(gone)
#
# Auth: seeds .xano/auth.json as a `type: "token"` credential from
# XANO_VALIDATE_TOKEN/INSTANCE/WORKSPACE_ID (a meta PAT works as the bearer for
# the ephemeral meta routes). Requires those in .env or the env.
#
# There is no `--workspace` flag anywhere in here: every command acts on the
# workspace its credential pins, so `workspace_id` in the seeded record IS the
# target. Runs in a throwaway cwd so it never touches the repo's own .xano
# state, and always deletes the tenant it created — even on failure.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$REPO/dist/bin.js"
ENTRY="$REPO/examples/sandbox/_e2e-app.ts"
DISPLAY="sidestep-e2e"

# --- load creds -------------------------------------------------------------
# An explicitly-exported value WINS over .env, so a one-off run can target a
# different instance (`XANO_VALIDATE_INSTANCE=… XANO_VALIDATE_TOKEN=… bash
# scripts/e2e-ephemeral.sh`) without editing the file. Sourcing with `set -a`
# alone would silently overwrite the override with whatever .env pins.
_env_instance="${XANO_VALIDATE_INSTANCE:-}"
_env_token="${XANO_VALIDATE_TOKEN:-}"
_env_ws="${XANO_VALIDATE_WORKSPACE_ID:-}"
if [[ -f "$REPO/.env" ]]; then set -a; source "$REPO/.env"; set +a; fi
[[ -n "$_env_instance" ]] && XANO_VALIDATE_INSTANCE="$_env_instance"
[[ -n "$_env_token" ]] && XANO_VALIDATE_TOKEN="$_env_token"
[[ -n "$_env_ws" ]] && XANO_VALIDATE_WORKSPACE_ID="$_env_ws"
: "${XANO_VALIDATE_INSTANCE:?set XANO_VALIDATE_INSTANCE}"
: "${XANO_VALIDATE_TOKEN:?set XANO_VALIDATE_TOKEN}"
INSTANCE="$XANO_VALIDATE_INSTANCE"
# The workspace the ephemeral is created under — pinned in the credential below.
WS="${E2E_WORKSPACE:-${XANO_VALIDATE_WORKSPACE_ID:?set XANO_VALIDATE_WORKSPACE_ID or E2E_WORKSPACE}}"

# --- throwaway workdir with seeded auth -------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/sidestep-e2e.XXXXXX")"
mkdir -p "$WORK/.xano"
cat > "$WORK/.xano/auth.json" <<EOF
{"type":"token","instance_base_url":"$INSTANCE","workspace_id":$WS,"meta_api_token":"$XANO_VALIDATE_TOKEN"}
EOF
chmod 600 "$WORK/.xano/auth.json"
cd "$WORK"

PASS=0; FAIL=0; TENANT=""
ok(){   printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad(){  printf '  \033[31m✗ %s\033[0m\n' "$1"; FAIL=$((FAIL+1)); }
step(){ printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

cleanup(){
  if [[ -n "$TENANT" ]]; then
    curl -s -X DELETE -H "Authorization: Bearer $XANO_VALIDATE_TOKEN" \
      "$INSTANCE/api:meta/workspace/$WS/tenant/$TENANT" -o /dev/null
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# jq-free JSON field read (node is a hard dep of the CLI anyway).
jget(){ node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=process.argv[1].split(".").reduce((a,k)=>a?.[k],JSON.parse(s));process.stdout.write(v==null?"":String(v))}catch{process.exit(2)}})' "$1"; }

# ── 1. deploy (create) ──────────────────────────────────────────────────────
step "deploy → new ephemeral (workspace $WS, from the credential)"
OUT="$(node "$BIN" deploy "$ENTRY" --dest ephemeral --name "$DISPLAY" --expires-hours 1 2>deploy1.err)"
if [[ $? -eq 0 ]]; then ok "deploy exited 0"; else bad "deploy failed"; sed 's/^/    /' deploy1.err; fi
TENANT="$(printf '%s' "$OUT" | jget ephemeral.name)"
URL="$(printf '%s' "$OUT" | jget url)"
CREATED="$(printf '%s' "$OUT" | jget created)"
[[ -n "$TENANT" ]] && ok "assigned tenant name: $TENANT" || bad "no tenant name in summary"
[[ "$CREATED" == "true" ]] && ok "summary.created == true" || bad "summary.created != true (got '$CREATED')"
[[ "$URL" == https://* || "$URL" == http://* ]] && ok "base URL: $URL" || bad "no base URL"
[[ -f .xano/ephemeral.json ]] && ok "wrote local .xano/ephemeral.json" || bad "no local ephemeral state"

# ── 2. ephemeral list ───────────────────────────────────────────────────────
step "ephemeral list"
LIST="$(node "$BIN" ephemeral list 2>list.err)"
if printf '%s' "$LIST" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);process.exit(Array.isArray(a)&&a.some(r=>r.name===process.argv[1])?0:1)})' "$TENANT"; then
  ok "our tenant appears in the list"
else bad "tenant not found in list"; sed 's/^/    /' list.err; fi

# ── 3. ephemeral get ────────────────────────────────────────────────────────
step "ephemeral get $TENANT"
GET="$(node "$BIN" ephemeral get "$TENANT" 2>get.err)"
[[ "$(printf '%s' "$GET" | jget name)" == "$TENANT" ]] && ok "get returned our tenant" || { bad "get mismatch"; sed 's/^/    /' get.err; }
[[ "$(printf '%s' "$GET" | jget state)" == "ok" ]] && ok "state == ok" || bad "state != ok"

# ── 4. deploy again (refresh, same URL) ─────────────────────────────────────
step "deploy again → refresh (URL should NOT change)"
OUT2="$(node "$BIN" deploy "$ENTRY" --dest ephemeral 2>deploy2.err)"
URL2="$(printf '%s' "$OUT2" | jget url)"
CREATED2="$(printf '%s' "$OUT2" | jget created)"
# If step 1 failed, TENANT is empty and this deploy just CREATED one — record it
# or the cleanup trap has nothing to delete and the tenant leaks until it expires.
if [[ -z "$TENANT" ]]; then TENANT="$(printf '%s' "$OUT2" | jget ephemeral.name)"; fi
if [[ "$CREATED2" == "false" ]]; then ok "summary.created == false (refresh, not recreate)"
else bad "expected refresh, got created='$CREATED2'"; sed 's/^/    /' deploy2.err; fi
[[ "$URL2" == "$URL" ]] && ok "base URL unchanged across refresh" || bad "URL changed: $URL -> $URL2"

# ── 5. export json ──────────────────────────────────────────────────────────
step "ephemeral export $TENANT --format json"
node "$BIN" ephemeral export "$TENANT" --format json --path e2e-export.json >/dev/null 2>export.err
if [[ -f e2e-export.json ]] && [[ "$(jget app <e2e-export.json)" == "xano" ]]; then
  ok "exported workspace bundle (app==xano)"
  printf '%s' "$(jget payload.query <e2e-export.json)" >/dev/null 2>&1
else bad "json export failed"; sed 's/^/    /' export.err; fi

# ── 6. export multidoc ──────────────────────────────────────────────────────
step "ephemeral export $TENANT --format multidoc"
MD="$(node "$BIN" ephemeral export "$TENANT" --format multidoc --path - 2>md.err)"
if printf '%s' "$MD" | grep -qiE "query|table|widgets|ping"; then ok "multidoc contains our objects"; else bad "multidoc looks empty"; sed 's/^/    /' md.err; fi

# ── 7. hit the live backend the ephemeral serves ────────────────────────────
step "live call: GET $URL/api:e2e/ping?n=21"
CODE="$(curl -s -o ping.out -w '%{http_code}' "$URL/api:e2e/ping?n=21")"
if [[ "$CODE" == "200" ]] && [[ "$(cat ping.out)" == "42" ]]; then ok "backend served ping → 42"
else bad "live ping failed (HTTP $CODE, body: $(cat ping.out 2>/dev/null | head -c 120))"; fi

# ── 8. URL path params: does the ENGINE bind each {param} segment? ─────────
step "live call: GET $URL/api:e2e/echo/hello/n/7"
CODE="$(curl -s -o echo.out -w '%{http_code}' "$URL/api:e2e/echo/hello/n/7")"
if [[ "$CODE" == "200" ]]; then
  ok "path-param route resolved (HTTP 200)"
  SLUG="$(jget slug <echo.out)"; COUNT="$(jget count <echo.out)"
  [[ "$SLUG" == "hello" ]] && ok "{slug} bound to its segment → 'hello'" || bad "{slug} bound to '$SLUG', expected 'hello'"
  [[ "$COUNT" == "7" ]] && ok "{count} bound and coerced to int → 7" || bad "{count} bound to '$COUNT', expected 7"
else
  bad "path-param route failed (HTTP $CODE, body: $(head -c 120 echo.out 2>/dev/null))"
fi

# The re-export must still carry the {param} name verbatim — a path param is a
# naming convention over `name`, so a round trip that mangles it is data loss.
# Checked against BOTH export formats, whichever produced output: keying this to
# the json export alone would report "path params lost" whenever that export
# failed for its own unrelated reasons.
NAME_SEEN=""
[[ -s e2e-export.json ]] && grep -q 'echo/{slug}/n/{count}' e2e-export.json && NAME_SEEN="json"
printf '%s' "$MD" | grep -q 'echo/{slug}/n/{count}' && NAME_SEEN="${NAME_SEEN:+$NAME_SEEN+}multidoc"
if [[ -n "$NAME_SEEN" ]]; then ok "re-export preserved the {param} name verbatim ($NAME_SEEN)"
else bad "no export carried the {param} name — round trip lost or rewrote it"; fi

# ── 9. delete ───────────────────────────────────────────────────────────────
step "ephemeral delete $TENANT --yes"
node "$BIN" ephemeral delete "$TENANT" --yes >del.out 2>del.err
if [[ $? -eq 0 ]]; then ok "delete exited 0"; else bad "delete failed"; sed 's/^/    /' del.err; fi
if [[ ! -f .xano/ephemeral.json ]] || ! grep -q "$TENANT" .xano/ephemeral.json; then ok "cleared local record for $TENANT"; else bad "local record not cleared"; fi

# ── 10. get after delete → gone message ─────────────────────────────────────
step "ephemeral get $TENANT (now gone)"
if node "$BIN" ephemeral get "$TENANT" >gone.out 2>gone.err; then
  bad "get on a deleted tenant unexpectedly succeeded"
else
  grep -qiE "expired or no longer exists" gone.err && ok "surfaced the actionable gone message" || { bad "wrong error"; sed 's/^/    /' gone.err; }
fi
TENANT=""  # already deleted; skip trap cleanup DELETE

# ── summary ─────────────────────────────────────────────────────────────────
printf '\n\033[1m── %d passed, %d failed ──\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
