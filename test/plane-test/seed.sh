#!/usr/bin/env bash
# TC-86 — idempotent seeder for the local Plane TEST target.
# Up:   docker compose -p plane-test up -d   (in this dir)
# Seed: ./seed.sh
# Down (full wipe): docker compose -p plane-test down -v && rm -f .plane-test-env .plane-cache
#   (re-running seed after a wipe is safe: a stale cached token is detected
#   and replaced — the rm above is hygiene, not a requirement)
#
# Writes test/plane-test/.plane-test-env (gitignored) in strict
# `export KEY=value` lines for the plane shim:
#   PLANE_API_BASE, PLANE_SEAT=test, HOMETUTOR_TICKETS_TOKEN_TEST,
#   PLANE_WORKSPACE, PLANE_PROJECT_ID, PLANE_IDENT, PLANE_CACHE (test-local).
# The seat name MUST match the seeded user's email local-part (`test`), which
# is how the CLI maps a seat to a workspace member.
# Prints compact JSON: {url, workspaceSlug, projectId, identifier}.
# NEVER prints the token.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
API_PORT="${PLANE_TEST_API_PORT:-3211}"
URL="http://127.0.0.1:${API_PORT}"
APIBASE="$URL/api/v1"
ENVF="$DIR/.plane-test-env"
WS_SLUG="plane-cli-test"
PROJ_NAME="Plane CLI Test"
PROJ_IDENT="TEST"
API="docker exec -i plane-test-api python manage.py shell"
GATE_TRIES=60
GATE_SLEEP=2

# 1. API healthy: an unauthenticated v1 call answers 401/403 once Django +
# DB are up (first boot runs gunicorn immediately; migrator already ran).
# NOTE: workspace list/create lives on the /api/ (app) router, not /api/v1/ —
# the seed creates the workspace via Django shell and the project via the v1
# REST API, so project defaults (states) come from real code paths.
echo "waiting for $APIBASE/workspaces/$WS_SLUG/members/ ..." >&2
for ((i = 1; i <= GATE_TRIES; i++)); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "$APIBASE/workspaces/$WS_SLUG/members/" 2>/dev/null || true)"
  if [ "$CODE" = "401" ] || [ "$CODE" = "403" ]; then break; fi
  if [ "$i" = "$GATE_TRIES" ]; then
    echo "plane api did not become ready (last http $CODE)" >&2
    docker logs --tail 30 plane-test-api >&2
    exit 1
  fi
  sleep "$GATE_SLEEP"
done

# NOTE (M1): -H passes the token as curl argv, visible in ps during the call.
# Accepted here: single-user host, throwaway loopback-only token. Do NOT copy
# this pattern for real secrets — use a header file instead.
api() { # api <method> <path> [json] — NEVER prints the token
  if [ $# -ge 3 ]; then
    curl -s -X "$1" "$APIBASE$2" -H "X-Api-Key: $SECRET" -H 'Content-Type: application/json' -d "$3"
  else
    curl -s -X "$1" "$APIBASE$2" -H "X-Api-Key: $SECRET" -H 'Content-Type: application/json'
  fi
}

api_code() { # api_code <method> <path> — prints only the HTTP status
  curl -s -o /dev/null -w '%{http_code}' -X "$1" "$APIBASE$2" -H "X-Api-Key: $SECRET" 2>/dev/null || true
}

# 2. User + workspace via Django shell (no token needed). Output captured and
# asserted — a failure aborts here with the captured stderr, not downstream.
WS_OUT="$($API <<'PY' 2>"$DIR/.seed-err.log" | tail -1 || true
from django.contrib.auth import get_user_model
from plane.db.models import Workspace, WorkspaceMember
User = get_user_model()
user, _ = User.objects.get_or_create(
    email="test@iswe.co.nz",
    defaults={"username": "test", "first_name": "Test", "last_name": "User", "is_active": True},
)
ws, _ = Workspace.objects.get_or_create(slug="plane-cli-test",
    defaults={"name": "Plane CLI Test", "owner": user})
WorkspaceMember.objects.get_or_create(workspace=ws, member=user,
    defaults={"role": 20, "created_by": user, "updated_by": user})
print("ok")
PY
)"
if [ "$WS_OUT" != "ok" ]; then
  echo "workspace seed failed:" >&2
  head -c 500 "$DIR/.seed-err.log" >&2; echo >&2
  rm -f "$DIR/.seed-err.log"
  exit 1
fi
rm -f "$DIR/.seed-err.log"
echo "workspace: $WS_SLUG ready" >&2

# 3. Token: reuse the cached one only if the API still accepts it (a volume
# wipe invalidates it); otherwise mint a fresh key via Django shell.
SECRET=""
if [ -f "$ENVF" ]; then
  SECRET=$(sed -n 's/^export HOMETUTOR_TICKETS_TOKEN_TEST=//p' "$ENVF" | head -1)
fi
if [ -n "$SECRET" ]; then
  if [ "$(api_code GET "/workspaces/$WS_SLUG/members/")" = "200" ]; then
    echo "token: cached key still valid" >&2
  else
    echo "token: cached key rejected — minting fresh" >&2
    SECRET=""
  fi
fi
if [ -z "$SECRET" ]; then
  SECRET="$($API <<'PY' 2>/dev/null | tail -1 || true
from uuid import uuid4
from django.contrib.auth import get_user_model
from plane.db.models import APIToken
user = get_user_model().objects.get(email="test@iswe.co.nz")
tok = APIToken.objects.filter(user=user, label="plane-test-seed", is_active=True).first()
if tok is None:
    tok = APIToken.objects.create(user=user, label="plane-test-seed", user_type=0,
                                  token="plane_api_" + uuid4().hex, is_active=True)
print(tok.token)
PY
)"
  [ -n "$SECRET" ] || { echo "token creation failed" >&2; exit 1; }
  echo "token: plane-test-seed key ready" >&2
fi

# 4. Project (API): find by identifier, else create with the same payload
# shape the CLI probe uses ({name, identifier}).
PROJ_JSON="$(api GET "/workspaces/$WS_SLUG/projects/" || true)"
[ -n "$PROJ_JSON" ] || { echo "project list failed (check api/token)" >&2; exit 1; }
PROJ_ID="$(printf '%s' "$PROJ_JSON" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); const list=j.results||j; const p=(Array.isArray(list)?list:[]).find((x)=>x.identifier==="TEST"); console.log(p?p.id:"")' 2>/dev/null || true)"
if [ -n "$PROJ_ID" ]; then
  echo "project: $PROJ_IDENT exists" >&2
else
  rm -f "$DIR/.seed-proj.json"
  api POST "/workspaces/$WS_SLUG/projects/" "{\"name\":\"$PROJ_NAME\",\"identifier\":\"$PROJ_IDENT\"}" > "$DIR/.seed-proj.json"
  PROJ_ID="$(bun -e 'const j=JSON.parse(await Bun.file("'"$DIR"'/.seed-proj.json").text()); console.log(j.id||"")' 2>/dev/null || true)"
  [ -n "$PROJ_ID" ] || { echo "project creation failed:" >&2; head -c 300 "$DIR/.seed-proj.json" >&2; echo >&2; exit 1; }
  echo "project: created $PROJ_IDENT" >&2
fi
rm -f "$DIR/.seed-proj.json"

# 4b. Type labels (v1 project create does not provision them, but
# `plane create --type <t>` requires `type:<t>`). Find-or-create each; the
# POST response is checked — a 401 (stale token) or error body fails loudly.
for T in bug feature ops plan; do
  HAVE="$(api GET "/workspaces/$WS_SLUG/projects/$PROJ_ID/labels/" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); const list=j.results||j; console.log((Array.isArray(list)?list:[]).some((x)=>x.name==="type:'"$T"'")?"yes":"no")' 2>/dev/null || echo no)"
  if [ "$HAVE" = "yes" ]; then
    echo "label: type:$T exists" >&2
  else
    NEW_ID="$(api POST "/workspaces/$WS_SLUG/projects/$PROJ_ID/labels/" "{\"name\":\"type:$T\"}" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); console.log(j.id||"")' 2>/dev/null || true)"
    [ -n "$NEW_ID" ] || { echo "label creation failed for type:$T (check token/project)" >&2; exit 1; }
    echo "label: created type:$T" >&2
  fi
done

# 5. Env file for the CLI. PLANE_CACHE is test-local so runs never touch
# the developer registry cache (24h TTL would hide the TEST project).
umask 077
cat > "$ENVF" <<EOF
export PLANE_API_BASE=$APIBASE
export PLANE_SEAT=test
export HOMETUTOR_TICKETS_TOKEN_TEST=$SECRET
export PLANE_WORKSPACE=$WS_SLUG
export PLANE_PROJECT_ID=$PROJ_ID
export PLANE_IDENT=$PROJ_IDENT
export PLANE_CACHE=$DIR/.plane-cache
EOF
chmod 600 "$ENVF"
echo "wrote $ENVF" >&2

printf '{"url":%s,"workspaceSlug":%s,"projectId":%s,"identifier":%s}\n' \
  "$(bun -e 'console.log(JSON.stringify(process.argv[1]))' "$URL")" \
  "$(bun -e 'console.log(JSON.stringify(process.argv[1]))' "$WS_SLUG")" \
  "$(bun -e 'console.log(JSON.stringify(process.argv[1]))' "$PROJ_ID")" \
  "$(bun -e 'console.log(JSON.stringify(process.argv[1]))' "$PROJ_IDENT")"
