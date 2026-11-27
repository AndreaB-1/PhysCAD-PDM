#!/usr/bin/env bash
# Runs the agent's integration test against a real API server (needs Postgres; DATABASE_URL points at a throw-away DB).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
api="$here/../../api"
export DATABASE_URL="${DATABASE_URL:-postgres://plm:plm@localhost:5432/plm_agent_it}"
port="${PORT:-18090}"
log="$(mktemp)"
(cd "$api" && PORT="$port" npx tsx test/agent-it-server.ts >"$log" 2>&1) &
pid=$!
trap 'kill $pid 2>/dev/null || true; pkill -P $pid 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do grep -q '"server"' "$log" 2>/dev/null && break; sleep 0.5; done
line="$(grep '"server"' "$log")" || { cat "$log"; exit 1; }
export PLM_IT_SERVER="$(node -e "console.log(JSON.parse(process.argv[1]).server)" "$line")"
export PLM_IT_CONTROL="$(node -e "console.log(JSON.parse(process.argv[1]).control)" "$line")"
export PLM_IT_VAULT="$(node -e "console.log(JSON.parse(process.argv[1]).vaultId)" "$line")"
dotnet test "$here/PlmAgent.Tests" --logger "console;verbosity=normal" "$@"
