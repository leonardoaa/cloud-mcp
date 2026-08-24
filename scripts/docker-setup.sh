#!/usr/bin/env bash

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_command openssl

if [[ -f "$PROJECT_DIR/.env" ]]; then
  echo ".env ja existe; nenhuma credencial foi alterada."
  exit 0
fi

mcp_token="$(openssl rand -hex 32)"
admin_password="$(openssl rand -base64 24 | tr -d '\n')"
master_key="$(openssl rand -base64 32 | tr -d '\n')"

sed \
  -e "s|^MCP_SERVER_BEARER_TOKEN=.*|MCP_SERVER_BEARER_TOKEN=$mcp_token|" \
  -e "s|^MCP_ADMIN_PASSWORD=.*|MCP_ADMIN_PASSWORD=$admin_password|" \
  -e "s|^JIRA_CREDENTIALS_MASTER_KEY=.*|JIRA_CREDENTIALS_MASTER_KEY=$master_key|" \
  -e 's|^MCP_HOST=.*|MCP_HOST=0.0.0.0|' \
  -e 's|^MCP_ALLOWED_ORIGINS=.*|MCP_ALLOWED_ORIGINS=http://127.0.0.1:37242,http://localhost:37242|' \
  "$PROJECT_DIR/.env.example" > "$PROJECT_DIR/.env"

chmod 600 "$PROJECT_DIR/.env"

echo "Configuracao criada em $PROJECT_DIR/.env"
echo "Senha inicial da interface: $admin_password"
echo "Guarde essa senha agora; ela nao sera exibida novamente por este script."
