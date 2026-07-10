#!/usr/bin/env bash
# Run the zulip-client integration tests against a real Zulip in docker
# compose. Host needs docker only — the tests run in an oven/bun container
# on the compose network.
#
#   ./run.sh          # up → seed → test → down -v
#   KEEP=1 ./run.sh   # leave the stack running for inspection/re-runs
#
# First boot runs Zulip's migrations and can take several minutes.
set -euo pipefail
cd "$(dirname "$0")"

PROJECT=zulip-client-it
PORT="${ZULIP_IT_PORT:-18011}"
compose() { docker compose -p "$PROJECT" -f docker-compose.yml "$@"; }

cleanup() {
  if [[ "${KEEP:-0}" == "1" ]]; then
    echo "KEEP=1 — stack left running (docker compose -p $PROJECT down -v to clean up)"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Clean slate unless the caller wants to reuse a warm stack.
if [[ "${REUSE:-0}" != "1" ]]; then
  compose down -v --remove-orphans >/dev/null 2>&1 || true
fi

echo "== starting zulip stack (first boot migrates for a few minutes) =="
# `proxy` is the published entrypoint and depends_on pulls up zulip + the
# rest of the stack behind it.
compose up -d proxy

echo "== waiting for the server =="
deadline=$((SECONDS + 600))
until curl -sf "http://localhost:${PORT}/api/v1/server_settings" >/dev/null 2>&1; do
  if ((SECONDS > deadline)); then
    echo "zulip never came up; recent logs:" >&2
    compose logs --tail 40 zulip >&2
    exit 1
  fi
  sleep 5
done

echo "== seeding realm + users (manage.py shell) =="
compose exec -T zulip su zulip -c "/home/zulip/deployments/current/manage.py shell" < seed.py

echo "== running integration tests =="
# Run as the host user so node_modules written into the repo mount stays
# owned by the invoking user, not root.
compose run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp tests
