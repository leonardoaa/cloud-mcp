#!/usr/bin/env bash

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_env

if [[ ! -f "$PROJECT_DIR/dist/host-runner.js" ]]; then
  echo "Build ausente. Rodando npm run build..."
  npm run build
fi

export HOST_RUNNER_HOST="${HOST_RUNNER_HOST:-0.0.0.0}"
export HOST_RUNNER_PORT="${HOST_RUNNER_PORT:-37243}"

echo "Iniciando host runner em http://${HOST_RUNNER_HOST}:${HOST_RUNNER_PORT}"
echo "O container Docker acessa este runner via http://host.docker.internal:${HOST_RUNNER_PORT}"
echo "Mantenha este processo aberto enquanto usar terminais do SDD Kanban."
npm run host-runner
