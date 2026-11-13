#!/bin/bash
# Start Wet Lab on this computer after scripts/setup.sh: Postgres in Docker, then the app at
# http://localhost:8000, serving the built web app. Only this computer can reach either. Every save is
# attributed to the lab member whose email WETLAB_USER_EMAIL gives. Stop it with Ctrl-C.
#   Usage: WETLAB_USER_EMAIL=ada@example.org scripts/start.sh
# WETLAB_PORT (default 8000) and WETLAB_DB_PORT (default 5433) can be set too.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${WETLAB_USER_EMAIL:?set WETLAB_USER_EMAIL to the email of the lab member using this computer}"
DB_PORT="${WETLAB_DB_PORT:-5433}"
[ -d frontend/dist ] || { echo "The web app is not built yet; run scripts/setup.sh first" >&2; exit 1; }

WETLAB_DB_PORT="$DB_PORT" docker compose -p wetlab up -d --wait db
cd backend
echo "Wet Lab is at http://localhost:${WETLAB_PORT:-8000}"
DATABASE_URL="postgresql+psycopg://postgres:postgres@localhost:$DB_PORT/wetlab" \
  DEV_USER_EMAIL="$WETLAB_USER_EMAIL" \
  exec uv run uvicorn app.main:app --host 127.0.0.1 --port "${WETLAB_PORT:-8000}"
