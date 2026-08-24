# Plano do MCP Jira multi-instancia

## 1. Objetivo

Construir um MCP compartilhado que:

- se conecte a varias instancias Jira Cloud;
- permita incluir e editar perfis Jira durante uma conversa, sem reiniciar o
  servidor;
- ofereca uma interface web para administrar perfis, vinculos e operacoes Jira;
- registre e exiba na interface logs sanitizados das chamadas recebidas pelo MCP;
- identifique o workspace/projeto que originou a chamada;
- associe esse workspace a uma instancia Jira e a um projeto Jira;
- persista a associacao em SQLite para perguntar apenas na primeira vez;
- crie e edite tasks;
- crie subtasks;
- consulte e execute transicoes de status de tasks e subtasks;
- consulte issues e leia seus anexos;
- permita trocar ou remover uma associacao existente.

O primeiro release sera obrigatoriamente em Node.js + TypeScript, usando o SDK
oficial do MCP, a API REST v3 do Jira Cloud e exclusivamente o transporte MCP
Streamable HTTP. Nao sera implementado transporte stdio.

## 2. Decisoes de arquitetura

### 2.1 Identificacao do projeto chamador

O servidor nao deve usar o `process.cwd()` como identidade do projeto. Um mesmo
processo MCP pode servir clientes ou workspaces diferentes.

Ordem de resolucao:

1. usar a unica raiz `file://` informada pelo cliente via MCP Roots;
2. se houver varias roots, exigir `workspacePath` na tool;
3. se Roots nao for suportado, usar `workspacePath` obrigatorio;
4. canonicalizar com `realpath`, remover a barra final e gerar
   `workspace_id = sha256(canonical_path)`.

O caminho canonico permanece salvo para auditoria e para exibir associacoes. A
hash nao e segredo; apenas oferece uma chave estavel e de tamanho fixo.

### 2.2 Escolha inicial e persistencia

Antes de qualquer operacao Jira, um `WorkspaceResolver` procura no SQLite uma
associacao ativa para o `workspace_id`.

- Se existir, usa o perfil Jira e o `project_key` associados.
- Se nao existir e o cliente suportar MCP elicitation, solicita a escolha entre
  os perfis configurados e depois o projeto Jira.
- Se o cliente nao suportar elicitation, retorna um erro estruturado
  `WORKSPACE_NOT_BOUND`, com as opcoes validas e a instrucao para chamar
  `jira_bind_workspace`; o host/LLM pergunta ao usuario e repete a operacao.
- Uma associacao nunca e criada silenciosamente quando houver mais de uma opcao.

Mesmo havendo `defaultProjectKey` no perfil, o primeiro vinculo deve mostrar e
confirmar esse projeto. Isso evita criar issues no projeto errado.

### 2.3 Catalogo de varias instancias

O sistema expoe um catalogo (array logico) de perfis Jira. O array do `.env`
serve apenas para importar perfis iniciais no primeiro startup; depois disso, o
SQLite e a fonte de verdade do catalogo editavel. O processo nao deve reescrever
`.env`, pois isso e inseguro, fragil em containers e incompativel com deploys
imutaveis.

Perfis criados ou editados pelas tools entram imediatamente no catalogo, sem
reiniciar o servidor. O token nunca aparece ao listar ou consultar um perfil.

Exemplo de `.env`:

```dotenv
JIRA_PROFILES_JSON=[{"id":"cloud","name":"Jira Cloud","baseUrl":"https://cloud.atlassian.net","email":"usuario@empresa.com","apiTokenEnv":"JIRA_CLOUD_API_TOKEN","defaultProjectKey":"SCRUM","subtaskIssueType":"Subtask","statusAliases":{"inProgress":"Em andamento","codeReview":"Em analise","done":"Concluido"},"customFieldMap":{"acceptanceCriteria":"customfield_10000"}}]
JIRA_CLOUD_API_TOKEN=preencher_em_segredo
JIRA_CREDENTIALS_MASTER_KEY=chave_base64_de_32_bytes
JIRA_DB_PATH=./data/jira-mcp.sqlite
JIRA_ATTACHMENT_MAX_BYTES=10485760
```

Schema de validacao de cada perfil:

```ts
type JiraProfile = {
  id: string;
  name: string;
  baseUrl: string;
  email: string;
  credentialRef: string;
  defaultProjectKey?: string;
  subtaskIssueType?: string;
  statusAliases?: Record<string, string>;
  customFieldMap?: Record<string, string>;
};
```

Regras:

- `id` unico e estavel;
- somente HTTPS em `baseUrl`;
- remover `/` final da URL;
- perfis importados do ambiente recebem uma `credentialRef` do tipo `env`; perfis
  criados em runtime recebem referencia a uma credencial cifrada;
- falhar no startup se um perfil estiver invalido ou se sua credencial nao puder
  ser resolvida;
- nunca imprimir token, header `Authorization` ou o JSON completo de ambiente;
- `.env`, banco e cache de anexos entram no `.gitignore`.

Credenciais criadas em runtime serao cifradas com AES-256-GCM usando a master key
de `JIRA_CREDENTIALS_MASTER_KEY`. O banco guarda ciphertext, IV e authentication
tag, nunca a master key. A interface `CredentialStore` permitira trocar esse
backend por um secret manager externo sem alterar as tools.

Para uma integracao interna, email + API token com Basic Auth e suficiente no
MVP. OAuth 2.0 (3LO) deve ser uma evolucao antes de distribuir o MCP para
terceiros.

### 2.4 Banco SQLite

Usar migrations e habilitar `WAL`, `foreign_keys` e `busy_timeout`.

```sql
CREATE TABLE workspace_bindings (
  workspace_id       TEXT PRIMARY KEY,
  canonical_path     TEXT NOT NULL,
  workspace_name     TEXT,
  jira_profile_id    TEXT NOT NULL,
  jira_project_key   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  last_used_at       TEXT NOT NULL
);

CREATE INDEX idx_workspace_bindings_profile
  ON workspace_bindings (jira_profile_id, jira_project_key);

CREATE TABLE jira_profiles (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  base_url              TEXT NOT NULL UNIQUE,
  email                 TEXT NOT NULL,
  credential_ref        TEXT NOT NULL,
  default_project_key   TEXT,
  subtask_issue_type    TEXT,
  status_aliases_json   TEXT NOT NULL DEFAULT '{}',
  custom_field_map_json TEXT NOT NULL DEFAULT '{}',
  enabled               INTEGER NOT NULL DEFAULT 1,
  source                TEXT NOT NULL CHECK (source IN ('bootstrap', 'runtime')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE jira_credentials (
  id          TEXT PRIMARY KEY,
  ciphertext  BLOB NOT NULL,
  iv          BLOB NOT NULL,
  auth_tag    BLOB NOT NULL,
  created_at  TEXT NOT NULL,
  rotated_at  TEXT
);

CREATE TABLE mcp_call_logs (
  id                    TEXT PRIMARY KEY,
  request_id            TEXT NOT NULL UNIQUE,
  received_at           TEXT NOT NULL,
  completed_at          TEXT,
  duration_ms           INTEGER,
  protocol_method       TEXT NOT NULL,
  target_name           TEXT,
  operation_kind        TEXT NOT NULL,
  client_name           TEXT,
  client_version        TEXT,
  session_fingerprint   TEXT,
  workspace_id          TEXT,
  jira_profile_id       TEXT,
  jira_project_key      TEXT,
  issue_key             TEXT,
  http_status           INTEGER,
  outcome               TEXT NOT NULL,
  error_code            TEXT,
  safe_summary_json     TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_mcp_call_logs_received
  ON mcp_call_logs (received_at DESC);

CREATE INDEX idx_mcp_call_logs_filter
  ON mcp_call_logs (target_name, outcome, jira_profile_id, received_at DESC);
```

`workspace_bindings.jira_profile_id` referencia `jira_profiles.id`. Um perfil
deve ser desabilitado, em vez de apagado, enquanto houver vinculos. Tokens podem
existir no SQLite somente cifrados e autenticados; texto puro e proibido.

### 2.5 Inclusao e edicao interativa de Jiras

Ao exibir os perfis, incluir a opcao **Adicionar novo Jira**. Se o usuario disser
que nenhum perfil atende, o agente chama `jira_create_profile` e o servidor
conduz o cadastro.

Dados nao sensiveis solicitados por form elicitation:

- nome amigavel e ID/slug estavel sugerido a partir do nome;
- `baseUrl` HTTPS e e-mail da conta Atlassian;
- project key padrao, opcional;
- nome preferido do issue type de subtask, opcional.

Como form elicitation aceita apenas um objeto plano de valores primitivos, aliases
e custom fields nao serao solicitados como JSON digitado pelo usuario. Depois de
validar a conexao, o MCP consulta issue types, statuses e fields do Jira e o
agente oferece as opcoes descobertas. `jira_update_profile` recebe então os mapas
estruturados `statusAliases` e `customFieldMap`.

O API token nao pode passar por argumentos de tool, chat ou form elicitation. A
coleta segura segue este fluxo:

1. o MCP cria um `elicitationId` e uma URL HTTPS de uso unico no proprio servidor;
2. envia URL mode elicitation ao cliente;
3. o usuario abre a pagina autenticada e informa o token fora do cliente MCP;
4. o servidor cifra o token imediatamente, invalida a URL e nao registra o body;
5. testa `GET /rest/api/3/myself` e o acesso ao projeto informado;
6. somente apos o teste bem-sucedido grava e ativa o perfil no catalogo.

A URL expira em poucos minutos, e vinculada ao usuario/sessao autenticada que
iniciou o cadastro e nao contem token em query string. Sem URL elicitation, o
fallback seguro e cadastrar a credencial por variavel de ambiente/secret manager
e passar somente sua `credentialRef`; nunca pedir o token no chat.

A pagina de credencial exige uma autenticacao administrativa independente; o
`elicitationId` sozinho nao autentica o usuario. No MVP, o administrador se
autentica com uma senha cujo hash Argon2id fica na configuracao; em deploy remoto
a pagina exige HTTPS. OAuth 2.1 substituira essa autenticacao antes de um fluxo
multiusuario. Cookies de sessao devem ser `HttpOnly`, `Secure` e
`SameSite=Strict`.

Na edicao, campos omitidos permanecem inalterados. Trocar `baseUrl`, e-mail ou
credencial exige reteste antes do commit. A rotacao so descarta a credencial
anterior depois que a nova for validada. IDs de perfil com vinculos nao podem ser
alterados.

### 2.6 Servidor MCP via HTTP

Usar o transporte **Streamable HTTP** do SDK TypeScript oficial. HTTP+SSE legado
nao deve ser usado em uma implementacao nova.

Endpoints:

- `POST /mcp`: recebe mensagens JSON-RPC MCP e devolve JSON ou inicia stream SSE
  conforme negociado pelo transporte;
- `GET /mcp`: abre o stream SSE usado para mensagens servidor -> cliente quando
  necessario, inclusive elicitation;
- `DELETE /mcp`: encerra uma sessao MCP quando suportado pelo transporte;
- `GET /health/live`: confirma que o processo esta vivo;
- `GET /health/ready`: confirma configuracao valida, SQLite acessivel e migrations
  aplicadas, sem depender da disponibilidade momentanea do Jira.
- `GET /admin/credentials/{elicitationId}`: pagina autenticada para informar ou
  rotacionar token fora do cliente MCP;
- `POST /admin/credentials/{elicitationId}`: recebe o segredo uma unica vez,
  cifra e valida, sem logar o request body.

O servidor sera stateful por sessao MCP, com `MCP-Session-Id` aleatorio e
criptograficamente seguro. O cliente deve reenviar esse header depois do
`initialize`. Sessoes vivem em memoria no primeiro release; os vinculos de
workspace continuam duraveis no SQLite e nao dependem da sessao HTTP.

Regras do transporte:

- validar `Content-Type`, `Accept` e `MCP-Protocol-Version`;
- aceitar em `/mcp` somente metodos previstos pelo Streamable HTTP;
- validar estritamente o header `Origin` contra uma allowlist para evitar DNS
  rebinding;
- limitar tamanho do body JSON e tempo de requisicao;
- gerar request/correlation ID e propaga-lo nos logs;
- configurar CORS somente para origens conhecidas; CORS nao substitui
  autenticacao;
- usar keep-alive e encerramento gracioso de streams e conexoes no `SIGTERM`;
- expor o servidor diretamente em `127.0.0.1` no desenvolvimento;
- em ambiente remoto, operar atras de HTTPS/reverse proxy e confiar em headers de
  proxy apenas quando o proxy estiver explicitamente configurado.

Configuracao HTTP inicial:

```dotenv
MCP_HOST=127.0.0.1
MCP_PORT=37242
MCP_PATH=/mcp
MCP_ALLOWED_ORIGINS=http://127.0.0.1,http://localhost
MCP_AUTH_TOKEN_ENV=MCP_SERVER_BEARER_TOKEN
MCP_SERVER_BEARER_TOKEN=preencher_em_segredo
MCP_ADMIN_PASSWORD_HASH=hash_argon2id
MCP_SESSION_TTL_SECONDS=3600
MCP_MAX_BODY_BYTES=1048576
MCP_CALL_LOG_RETENTION_DAYS=30
MCP_CALL_LOG_MAX_ROWS=100000
```

Para uso remoto, exigir `Authorization: Bearer <token>` no MVP. Health checks nao
devem revelar configuracao nem credenciais. A camada de autenticacao deve ficar
isolada para permitir OAuth 2.1 em uma evolucao posterior.

Como sessoes ficam em memoria, o primeiro deploy tera uma unica replica. Para
escalar horizontalmente sera necessario adotar afinidade de sessao ou um store
compartilhado/event store compativel com o SDK, alem do SQLite compartilhado ser
substituido por um banco apropriado. Nao declarar o servico multi-replica antes
dessa mudanca.

### 2.7 Interface visual

Construir uma aplicacao web em React + TypeScript + Vite, servida pelo mesmo
backend HTTP. A UI nao chama tools MCP internamente: UI e tools usam a mesma
camada de servicos de aplicacao, garantindo validacao, autorizacao e comportamento
identicos nos dois canais.

Rotas visuais:

- `/admin/login`: autenticacao administrativa;
- `/admin/jiras`: lista, cria, edita, testa, desabilita e rotaciona credenciais;
- `/admin/workspaces`: consulta, cria, troca e remove vinculos workspace -> Jira;
- `/admin/issues`: pesquisa issues, cria task/subtask, edita, transiciona status e
  le anexos.
- `/admin/logs`: acompanha chamadas recebidas pelo MCP e investiga falhas.

Tela **Jiras**:

- tabela com nome, URL, e-mail mascarado, projeto padrao e estado;
- acao `Adicionar Jira` com formulario guiado e teste antes de salvar;
- descoberta e selecao dos projetos acessiveis;
- configuracao assistida do issue type de subtask;
- mapeamento visual de aliases para statuses descobertos;
- mapeamento visual de custom fields, inclusive criterios de aceite;
- acao separada `Rotacionar token`; o token atual nunca e exibido;
- aviso dos workspaces afetados antes de desabilitar um perfil.

Tela **Workspaces**:

- lista caminho/nome, perfil Jira, project key e ultimo uso;
- filtros por Jira e projeto;
- troca de perfil/projeto com validacao previa;
- remocao com confirmacao e destaque para vinculos quebrados.

Tela **Issues**:

- seletor de workspace ou perfil + projeto;
- leitura por issue key;
- formularios de task e subtask orientados pela metadata do Jira;
- edicao de summary, descricao, criterios de aceite e campos permitidos;
- seletor contendo somente transicoes atualmente validas;
- listagem e visualizacao segura de anexos de texto, PDF e imagem;
- link para abrir a issue diretamente no Jira.

Tela **Logs MCP**:

- atualizacao em tempo real por SSE, independente do stream do endpoint `/mcp`;
- tabela paginada por cursor com horario, cliente, metodo MCP, tool/resource,
  workspace, Jira, projeto, issue key, duracao e resultado;
- filtros por periodo, cliente, metodo, tool, workspace, Jira, projeto, outcome e
  error code;
- estados `received`, `running`, `success`, `error` e `cancelled`;
- painel de detalhe com request ID, timestamps, dados de correlacao e resumo
  sanitizado;
- destaque para chamadas lentas e erros recorrentes;
- botao para copiar request ID e facilitar correlacao com logs do processo;
- nenhum token, header, descricao de issue, conteudo de campo livre ou anexo.

API administrativa JSON, separada de `/mcp`:

- `POST /api/admin/session` e `DELETE /api/admin/session`;
- `GET/POST /api/admin/jira-profiles`;
- `GET/PATCH /api/admin/jira-profiles/:id`;
- `POST /api/admin/jira-profiles/:id/test`;
- `POST /api/admin/jira-profiles/:id/rotate-credential`;
- `POST /api/admin/jira-profiles/:id/disable`;
- `GET /api/admin/jira-profiles/:id/projects`;
- `GET /api/admin/jira-profiles/:id/metadata`;
- `GET/POST/PATCH/DELETE /api/admin/workspace-bindings/:workspaceId?`;
- endpoints de issues equivalentes as operacoes MCP em `/api/admin/issues`.
- `GET /api/admin/mcp-call-logs`: consulta paginada com filtros;
- `GET /api/admin/mcp-call-logs/:id`: detalhe sanitizado;
- `GET /api/admin/mcp-call-logs/stream`: eventos SSE em tempo real.

Todos os inputs e outputs usam os mesmos schemas Zod da camada de aplicacao.
Formularios mostram erros por campo e preservam valores nao sensiveis quando uma
validacao falhar.

Seguranca da UI:

- sessao em cookie `HttpOnly`, `Secure` e `SameSite=Strict`;
- protecao CSRF em toda mutacao e Content Security Policy sem scripts inline;
- API administrativa exige sessao propria; o Bearer token MCP nao concede acesso;
- token Jira vai somente ao endpoint seguro, com `Cache-Control: no-store`, body
  logging desativado e limpeza imediata do formulario;
- nenhuma credencial em HTML persistido, localStorage, URL, telemetria ou JSON;
- confirmacao para desabilitar perfil, remover vinculo e transicionar status;
- anexos sao renderizados isoladamente; tipos desconhecidos nunca sao tratados
  como HTML pela aplicacao.
- logs sao escapados como texto e nunca renderizam HTML recebido do cliente;
- consultas de logs possuem limite, paginacao e intervalo maximo permitido.

O MVP usa polling apenas para testes de conexao demorados; WebSocket nao e
necessario. A unica atualizacao continua da UI usa SSE para os logs. O layout deve
funcionar em desktop e tablet, com estados de loading, vazio, erro e sucesso
acessiveis por teclado e leitor de tela.

### 2.8 Registro de chamadas MCP

Um interceptor no limite do transporte HTTP cria o registro antes de despachar a
mensagem e o conclui em bloco `finally`. Assim, falhas de parse, autenticacao,
cancelamento e excecoes inesperadas tambem ficam observaveis.

Para `tools/call`, registrar o nome da tool e somente identificadores aprovados:
workspace ID, profile ID, project key e issue key. Para outros metodos, registrar
`protocol_method` e o nome de resource/prompt quando aplicavel. Nunca persistir:

- body HTTP ou argumentos completos da tool;
- headers `Authorization`, cookies ou `MCP-Session-Id` original;
- token Jira, descricoes, comentarios, criterios de aceite ou campos livres;
- conteudo, nome completo ou bytes de anexos;
- stack trace enviado para a interface.

O identificador da sessao e armazenado somente como HMAC/fingerprint nao
reversivel, permitindo correlacao sem possibilitar sequestro de sessao. O
`safe_summary_json` e produzido por allowlist especifica de cada tool, nunca por
redacao generica de um payload bruto.

O mesmo `request_id` aparece no SQLite e no log estruturado do processo. Stack
traces podem existir somente no log tecnico protegido, associados ao request ID e
com redacao de segredos. A UI recebe apenas `error_code` e mensagem segura.

Retencao e desempenho:

- job diario remove registros mais antigos que `MCP_CALL_LOG_RETENTION_DAYS`;
- ao atingir `MCP_CALL_LOG_MAX_ROWS`, remover primeiro os registros mais antigos;
- falha na auditoria gera alerta tecnico, mas nao repete uma operacao Jira;
- consultas usam cursor `(received_at, id)`, nunca offset em tabelas grandes;
- eventos SSE sao efemeros; ao reconectar, a UI busca o intervalo perdido pela
  API paginada;
- esta tabela registra chamadas MCP. Acoes da UI usam audit log administrativo
  separado para nao parecerem chamadas MCP.

## 3. Tools MCP

Todas as tools operacionais aceitam `workspacePath?`. O campo e opcional apenas
quando o workspace puder ser determinado de forma inequivoca por MCP Roots.

### Configuracao e diagnostico

- `jira_help`: apresenta as capacidades do servidor, lista todas as tools e
  explica fluxos comuns. Aceita `topic?` e `workspacePath?`, nao altera estado e
  nunca inicia elicitation.
- `jira_list_profiles`: lista configuracao nao sensivel e a opcao virtual
  `add_new`; nunca lista token ou referencia interna da credencial.
- `jira_get_profile`: consulta a configuracao nao sensivel de um perfil.
- `jira_create_profile`: cria um Jira, coleta parametros ausentes por elicitation
  e usa URL mode para cadastrar a credencial.
- `jira_update_profile`: edita campos e, opcionalmente, inicia a rotacao segura
  da credencial.
- `jira_disable_profile`: mostra os workspaces afetados e exige confirmacao antes
  de desabilitar.
- `jira_bind_workspace`: recebe `workspacePath`, `jiraProfileId` e
  `jiraProjectKey`; valida perfil, credencial e existencia/acesso ao projeto antes
  de gravar com upsert.
- `jira_get_workspace_binding`: mostra a associacao ativa.
- `jira_unbind_workspace`: remove a associacao, exigindo confirmacao do usuario.
- `jira_test_connection`: testa autenticacao e permissoes basicas do perfil.

`jira_help` complementa, mas nao substitui, o `tools/list` nativo do MCP.
`tools/list` continua sendo a fonte autoritativa para nomes e JSON Schemas;
`jira_help` fornece orientacao de uso para o agente.

Topicos aceitos:

- `overview` (padrao): lista concisa de todas as tools por categoria;
- `profiles`: cadastrar, editar, testar e desabilitar Jiras;
- `workspaces`: descobrir, vincular, trocar e remover associacoes;
- `issues`: consultar, criar e editar tasks/subtasks;
- `transitions`: listar e executar mudancas de status;
- `attachments`: listar e ler anexos;
- `troubleshooting`: codigos de erro e acao recomendada.

Resposta estruturada:

```ts
type JiraHelpResult = {
  server: { name: string; version: string };
  topic: string;
  tools: Array<{
    name: string;
    purpose: string;
    requiredArguments: string[];
    optionalArguments: string[];
    mutatesState: boolean;
    requiresWorkspaceBinding: boolean;
  }>;
  commonWorkflows: Array<{
    goal: string;
    steps: string[];
  }>;
  currentContext?: {
    workspaceResolved: boolean;
    workspaceBound: boolean;
    jiraProfileId?: string;
    jiraProjectKey?: string;
    recommendedNextTool?: string;
  };
};
```

A lista deve ser gerada a partir do mesmo registro usado para registrar as tools,
evitando documentacao divergente. Descricoes, exemplos e categorias ficam como
metadata nesse registro. A resposta nunca inclui token, credential reference,
caminho sensivel nao solicitado ou configuracao interna.

### Issues

- `jira_get_issue`: le campos principais, descricao, criterios de aceite,
  status, parent, subtasks e metadados de anexos.
- `jira_create_task`: recebe `summary`, `description?`, `acceptanceCriteria?`,
  `issueType? = Task` e `fields?`; usa o projeto do vinculo.
- `jira_edit_task`: recebe `issueKey` e apenas os campos a alterar. Nao aceita
  mudanca de status; isso pertence a tool de transicao.
- `jira_create_subtask`: recebe `parentIssueKey`, `summary`, `description?`,
  `acceptanceCriteria?` e `fields?`; resolve o tipo de subtask pela metadata do
  projeto, usando o nome configurado apenas como preferencia.
- `jira_list_transitions`: lista as transicoes atualmente permitidas para a
  issue.
- `jira_transition_issue`: recebe `issueKey` e `targetStatus` ou
  `statusAlias`; busca as transicoes disponiveis e executa pelo ID retornado pelo
  Jira. Funciona igualmente para task e subtask.

Descricao e campos multiline devem ser convertidos para Atlassian Document
Format. Campos extras serao filtrados/validados contra create/edit metadata antes
da chamada, com erros legiveis por campo.

### Anexos

- `jira_list_attachments`: lista ID, nome, MIME type, tamanho e autor.
- `jira_read_attachment`: recebe `issueKey`, `attachmentId` e `maxBytes?`.

Politica de leitura:

- confirmar que o anexo pertence a issue informada;
- aplicar limite de tamanho configuravel, com teto no servidor;
- para texto, JSON, XML e CSV, devolver texto UTF-8 com indicacao de truncamento;
- para PDF e imagens, devolver conteudo MCP binario/embedded resource quando o
  cliente suportar; caso contrario, salvar em cache privado e devolver um
  resource URI `jira-attachment://...`;
- nao seguir URLs de anexos fornecidas pelo usuario; baixar somente a URL/ID
  obtida da API Jira autenticada;
- nunca retornar um caminho fora do diretorio privado de cache.

Uploads nao fazem parte do escopo inicial, mas a camada HTTP deve permitir sua
adicao futura via multipart e `X-Atlassian-Token: no-check`.

## 4. Fluxos principais

### Primeira chamada no Classmap

1. Cliente chama `jira_create_task` a partir da root do Classmap.
2. MCP canonicaliza a root e consulta `workspace_bindings`.
3. Nao encontra vinculo e apresenta os perfis Jira disponiveis.
4. Usuario escolhe `Jira Cloud` ou `Adicionar novo Jira`.
5. Se escolher adicionar, o MCP coleta os dados, recebe o token pelo fluxo seguro
   e valida a conexao; o novo perfil passa a integrar a lista.
6. O MCP confirma ou solicita o project key do perfil escolhido.
7. MCP valida acesso ao projeto e grava o vinculo.
8. A criacao original continua, ou e repetida automaticamente pelo host caso a
   elicitation nao permita retomar a mesma chamada.

Nas chamadas seguintes, o passo 3 nao ocorre.

### Mudanca de status

1. Resolver workspace e perfil.
2. Validar que a issue pertence ao site configurado e, por padrao, ao projeto
   vinculado.
3. Consultar `GET /issue/{key}/transitions`.
4. Resolver alias/nome sem diferenciar maiusculas e acentos.
5. Se houver zero ou mais de uma correspondencia, retornar as opcoes; nao
   escolher arbitrariamente.
6. Executar a transicao pelo ID.

O mapa de status e apenas um conjunto de aliases amigaveis. IDs de transicao nao
devem ser fixos, pois dependem do workflow e do estado atual da issue.

## 5. Organizacao sugerida

```text
src/
  index.ts
  server/
    http-server.ts
    auth.ts
    health.ts
    sessions.ts
  config/
    schema.ts
    load-config.ts
  db/
    database.ts
    migrations.ts
    jira-profile-repository.ts
    workspace-binding-repository.ts
  credentials/
    credential-store.ts
    encrypted-sqlite-credential-store.ts
    secure-credential-flow.ts
  jira/
    jira-client.ts
    adf.ts
    metadata.ts
    transitions.ts
    attachments.ts
  workspace/
    roots.ts
    resolver.ts
  tools/
    help.ts
    profiles.ts
    bindings.ts
    issues.ts
    transitions.ts
    attachments.ts
  application/
    jira-profile-service.ts
    workspace-binding-service.ts
    issue-service.ts
  admin-api/
    routes.ts
    session.ts
    csrf.ts
  observability/
    mcp-call-interceptor.ts
    call-log-repository.ts
    call-log-sanitizer.ts
    call-log-retention.ts
    call-log-stream.ts
  errors/
    app-error.ts
tests/
  unit/
  integration/
  contract/
data/
web/
  src/
    app.tsx
    api/
    components/
    pages/
      jira-profiles.tsx
      workspace-bindings.tsx
      issues.tsx
      mcp-call-logs.tsx
```

Separar transporte MCP, API administrativa, UI, resolucao do workspace,
persistencia e cliente Jira permite testar a maior parte sem uma conta Jira real.
As regras de negocio ficam em `application/`, e nao nos handlers HTTP ou MCP.

## 6. Erros e seguranca

Codigos estruturados minimos:

- `WORKSPACE_REQUIRED`
- `WORKSPACE_NOT_BOUND`
- `PROFILE_NOT_FOUND`
- `PROFILE_ALREADY_EXISTS`
- `PROFILE_VALIDATION_FAILED`
- `CREDENTIAL_INPUT_REQUIRED`
- `CREDENTIAL_FLOW_EXPIRED`
- `PROJECT_NOT_ACCESSIBLE`
- `JIRA_AUTH_FAILED`
- `ISSUE_NOT_FOUND`
- `ISSUE_OUTSIDE_BOUND_PROJECT`
- `FIELD_VALIDATION_FAILED`
- `TRANSITION_NOT_AVAILABLE`
- `ATTACHMENT_TOO_LARGE`
- `ATTACHMENT_TYPE_UNSUPPORTED`
- `JIRA_RATE_LIMITED`

Requisitos adicionais:

- timeout e `AbortSignal` em toda chamada HTTP;
- retry limitado somente para `429`, `502`, `503` e `504`, respeitando
  `Retry-After`; nunca repetir POST/PUT cegamente se o resultado for incerto;
- logs estruturados com request ID, perfil, project key e issue key, sem corpo
  sensivel;
- autenticacao Bearer e validacao de Origin antes de entregar a requisicao ao
  transporte MCP;
- comparacao de tokens em tempo constante e redacao do header `Authorization`;
- rate limit por identidade/IP, com cuidado para aceitar IP do proxy somente
  quando `trust proxy` estiver configurado;
- autorizacao administrativa e CSRF independentes da autenticacao do endpoint
  MCP;
- validacao rigorosa das entradas das tools;
- confirmacao explicita para troca/remoção de vinculo;
- operacoes limitadas ao projeto vinculado por padrao, com override explicito no
  futuro se houver necessidade real.

## 7. Testes e criterios de aceite

### Unitarios

- parse e validacao de multiplos perfis;
- importacao idempotente do array bootstrap e CRUD do catalogo runtime;
- cifra autenticada, rotacao e ausencia da master key;
- redacao de segredos em logs e erros;
- allowlist de resumo por tool e fingerprint irreversivel de sessao;
- retencao por idade/quantidade e paginacao por cursor dos logs MCP;
- canonicalizacao de roots e escolha entre zero, uma ou varias roots;
- CRUD e concorrencia dos vinculos SQLite;
- conversao de texto para ADF;
- resolucao de tipo de issue, custom fields, aliases e transicoes;
- geracao do `jira_help` a partir do registro real de tools;
- limites, MIME types e truncamento de anexos.

### Integracao com HTTP simulado

- criar e editar task;
- criar subtask com `parent` correto;
- obter transicoes e mover task/subtask;
- tratar 400, 401, 403, 404, 429 e timeout;
- listar e ler anexos sem vazar o header de autenticacao em redirects;
- impedir issue de outro projeto no perfil vinculado.

### Contrato MCP

- `jira_help` lista todas as tools registradas e seus argumentos essenciais;
- cada nome retornado por `jira_help` existe em `tools/list` e nenhuma tool
  publica fica ausente;
- `jira_help` por topico filtra detalhes sem alterar o estado;
- quando houver workspace, o contexto recomenda vincular ou prosseguir usando o
  perfil correto;
- primeira chamada sem vinculo produz elicitation ou `WORKSPACE_NOT_BOUND`;
- a opcao `add_new` cria e disponibiliza um perfil sem reiniciar o MCP;
- form elicitation nunca solicita nem retorna API token;
- URL de credencial e de uso unico, expira e e vinculada ao usuario que iniciou
  o fluxo;
- edicao invalida nao substitui a configuracao ou credencial anterior;
- `jira_bind_workspace` persiste e a segunda chamada nao pergunta novamente;
- duas roots exigem `workspacePath`;
- trocar o vinculo altera o Jira usado na chamada seguinte;
- outputs das tools possuem schema estavel e nao contem credenciais.

### Transporte HTTP

- `initialize`, `tools/list`, `tools/call` e `resources/read` funcionam em
  Streamable HTTP;
- requisicao sem Bearer token ou com token invalido recebe `401` sem detalhes;
- `Origin` desconhecida recebe `403` antes do parser MCP;
- sessao inexistente/expirada e headers MCP invalidos produzem o status HTTP
  previsto pelo protocolo;
- duas sessoes simultaneas nao misturam roots, elicitation nem respostas;
- health checks continuam rapidos mesmo se o Jira estiver indisponivel;
- `SIGTERM` interrompe novas chamadas e encerra conexoes dentro do prazo definido.

### Interface visual

- login, logout, expiracao de sessao e protecao CSRF;
- criar, editar, testar e desabilitar perfil sem reiniciar o MCP;
- token nunca aparece em storage, URL, logs, telemetria ou responses;
- falha ao testar uma edicao mantem o perfil anterior funcional;
- descobrir projetos, statuses, issue types e custom fields;
- vincular e desvincular workspaces com os mesmos bloqueios das tools MCP;
- criar/editar task, criar subtask e transicionar usando os mesmos services;
- visualizar TXT, PDF e imagem, bloqueando HTML executavel;
- testes de componentes para loading, vazio, erro, confirmacao e sucesso;
- teste end-to-end do cadastro de Jira ate a criacao de uma task.
- acompanhar chamadas MCP por SSE e recuperar eventos perdidos pela API;
- filtrar logs e abrir detalhe sem expor argumentos livres ou credenciais;
- registrar corretamente sucesso, erro, cancelamento e duracao;
- aplicar retencao sem remover registros mais novos antes dos antigos;

### Smoke test em Jira de homologacao

- vincular dois workspaces a perfis/projetos diferentes;
- criar uma task em cada um e comprovar que nao houve cruzamento;
- editar ambas, criar subtasks e percorrer as transicoes disponiveis;
- ler um TXT, um PDF e uma imagem anexados;
- reiniciar o MCP e confirmar que os vinculos continuam no SQLite.

## 8. Entregas

1. **Fundacao HTTP:** projeto Node.js + TypeScript, Streamable HTTP em `/mcp`,
   autenticacao, health checks, configuracao validada, logs seguros, SQLite,
   migrations e resolucao por Roots.
2. **Servicos de aplicacao:** regras compartilhadas por MCP e API administrativa,
   sem duplicacao de logica de negocio.
3. **Catalogo Jira:** importacao bootstrap, listagem, criacao, edicao,
   desativacao, credential store cifrado e coleta segura por URL elicitation.
4. **Interface administrativa:** React + TypeScript, login, perfis Jira,
   credenciais, metadata, vinculos de workspace e tela de logs MCP.
5. **Tools MCP:** `jira_help`, vinculos, consulta, troca e remocao, com
   elicitation/fallback e cadastro de Jira durante a escolha.
6. **Issues:** leitura, criacao, edicao, ADF, custom fields e subtasks na UI e no
   MCP.
7. **Workflow:** listagem e execucao dinamica de transicoes.
8. **Anexos:** listagem, leitura limitada e visualizacao segura.
9. **Observabilidade:** interceptor, persistencia sanitizada, filtros, SSE e
   politica de retencao dos logs MCP.
10. **Qualidade:** testes de contrato, integracao simulada, E2E da UI, smoke test
    e guia de operacao/migracao do `.env` antigo.

## 9. Fora do MVP

- Jira Data Center/Server;
- OAuth 2.0 e fluxo multiusuario;
- upload e exclusao de anexos;
- comentarios, epics, sprints e busca JQL generica;
- sincronizacao automatica baseada em webhooks;
- credenciais em texto puro ou solicitadas pelo chat/form elicitation.

## 10. Acao de seguranca imediata

O API token compartilhado durante o planejamento deve ser considerado exposto.
Ele precisa ser revogado no Atlassian e substituido por um novo token antes de
qualquer implementacao ou teste. O novo valor nao deve ser enviado em chat nem
incluido em commits.
