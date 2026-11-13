#!/bin/bash
# Set Wet Lab up on one computer from a clean checkout: Postgres in Docker, the lab database and its schema,
# the Python and JavaScript dependencies, the built web app, and the first lab member. Rerunning it is safe:
# it applies only pending migrations and leaves the lab's data alone.
#   Usage: scripts/setup.sh --email ada@example.org --name "Ada Lovelace" [--role postdoc]
# --name is needed only the first time an email is added. WETLAB_DB_PORT (default 5433) picks the database port.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="" EMAIL="" ROLE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2:?--name needs a value}"; shift 2 ;;
    --email) EMAIL="${2:?--email needs a value}"; shift 2 ;;
    --role) ROLE="${2:?--role needs a value}"; shift 2 ;;
    *) echo "unknown option $1; see the usage at the top of $0" >&2; exit 2 ;;
  esac
done
DB_PORT="${WETLAB_DB_PORT:-5433}"
DB_NAME=wetlab
SERVER="postgresql+psycopg://postgres:postgres@localhost:$DB_PORT"

need() { command -v "$1" >/dev/null || { echo "$1 was not found: $2" >&2; exit 1; }; }
need docker "install Docker Desktop, or Docker Engine on Linux, and start it"
need uv "install uv 0.13 or later, see https://docs.astral.sh/uv/"
need node "install Node 24, see https://nodejs.org"
need npm "npm comes with Node"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || { echo "Node $NODE_MAJOR was found; Wet Lab needs Node 24 or later" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running, or this user cannot use it (on Linux, join the docker group)" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "the Docker Compose plugin was not found: install Docker Desktop, or docker-compose-plugin on Linux" >&2; exit 1; }

echo "== Postgres on port $DB_PORT"
# A fixed project name keeps the lab's data in one Docker volume wherever this folder is moved or unpacked.
WETLAB_DB_PORT="$DB_PORT" docker compose -p wetlab up -d --wait db

echo "== Backend"
cd backend
uv sync --frozen
uv run python - "$SERVER" "$DB_NAME" <<'PY'
import sys

from sqlalchemy import create_engine, text

server, name = sys.argv[1], sys.argv[2]
admin = create_engine(f"{server}/postgres", isolation_level="AUTOCOMMIT")
with admin.connect() as connection:
    if connection.scalar(text("SELECT 1 FROM pg_database WHERE datname = :name"), {"name": name}) is None:
        connection.execute(text(f'CREATE DATABASE "{name}"'))
        print(f"created the database {name}")
PY
DATABASE_URL="$SERVER/$DB_NAME" uv run alembic upgrade head
if [ -n "$EMAIL" ]; then
  DATABASE_URL="$SERVER/$DB_NAME" uv run python -m scripts.add_member --email "$EMAIL" ${NAME:+--name "$NAME"} ${ROLE:+--role "$ROLE"}
fi

echo "== Web app"
cd ../frontend
npm ci
npm run build

echo
echo "Set up. Start Wet Lab with:"
echo "  ${WETLAB_DB_PORT:+WETLAB_DB_PORT=$WETLAB_DB_PORT }WETLAB_USER_EMAIL=${EMAIL:-<your email>} scripts/start.sh"
