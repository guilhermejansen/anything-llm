#!/bin/bash
set -euo pipefail

# Check if STORAGE_DIR is set
if [ -z "${STORAGE_DIR:-}" ]; then
    echo "================================================================"
    echo "⚠️  ⚠️  ⚠️  WARNING: STORAGE_DIR environment variable is not set! ⚠️  ⚠️  ⚠️"
    echo ""
    echo "Not setting this will result in data loss on container restart since"
    echo "the application will not have a persistent storage location."
    echo "It can also result in weird errors in various parts of the application."
    echo ""
    echo "Please run the container with the official docker command at"
    echo "https://docs.anythingllm.com/installation-docker/quickstart"
    echo ""
    echo "⚠️  ⚠️  ⚠️  WARNING: STORAGE_DIR environment variable is not set! ⚠️  ⚠️  ⚠️"
    echo "================================================================"
fi

wait_for_postgres() {
  local connection_string="$1"
  local host
  local port

  host="$(echo "$connection_string" | sed -E 's#^[a-zA-Z0-9+.-]+://([^@/]+@)?([^:/?]+).*#\2#')"
  port="$(echo "$connection_string" | sed -nE 's#^[a-zA-Z0-9+.-]+://([^@/]+@)?[^:/?]+:([0-9]+).*#\2#p')"

  if [ -z "$host" ] || [ "$host" = "$connection_string" ]; then
    echo "[entrypoint] Could not parse DATABASE_URL host. Skipping TCP wait."
    return 0
  fi

  if [ -z "$port" ]; then
    port=5432
  fi

  echo "[entrypoint] Waiting for PostgreSQL at ${host}:${port}..."
  local retries=60
  for ((i=1; i<=retries; i++)); do
    if nc -z "$host" "$port" >/dev/null 2>&1; then
      echo "[entrypoint] PostgreSQL is reachable."
      return 0
    fi
    sleep 2
  done

  echo "[entrypoint] PostgreSQL did not become reachable in time (${retries} attempts)."
  return 1
}

PRISMA_SCHEMA_PATH="${PRISMA_SCHEMA:-}"
if [ -z "$PRISMA_SCHEMA_PATH" ]; then
  if [ -n "${DATABASE_URL:-}" ]; then
    PRISMA_SCHEMA_PATH="./prisma/schema.postgres.prisma"
  else
    PRISMA_SCHEMA_PATH="./prisma/schema.prisma"
  fi
fi

PRISMA_DB_MODE="sqlite"
case "$PRISMA_SCHEMA_PATH" in
  *postgres*)
    PRISMA_DB_MODE="postgresql"
    ;;
  *)
    if [ -n "${DATABASE_URL:-}" ]; then
      PRISMA_DB_MODE="postgresql"
    fi
    ;;
esac

if [ "$PRISMA_DB_MODE" = "postgresql" ] && [ -n "${DATABASE_URL:-}" ]; then
  wait_for_postgres "$DATABASE_URL"
fi

{
  cd /app/server/ &&
    # Disable Prisma CLI telemetry (https://www.prisma.io/docs/orm/tools/prisma-cli#how-to-opt-out-of-data-collection)
    export CHECKPOINT_DISABLE=1 &&
    echo "[entrypoint] Using Prisma schema: ${PRISMA_SCHEMA_PATH}" &&
    npx prisma generate --schema="$PRISMA_SCHEMA_PATH" &&
    if [ "$PRISMA_DB_MODE" = "postgresql" ]; then
      echo "[entrypoint] Applying PostgreSQL schema with prisma db push..." &&
      npx prisma db push --schema="$PRISMA_SCHEMA_PATH" &&
      echo "[entrypoint] Running idempotent seed for system settings..." &&
      node ./prisma/seed.js
    else
      echo "[entrypoint] Applying SQLite migrations with prisma migrate deploy..." &&
      npx prisma migrate deploy --schema="$PRISMA_SCHEMA_PATH"
    fi &&
    node /app/server/index.js
} &
{ node /app/collector/index.js; } &
wait -n
exit $?
