#!/usr/bin/env bash
# Rollback rehearsal (completion spec, rollback gate): runs an older SECURE
# revision's API against a disposable database migrated to THIS checkout's
# newest schema, and probes it. Proves the named fallback is schema-compatible.
#
# Usage: scripts/with-test-postgres.sh scripts/rehearse-fallback.sh <commit>
#   (needs TEST_DATABASE_URL pointing at a disposable local database)
#
# Never point this at production. The old unauthenticated 277d2d3 is not a
# fallback (its startup db push refuses the migrated schema; see migrations test).
set -euo pipefail
COMMIT="${1:?usage: rehearse-fallback.sh <commit>}"
: "${TEST_DATABASE_URL:?TEST_DATABASE_URL (disposable, local) is required}"
case "$TEST_DATABASE_URL" in *localhost*|*127.0.0.1*) ;; *) echo "refusing a non-local database" >&2; exit 2;; esac

HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
TOKEN="rehearsal-owner-token-0123456789abcdef"   # synthetic
PORT=$((4800 + RANDOM % 300))
cleanup() { [[ -n "${PID:-}" ]] && kill "$PID" 2>/dev/null || true; git -C "$HERE" worktree remove --force "$WORK/app" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

echo "[rehearsal] migrating the disposable database to the newest schema ($(git -C "$HERE" rev-parse --short HEAD))"
(cd "$HERE" && DATABASE_URL="$TEST_DATABASE_URL" node scripts/migrate-deploy.mjs >/dev/null)

echo "[rehearsal] checking out fallback $COMMIT"
git -C "$HERE" worktree add --detach "$WORK/app" "$COMMIT" >/dev/null 2>&1
(cd "$WORK/app/backend" && npm ci --silent --ignore-scripts >/dev/null && npx prisma generate >/dev/null 2>&1)

echo "[rehearsal] starting the fallback API against the newest schema"
# Its own startup runs its migrate script: every one of its migrations is
# already applied, so it must report nothing pending and start.
(cd "$WORK/app/backend" && PORT=$PORT DATABASE_URL="$TEST_DATABASE_URL" OWNER_API_TOKEN="$TOKEN" FRONTEND_URL="http://127.0.0.1" \
  node scripts/migrate-deploy.mjs > "$WORK/migrate.log" 2>&1 && PORT=$PORT DATABASE_URL="$TEST_DATABASE_URL" OWNER_API_TOKEN="$TOKEN" FRONTEND_URL="http://127.0.0.1" node src/server.js > "$WORK/server.log" 2>&1) &
PID=$!
for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.5; done

api="http://127.0.0.1:$PORT"
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
fail() { echo "[rehearsal] FAILED: $1"; echo "--- migrate"; cat "$WORK/migrate.log"; echo "--- server"; tail -20 "$WORK/server.log"; exit 1; }

grep -q "No pending migrations\|Done" "$WORK/migrate.log" || fail "the fallback's migrate step did not complete"
[[ "$(code "$api/ready")" == "200" ]] || fail "/ready is not 200"
[[ "$(code "$api/api/characters")" == "401" ]] || fail "an unauthenticated request was not refused"
SES=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" "$api/api/auth/session" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).sessionToken||""))')
[[ "$SES" == ses_* ]] || fail "no owner session"
CID=$(curl -s -X POST -H "Authorization: Bearer $SES" -H "Content-Type: application/json" -d '{"name":"Rehearsal Character","persona":"Fictional adult (synthetic)."}' "$api/api/characters" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).id||""))')
[[ -n "$CID" ]] || fail "could not write a character"
[[ "$(code -X POST -H "Authorization: Bearer $SES" -H "Content-Type: application/json" -d "{\"characterId\":\"$CID\",\"duration\":\"30s\"}" "$api/api/pipeline/generate-script")" == "201" ]] || fail "could not create a content package"
[[ "$(code -H "Authorization: Bearer $SES" "$api/api/pipeline")" == "200" ]] || fail "could not read the pipeline"
echo "[rehearsal] PASSED: fallback $COMMIT runs on the newest schema (ready, 401 without a session, owner session, write, package, read)"
