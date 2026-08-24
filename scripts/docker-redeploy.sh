#!/usr/bin/env bash

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_docker
require_env

echo "Validando, buildando e publicando a versao local..."
"${COMPOSE[@]}" build jira-mcp
"${COMPOSE[@]}" up -d --force-recreate --remove-orphans jira-mcp
wait_for_health 180

port="${MCP_DOCKER_PORT:-37242}"
echo "Deploy local concluido: http://127.0.0.1:$port/admin/"
