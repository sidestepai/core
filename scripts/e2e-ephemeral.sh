#!/usr/bin/env bash
# End-to-end test for the ephemeral CLI lifecycle against a LIVE Xano instance.
#
#   deploy(create) → list → get → deploy(refresh) → export(json) → export(multidoc)
#   → hit the live backend → delete → get(gone)
#
# Auth: seeds .xano/auth.json from XANO_VALIDATE_TOKEN/INSTANCE (a meta PAT works
# as the bearer for the ephemeral meta routes). Requires those in .env or the env.
# Runs in a throwaway cwd so it never touches the repo's own .xano state, and
# always deletes the tenant it created — even on failure.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$REPO/dist/bin.js"
ENTRY="$REPO/examples/sandbox/_e2e-app.ts"
WS="${E2E_WORKSPACE:-9}"          # parent workspace to create the ephemeral under
DISPLAY="sidestep-e2e"

# --- load creds -------------------------------------------------------------
if [[ -f "$REPO/.env" ]]; then set -a; source "$REPO/.env"; set +a; fi
: "${XANO_VALIDATE_INSTANCE:?set XANO_VALIDATE_INSTANCE}"
: "${XANO_VALIDATE_TOKEN:?set XANO_VALIDATE_TOKEN}"
INSTANCE="$XANO_VALIDATE_INSTANCE"

# --- throwaway workdir with seeded auth -------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/sidestep-e2e.XXXXXX")"
mkdir -p "$WORK/.xano"
cat > "$WORK/.xano/auth.json" <<EOF
{"access_token":"$XANO_VALIDATE_TOKEN","instance":"$INSTANCE","expires_at":9999999999999,"refresh_token":"seed","client_id":"seed","auth_host":"$INSTANCE","scope":""}
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
step "deploy → new ephemeral (--workspace $WS)"
OUT="$(node "$BIN" deploy "$ENTRY" --dest ephemeral --workspace "$WS" --name "$DISPLAY" --expires-hours 1 2>deploy1.err)"
if [[ $? -eq 0 ]]; then ok "deploy exited 0"; else bad "deploy failed"; sed 's/^/    /' deploy1.err; fi
TENANT="$(printf '%s' "$OUT" | jget ephemeral.name)"
URL="$(printf '%s' "$OUT" | jget url)"
CREATED="$(printf '%s' "$OUT" | jget created)"
[[ -n "$TENANT" ]] && ok "assigned tenant name: $TENANT" || bad "no tenant name in summary"
[[ "$CREATED" == "true" ]] && ok "summary.created == true" || bad "summary.created != true (got '$CREATED')"
[[ "$URL" == https://* || "$URL" == http://* ]] && ok "base URL: $URL" || bad "no base URL"
[[ -f .xano/ephemeral.json ]] && ok "wrote local .xano/ephemeral.json" || bad "no local ephemeral state"

# ── 2. ephemeral list ───────────────────────────────────────────────────────
step "ephemeral list --workspace $WS"
LIST="$(node "$BIN" ephemeral list --workspace "$WS" 2>list.err)"
if printf '%s' "$LIST" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);process.exit(Array.isArray(a)&&a.some(r=>r.name===process.argv[1])?0:1)})' "$TENANT"; then
  ok "our tenant appears in the list"
else bad "tenant not found in list"; sed 's/^/    /' list.err; fi

# ── 3. ephemeral list WITHOUT --workspace (the fix: resolves ws from token) ──
step "ephemeral list (no --workspace → resolve from token)"
node "$BIN" ephemeral list >list2.out 2>list2.err
if [[ $? -eq 0 ]]; then ok "resolved workspace from token (no hard-coded 1 → no 'Invalid workspace')"
else
  if grep -q "Invalid workspace" list2.err; then bad "REGRESSED: still hard-codes workspace 1"
  else ok "no 'Invalid workspace' (token has no single scoped ws on this PAT — expected)"; fi
  sed 's/^/    /' list2.err
fi

# ── 4. ephemeral get ────────────────────────────────────────────────────────
step "ephemeral get $TENANT --workspace $WS"
GET="$(node "$BIN" ephemeral get "$TENANT" --workspace "$WS" 2>get.err)"
[[ "$(printf '%s' "$GET" | jget name)" == "$TENANT" ]] && ok "get returned our tenant" || { bad "get mismatch"; sed 's/^/    /' get.err; }
[[ "$(printf '%s' "$GET" | jget state)" == "ok" ]] && ok "state == ok" || bad "state != ok"

# ── 5. deploy again (refresh, same URL) ─────────────────────────────────────
step "deploy again → refresh (URL should NOT change)"
OUT2="$(node "$BIN" deploy "$ENTRY" --dest ephemeral --workspace "$WS" 2>deploy2.err)"
URL2="$(printf '%s' "$OUT2" | jget url)"
CREATED2="$(printf '%s' "$OUT2" | jget created)"
[[ "$CREATED2" == "false" ]] && ok "summary.created == false (refresh, not recreate)" || bad "expected refresh, got created=$CREATED2"
[[ "$URL2" == "$URL" ]] && ok "base URL unchanged across refresh" || bad "URL changed: $URL -> $URL2"

# ── 6. export json ──────────────────────────────────────────────────────────
step "ephemeral export $TENANT --format json"
node "$BIN" ephemeral export "$TENANT" --workspace "$WS" --format json --path e2e-export.json >/dev/null 2>export.err
if [[ -f e2e-export.json ]] && [[ "$(jget app <e2e-export.json)" == "xano" ]]; then
  ok "exported workspace bundle (app==xano)"
  printf '%s' "$(jget payload.query <e2e-export.json)" >/dev/null 2>&1
else bad "json export failed"; sed 's/^/    /' export.err; fi

# ── 7. export multidoc ──────────────────────────────────────────────────────
step "ephemeral export $TENANT --format multidoc"
MD="$(node "$BIN" ephemeral export "$TENANT" --workspace "$WS" --format multidoc --path - 2>md.err)"
if printf '%s' "$MD" | grep -qiE "query|table|widgets|ping"; then ok "multidoc contains our objects"; else bad "multidoc looks empty"; sed 's/^/    /' md.err; fi

# ── 8. hit the live backend the ephemeral serves ────────────────────────────
step "live call: GET $URL/api:e2e/ping?n=21"
CODE="$(curl -s -o ping.out -w '%{http_code}' "$URL/api:e2e/ping?n=21")"
if [[ "$CODE" == "200" ]] && [[ "$(cat ping.out)" == "42" ]]; then ok "backend served ping → 42"
else bad "live ping failed (HTTP $CODE, body: $(cat ping.out 2>/dev/null | head -c 120))"; fi

# ── 8b. URL path params: does the ENGINE bind each {param} segment? ─────────
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
if grep -q 'echo/{slug}/n/{count}' e2e-export.json 2>/dev/null; then
  ok "re-export preserved the {param} name verbatim"
else bad "re-export lost or rewrote the {param} name"; fi

# ── 9. delete ───────────────────────────────────────────────────────────────
step "ephemeral delete $TENANT --yes"
node "$BIN" ephemeral delete "$TENANT" --workspace "$WS" --yes >del.out 2>del.err
if [[ $? -eq 0 ]]; then ok "delete exited 0"; else bad "delete failed"; sed 's/^/    /' del.err; fi
if [[ ! -f .xano/ephemeral.json ]] || ! grep -q "$TENANT" .xano/ephemeral.json; then ok "cleared local record for $TENANT"; else bad "local record not cleared"; fi

# ── 10. get after delete → gone message ─────────────────────────────────────
step "ephemeral get $TENANT (now gone)"
if node "$BIN" ephemeral get "$TENANT" --workspace "$WS" >gone.out 2>gone.err; then
  bad "get on a deleted tenant unexpectedly succeeded"
else
  grep -qiE "expired or no longer exists" gone.err && ok "surfaced the actionable gone message" || { bad "wrong error"; sed 's/^/    /' gone.err; }
fi
TENANT=""  # already deleted; skip trap cleanup DELETE

# ── summary ─────────────────────────────────────────────────────────────────
printf '\n\033[1m── %d passed, %d failed ──\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
