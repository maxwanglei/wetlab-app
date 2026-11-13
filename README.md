# Wet Lab

A web app for an in vitro drug-metabolism lab. Plan experiments, track reagent and tissue lots, paste
bench results copied from Excel, and fit substrate-depletion kinetics to get intrinsic clearance,
percent inhibition, and the apparent fraction metabolised by each enzyme.

The backend is FastAPI with SQLAlchemy 2 on PostgreSQL, with hand-written SQL migrations run by
Alembic. The frontend is React 19 with TypeScript, Vite, TanStack Query, and Plotly. All sample data
is fictitious.

## Run it locally

You need Docker, Python 3.14 with [uv](https://docs.astral.sh/uv/), and Node 24.

```bash
docker compose up -d db                  # Postgres 18 on port 5433, database wetlab_demo
cd backend
uv run alembic upgrade head              # build the lab schema
uv run python -m app.seed.demo           # load the sample data (refuses any database not ending in _demo or _test)
DEV_USER_EMAIL=demo@example.org uv run uvicorn app.main:app --port 8000   # acts as the demo member without signing in
```

In a second terminal:

```bash
cd frontend
npm ci
npm run dev                              # http://localhost:5173, with /api proxied to port 8000
```

## Test

```bash
cd backend && uv run pytest              # needs the Docker database; builds its own wetlab_test
cd frontend && npm run typecheck
cd frontend && npm run e2e               # Playwright, against the local app only
```

Never point the end-to-end tests at a deployed site. They create experiments and save results.

## Layout

- `backend/app` holds the API routes, services, Pydantic schemas, and the depletion science in
  `science/depletion.py`.
- `backend/migrations/versions` holds the numbered migrations. `0001_baseline` executes
  `db/wetlab_schema.sql`, the source of truth for the schema.
- `frontend/src` holds the React app. API types are generated from the backend's OpenAPI document with
  `cd backend && uv run python -m scripts.export_openapi`, then `cd frontend && npm run api:types`.
- `deploy` holds the scripts and the runbook for the hosted deployment.

## Install it for a lab

`docs/deploy.md` covers the two ways a lab runs Wet Lab: on one computer with no server, set up by
`scripts/setup.sh` and started by `scripts/start.sh`, and on a server inside the institution's network.
`docs/publish-checklist.md` lists what must hold before the code is published.
The two scripts run their own Docker Compose project, `wetlab`, on port 5433, so stop the development
database above before trying them on a development machine.

## Deploy the hosted demo

See `deploy/README.md`. Settings and secrets live in a git-ignored `.env` (start from `.env.example`).
Run `scripts/check-public.sh` before every push. It fails if any private value from `.env` appears in
the repository or its history.
