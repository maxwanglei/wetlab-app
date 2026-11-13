# Two targets: `api` (the backend alone) and `app` (the default, and what deploy_vm.sh ships:
# the API plus the built React app it serves from the same origin).
FROM node:24-slim AS frontend
WORKDIR /srv/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.14-slim AS api
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
RUN pip install --no-cache-dir "uv>=0.13,<0.14"
WORKDIR /srv/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev
COPY backend/ ./
COPY db/ /srv/db/
ENV PATH="/srv/backend/.venv/bin:$PATH"
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers --forwarded-allow-ips='*'"]

FROM api AS app
COPY --from=frontend /srv/frontend/dist /srv/frontend/dist
ENV FRONTEND_DIST=/srv/frontend/dist
