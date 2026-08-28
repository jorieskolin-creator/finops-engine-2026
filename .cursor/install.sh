#!/usr/bin/env bash
# Idempotent dependency refresh for the FinOps Engine Cloud Agent environment.
# System packages (PostgreSQL 16, Redis) live in the base snapshot; this script
# only refreshes source-derived Node dependencies after checkout.
set -euo pipefail

cd "$(dirname "$0")/.."

# Locked install to match package-lock.json exactly.
npm ci

echo "[install] dependencies installed"
