#!/usr/bin/env bash
# Run the mattermost-client integration tests against a real Mattermost in
# docker compose. Host needs docker only — the tests run in an oven/bun
# container on the compose network.
#
#   ./run.sh          # up → test → down -v
#   KEEP=1 ./run.sh   # leave the stack running for inspection/re-runs
set -euo pipefail
cd "$(dirname "$0")"

PROJECT=mm-client-it
compose() { docker compose -p "$PROJECT" -f docker-compose.yml "$@"; }

cleanup() {
  if [[ "${KEEP:-0}" == "1" ]]; then
    echo "KEEP=1 — stack left running (docker compose -p $PROJECT down -v to clean up)"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Clean slate: bootstrap relies on first-user-becomes-admin on a fresh DB.
compose down -v --remove-orphans >/dev/null 2>&1 || true

echo "== starting mattermost stack =="
compose up -d --wait mattermost

echo "== running integration tests =="
# Run as the host user so node_modules written into the repo mount stays
# user-owned (the oven/bun image defaults to root).
compose run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp tests
