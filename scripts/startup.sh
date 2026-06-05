#!/usr/bin/env bash
# GCP Compute Engine startup script for slihoot.
#
# Brings up the full stack (app + MySQL + Redis + Caddy) via docker compose.
# Idempotent: safe to re-run. Intended as a VM startup-script or a one-shot
# bootstrap on a fresh Debian/Ubuntu instance.
#
# Expectations:
#   - The repo is checked out (or rsynced) to $APP_DIR.
#   - $APP_DIR/.env exists with production secrets (see .env.example).
#
# Usage (manual):  sudo APP_DIR=/opt/slihoot bash scripts/startup.sh

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/slihoot}"

echo "[startup] target dir: ${APP_DIR}"

# --- Install Docker Engine + compose plugin if missing ---------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "[startup] installing docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[startup] docker compose plugin not found; install docker-compose-plugin for your distro." >&2
  exit 1
fi

cd "${APP_DIR}"

if [[ ! -f .env ]]; then
  echo "[startup] WARNING: ${APP_DIR}/.env not found — using defaults from docker-compose.yml." >&2
  echo "[startup] Set ADMIN_PASSWORD / JWT_SECRET / DB_PASSWORD / MYSQL_ROOT_PASSWORD / DOMAIN before going live." >&2
fi

# --- Build and start -------------------------------------------------------
echo "[startup] building and starting stack..."
docker compose pull --ignore-buildable || true
docker compose up -d --build

echo "[startup] done. Current status:"
docker compose ps
