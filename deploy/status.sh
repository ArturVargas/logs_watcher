#!/usr/bin/env bash
# Quick health view for logs-watcher. Prints no secrets.
cd "$(dirname "$0")" || exit 1
echo "== containers"; docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Health}}\t{{.Ports}}'
echo; echo "== healthz"; curl -fsS --max-time 5 http://127.0.0.1:8787/healthz || echo "healthz FAILED"; echo
echo; echo "== dead jobs";  docker compose exec -T app logs-watcher jobs list --state dead 2>&1 || true
echo; echo "== deferred_budget jobs"; docker compose exec -T app logs-watcher jobs list --state deferred_budget 2>&1 || true
echo; echo "== spend today (USD, UTC day)"; docker compose exec -T app logs-watcher budget show 2>&1 || true
echo; echo "== app logs (last ${1:-30})"; docker compose logs --no-color --tail "${1:-30}" app
