# Security hardening — 2026-09-07

## Dependências e compatibilidade

sharp ^0.34.5 → ^0.35.4 (lock 0.35.4, libvips 1.3.3). Requer Node >=20.9.0, compatível com Node 22 do Docker e Node 22.23.1 local. TypeScript e processamento de imagens existentes passaram sem mudanças de API.
Referência: https://sharp.pixelplumbing.com/install/

Atualizações compatíveis no lockfile também corrigem alertas de @hono/node-server, browserslist, fast-uri, hono, ip-address, nanoid, postcss e qs. Vite 7.3.5 → 7.3.6 remove a versão vulnerável de esbuild aninhada. npm audit após instalação limpa: zero vulnerabilidades reportadas; isso não equivale a uma auditoria integral de código nativo.

## Credenciais e rede

O uso normal de MCP_SERVER_BEARER_TOKEN é exclusivamente autenticação de entrada: config.ts → config.bearerToken → comparação timingSafeEqual em http-server.ts. Docker/Compose não o enviam para um serviço remoto.

Foi encontrado um fluxo condicional real de configuração: JIRA_PROFILES_JSON.apiTokenEnv pode indicar MCP_SERVER_BEARER_TOKEN; o bootstrap cria credentialRef=env:MCP_SERVER_BEARER_TOKEN, CredentialStore.resolve lê process.env e JiraProfileService fornece o resultado aos clientes Jira/Confluence. Estes enviam Basic base64(email:token) para o baseUrl configurado (/rest/api/3/... ou /wiki/api/v2/...). O destino pode ser qualquer URL HTTPS configurada pelo operador. Isso é desnecessário para o token de autenticação do MCP e cria risco de vazamento por configuração incorreta, sem evidência de exfiltração ocorrida.

CredentialStore agora rejeita referências a MCP_SERVER_BEARER_TOKEN, MCP_ADMIN_PASSWORD e JIRA_CREDENTIALS_MASTER_KEY antes de ler o valor. Referências env de tokens Jira legítimos e armazenamento AES-256-GCM permanecem disponíveis. Secrets reais não foram lidos nem registrados durante a investigação.

Requisições autenticadas agora recusam redirects automáticos. Downloads de anexos usam apenas HTTPS no site configurado ou em *.media.atlassian.com, verificam cada salto (máximo cinco), nunca encaminham Authorization e interrompem leitura ao exceder o limite de bytes. URLs em metadados de anexo não são usadas para requisições autenticadas. Erros não JSON agora leem o corpo uma vez, evitando falha de stream já consumido.

Limites: baseUrl continua configurável por administrador/operador autenticado; sites privados e DNS não são bloqueados genericamente. Não se afirma proteção integral contra SSRF/DNS rebinding. CDNs fora dos hosts de mídia permitidos serão recusadas e precisam de revisão explícita antes de serem admitidas. Não houve teste com uma conta Jira/Confluence real. Respostas de erro externas continuam incluídas no contrato de detalhes; o endpoint configurado é uma fronteira de confiança. Nomes de variáveis arbitrários continuam permitidos para credenciais Jira, exceto os três secrets internos; a correção não impede reutilização manual de valores por um operador.

.env não é versionado e está ignorado; somente .env.example contém placeholders. Credenciais persistidas continuam cifradas com IV aleatório e tag GCM. Logs HTTP usam metadados e redação de headers; logs MCP selecionam argumentos por allowlist, sem corpos, apiToken ou dados de anexos. A chave mestra continua sob responsabilidade do operador.

A página do M8ven não pôde ser recuperada nesta execução; a comparação usa os achados fornecidos na tarefa, sem afirmar causa exata do scanner nem novo score.

## Annotations

Os 26 tools declaram explicitamente os quatro booleanos. Nenhum nome, parâmetro ou formato de resultado foi removido. destructiveHint reflete perda possível de dados anteriores (remoção ou substituição), não qualquer escrita. readOnly/idempotent tratam efeitos funcionais; timestamps de acesso são incidentais.

| Tool | readOnlyHint | destructiveHint | idempotentHint | openWorldHint | Justificativa |
|---|---|---|---|---|---|
| jira_help | true | false | true | false | Consulta catálogo/contexto local; touch de lastSeen é metadado incidental. |
| jira_list_profiles | true | false | true | false | Consulta perfis locais sem credenciais. |
| jira_create_profile | true | false | true | false | Somente retorna URL; criar o perfil é uma ação posterior na interface admin. |
| jira_test_connection | true | false | true | true | Consulta remota sem mutação funcional. |
| jira_list_projects | true | false | true | true | Consulta remota sem mutação funcional. |
| jira_bind_workspace | false | true | true | true | Valida projeto via Jira e substitui binding anterior (perda da associação anterior); upsert determinístico. |
| jira_get_workspace_binding | true | false | true | false | Consulta binding local; lastSeen é metadado incidental. |
| jira_unbind_workspace | false | true | true | false | Remove binding; repetir retorna 404, mas não causa novo efeito. |
| jira_get_issue | true | false | true | true | Consulta remota sem mutação funcional. |
| jira_create_task | false | false | false | true | Criação remota aditiva, sem chave de deduplicação. |
| jira_create_subtask | false | false | false | true | Criação remota aditiva, sem chave de deduplicação. |
| jira_link_issues | false | false | false | true | POST sem deduplicação local; não assume garantia externa de idempotência. |
| jira_edit_task | false | true | true | true | PUT atribui campos; pode apagar conteúdo com texto vazio/null. Repetição mantém os valores. |
| jira_list_transitions | true | false | true | true | Consulta remota sem mutação funcional. |
| jira_transition_issue | false | false | false | true | Status já atingido é no-op, mas também aceita ID/nome de transição, incluindo possíveis loops; conservadoramente não idempotente. |
| jira_add_comment | false | false | false | true | Criação remota aditiva, sem chave de deduplicação. |
| jira_record_sdd_event | false | false | true | true | eventKey consulta propriedade do comentário antes de transição/criação; retries sequenciais deduplicados. Não há garantia atômica contra chamadas concorrentes. |
| jira_list_attachments | true | false | true | true | Consulta remota sem mutação funcional. |
| jira_add_attachment | false | false | false | true | Criação remota aditiva, sem chave de deduplicação. |
| jira_read_attachment | true | false | true | true | Consulta remota sem mutação funcional. |
| confluence_list_spaces | true | false | true | true | Consulta remota sem mutação funcional. |
| confluence_find_page | true | false | true | true | Consulta remota sem mutação funcional. |
| confluence_get_page | true | false | true | true | Consulta remota sem mutação funcional. |
| confluence_create_page | false | false | false | true | Criação remota aditiva, sem chave de deduplicação. |
| confluence_update_page | false | true | false | true | Substitui título/corpo e incrementa versão em cada chamada; pode apagar conteúdo. |
| sdd_init | false | true | false | false | Preview persiste um novo registro; apply usa preview uma vez e pode substituir/remover arquivos locais. Não idempotente para o contrato completo. |

## Validação

- npm ci: passou, incluindo scripts nativos; audit sem vulnerabilidades.
- npm run typecheck: passou (servidor e web).
- npm test: 59 testes passaram em cinco arquivos, incluindo dez regressões de segurança e verificação das annotations via tools/list real.
- npm run build: passou (TypeScript e Vite).
- npm run lint: não aplicável; não há script lint.
- docker build .: passou com Node 22, incluindo npm ci, typecheck, 59 testes, build e prune. Imagem: sha256:e147c142bc867a66cc5ffc7cefb53fe8dd08f1d3b921e1a0afcc71a5ddbf90aa.

Os três testes HTTP inicialmente falharam com listen EPERM no sandbox, não por assertivas de comportamento. Com permissão para sockets locais, passaram sem alterar expectativas ou ocultar testes. Não é possível atribuir a falha do scanner ao mesmo motivo sem seus logs.

## Licença

Licença MIT adicionada em LICENSE, com Copyright (c) 2026 Leonardo, após autorização explícita do autor. Metadados de package.json e package-lock.json também indicam MIT.
