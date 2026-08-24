#!/usr/bin/env bash

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_docker
"${COMPOSE[@]}" logs -f --tail="${TAIL_LINES:-200}" jira-mcp
