#!/usr/bin/env bash
# Per-boot reconciliation for the FinOps Engine Cloud Agent environment.
# Brings up PostgreSQL + Redis, ensures the dev role/database exist, and applies
# migrations. Safe to run repeatedly: every step is guarded and idempotent.
set -euo pipefail

cd "$(dirname "$0")/.."

# Load dev defaults (respects any Cursor Secrets already in the environment).
# shellcheck source=.cursor/dev-env.sh
. ./.cursor/dev-env.sh

echo "[start] starting PostgreSQL 16 cluster"
sudo pg_ctlcluster 16 main start 2>/dev/null || true
for _ in $(seq 1 30); do
  pg_isready -h localhost -p 5432 -q && break
  sleep 1
done
pg_isready -h localhost -p 5432 -q

echo "[start] starting Redis"
redis-cli ping >/dev/null 2>&1 || sudo redis-server --daemonize yes --save "" --appendonly no
for _ in $(seq 1 30); do
  redis-cli ping >/dev/null 2>&1 && break
  sleep 1
done
redis-cli ping >/dev/null

echo "[start] ensuring dev role and database"
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -c \
  "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='finops') THEN CREATE ROLE finops LOGIN PASSWORD 'finops'; END IF; END \$\$;"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='finops_dev'" | grep -q 1 \
  || sudo -u postgres createdb -O finops finops_dev

echo "[start] applying database migrations"
npm run migrate

echo "[start] infrastructure ready (PostgreSQL + Redis migrated)"
