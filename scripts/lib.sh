#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE=(docker compose --project-directory "$PROJECT_DIR" -f "$PROJECT_DIR/compose.yaml")

cd "$PROJECT_DIR"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Erro: comando '$1' nao encontrado." >&2
    exit 1
  fi
}

require_docker() {
  require_command docker
  if ! docker info >/dev/null 2>&1; then
    echo "Erro: Docker Desktop nao esta rodando ou o daemon nao esta acessivel." >&2
    exit 1
  fi
  docker compose version >/dev/null
}

require_env() {
  if [[ ! -f "$PROJECT_DIR/.env" ]]; then
    echo "Arquivo .env ausente. Execute ./scripts/docker-setup.sh primeiro." >&2
    exit 1
  fi
}

wait_for_health() {
  local timeout="${1:-120}"
  local elapsed=0
  local container_id

  container_id="$("${COMPOSE[@]}" ps -q jira-mcp)"
  if [[ -z "$container_id" ]]; then
    echo "Erro: container jira-mcp nao foi criado." >&2
    return 1
  fi

  printf "Aguardando health check"
  while (( elapsed < timeout )); do
    local health
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
    if [[ "$health" == "healthy" ]]; then
      echo " pronto."
      return 0
    fi
    if [[ "$health" == "unhealthy" || "$health" == "exited" || "$health" == "dead" ]]; then
      echo
      echo "Container ficou $health. Logs:" >&2
      "${COMPOSE[@]}" logs --tail=100 jira-mcp >&2
      return 1
    fi
    printf "."
    sleep 2
    elapsed=$((elapsed + 2))
  done

  echo
  echo "Timeout aguardando container saudavel." >&2
  "${COMPOSE[@]}" logs --tail=100 jira-mcp >&2
  return 1
}
