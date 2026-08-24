#!/usr/bin/env bash

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_docker
require_env

"${COMPOSE[@]}" up -d --build --remove-orphans jira-mcp
wait_for_health 180

port="${MCP_DOCKER_PORT:-37242}"
echo "Interface: http://127.0.0.1:$port/admin/"
echo "MCP:       http://127.0.0.1:$port/mcp"
