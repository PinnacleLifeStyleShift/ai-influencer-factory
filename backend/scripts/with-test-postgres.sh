#!/usr/bin/env bash
# Runs a command against a DISPOSABLE local PostgreSQL cluster.
#
# - Creates a fresh cluster in a new temp directory on a random localhost port
# - Applies the Prisma schema to an empty database
# - Exports TEST_DATABASE_URL / DATABASE_URL for the command
# - Stops the cluster and deletes its directory on exit
#
# It never reads an existing DATABASE_URL and never connects to any remote DB.
# Requires PostgreSQL server binaries (initdb, pg_ctl). Usage:
#   scripts/with-test-postgres.sh node --test test/*.test.js
set -euo pipefail

PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
if [[ -z "${PG_BIN}" || ! -x "${PG_BIN}/initdb" ]]; then
  echo "PostgreSQL server binaries not found (set PG_BIN)." >&2
  exit 2
fi

WORK="$(mktemp -d /tmp/aif-pg.XXXXXX)"
PORT="${TEST_PG_PORT:-$(( 40000 + RANDOM % 20000 ))}"
RUN_AS=()
if [[ "$(id -u)" == "0" ]]; then
  # initdb refuses to run as root; use the postgres system user if present.
  chown postgres "${WORK}"
  RUN_AS=(su postgres -s /bin/bash -c)
fi

run_pg() {
  if [[ ${#RUN_AS[@]} -gt 0 ]]; then "${RUN_AS[@]}" "$*"; else bash -c "$*"; fi
}

cleanup() {
  run_pg "'${PG_BIN}/pg_ctl' -D '${WORK}/data' -m immediate stop" >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

run_pg "'${PG_BIN}/initdb' -D '${WORK}/data' -A trust -U aif_test" >/dev/null
run_pg "'${PG_BIN}/pg_ctl' -D '${WORK}/data' -w -l '${WORK}/log' \
  -o \"-p ${PORT} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''\" start" >/dev/null

export TEST_DATABASE_URL="postgresql://aif_test@127.0.0.1:${PORT}/postgres?schema=aif_test"
export DATABASE_URL="${TEST_DATABASE_URL}"

# Build the test database from the committed migrations (not db push), then
# fail if the migrations do not produce exactly prisma/schema.prisma.
npx prisma migrate deploy >/dev/null
if ! npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code >/dev/null; then
  echo "Schema drift: committed migrations do not match prisma/schema.prisma (create a migration)." >&2
  exit 1
fi

"$@"
