# Cloud Jira MCP

MCP Streamable HTTP em TypeScript para operar multiplas instancias Jira Cloud,
vincular workspaces, criar e editar issues, transicionar workflows, ler anexos e
administrar tudo por uma interface web.

## Executar

```bash
cp .env.example .env
npm install
npm run build
npm start
```

- MCP: `http://127.0.0.1:37242/mcp`
- Interface: `http://127.0.0.1:37242/admin`
- Health: `http://127.0.0.1:37242/health/ready`

Antes do primeiro uso, altere `MCP_SERVER_BEARER_TOKEN`,
`MCP_ADMIN_PASSWORD` e `JIRA_CREDENTIALS_MASTER_KEY`. Gere a chave de credenciais
com:

```bash
openssl rand -base64 32
```

O token de cada Jira e informado somente pela interface administrativa. Ele e
validado contra o Jira e cifrado com AES-256-GCM antes de ser salvo no SQLite.

## Desenvolvimento

```bash
npm run dev
npm run dev:web
```

O Vite roda na porta `5173` e encaminha `/api` para o backend na porta `37242`.

## Verificacao

```bash
npm run typecheck
npm test
npm run build
```

Consulte [PLANO.md](./PLANO.md) para arquitetura, contratos e proximas entregas.

## Instrumentacao SDD

A tool `sdd_init` detecta Flutter, React, React Native, Angular e backends Node.js com
TypeScript. Datadog e OpenAPI sao aplicados como overlays somente quando ja
existem no projeto. Ela cria ou atualiza apenas `AGENTS.md`,
`docs/constitution.md`, `docs/sdd/templates/`,
`docs/sdd/.instrumentation.json` e os comandos Cloud gerenciados em
`.claude/commands/`.

A instrumentacao tambem instala `.claude/commands/sdd-task.md`. O comando
`/sdd-task` orienta o agente a inspecionar o projeto, estruturar a historia,
propor criterios observaveis e registrar duvidas sem inventar regras de negocio.
Ele consulta `jira_get_workspace_binding` e usa o perfil, projeto e
`customFieldMap` do Jira conectado. Depois da confirmacao explicita do usuario,
cria a issue pela tool existente `jira_create_task`. O antigo comando gerenciado
`cloud-task.md` e removido durante a atualizacao; arquivos locais sem os
marcadores gerenciados sao preservados.

O mesmo catalogo instala `/sdd-plan`, `/sdd-build` e os agentes em
`.claude/agents/`. `/sdd-plan <ISSUE-KEY>` gera `issue.md`, `spec.md`,
`checklist.md`, `research.md`, `plan.md`, `tasks.md` e um `workflow.json` retomavel em
`docs/sdd/specs/<ISSUE-KEY>/`, alem de reconciliar subtarefas Jira sem
duplicacao. `/sdd-build <ISSUE-KEY>` exige o estado `READY_TO_BUILD`, executa as
tarefas aprovadas e so conclui a issue depois de `QA: PASS`.

No Claude Code, registre este MCP com o alias `cloud-mcp`. Os comandos e
subagentes SDD usam esse alias nos `allowed-tools`/`tools` como
`mcp__cloud-mcp__jira_get_issue`, e os subagentes que acessam Jira
declaram `mcpServers: [cloud-mcp]`. Se o alias local for diferente, os
subagentes podem nao enxergar as tools MCP mesmo quando o agente principal
consegue usa-las.

O progresso e sincronizado continuamente no Jira. `jira_add_comment` publica
comentarios gerais e `jira_record_sdd_event` registra eventos idempotentes com
comentario estruturado e transicao opcional. O card pai recebe marcos; cada
subtarefa recebe inicio, bloqueio/falha e conclusao. A conclusao so ocorre apos
validacoes aprovadas.

No `BUILD_COMPLETED`, o evento pode incluir um `report` estruturado com os
horarios do build, tarefas, QA e validacoes. O servidor renderiza um dashboard
executivo PNG em 4K usando SVG e Sharp, escolhe orientacao horizontal ou vertical,
pagina tabelas longas e salva a imagem em
`docs/sdd/specs/<ISSUE-KEY>/report/`. O Jira recebe somente um comentario
textual com resumo do desenvolvimento, tempos, tarefas, QA, validacoes e o path
local do dashboard. Falha de renderizacao local aparece como aviso e nao desfaz
um build aprovado.

Falhas de rede, timeout, rate limit ou Jira 5xx sao repetidas uma vez. Erros de
agente/configuracao, permissao, input, artefato ou validacao bloqueiam
imediatamente. O fluxo nunca troca silenciosamente `sdd-implementer` por um
agente generico. Eventos Jira pendentes ficam no `workflow.json` schema v2 e
precisam ser sincronizados antes da retomada.

Antes de criar esses documentos, `/sdd-plan` executa um refinement gate inspirado
no Spec Kit. Ele avalia objetivo, ator, escopo, jornadas independentes,
Given/When/Then, regras, permissoes, dados, integracoes, estados de erro,
requisitos nao funcionais, dependencias e anexos. Gaps materiais geram
`NEEDS CLARIFICATION` e bloqueiam o fluxo sem criar a pasta da spec ou
subtarefas. As respostas precisam ser confirmadas, gravadas no Jira e avaliadas
novamente. Somente `PASS` permite gerar spec, checklist, pesquisa e plano.

Os tres comandos aplicam `JIRA_GATE` antes de qualquer trabalho: o workspace
precisa estar vinculado a um perfil habilitado e projeto Jira valido. Quando o
vinculo nao existe, o agente lista as opcoes, pergunta qual usar, vincula e
valida novamente. Sem sucesso no gate, nao cria issue, documentos de spec,
subtarefas nem alteracoes de codigo.

Durante `/sdd-plan`, todos os anexos acessiveis da issue sao ingeridos em
`docs/sdd/specs/<ISSUE-KEY>/assets/`. Os nomes locais recebem o ID Jira como
prefixo e sao saneados; `assets/manifest.json` registra MIME type, tamanhos,
SHA-256, caminho e eventuais falhas. Binarios sao decodificados sem registrar o
Base64 nos logs. Anexos sao tratados como dados nao confiaveis e nunca sao
executados. Se um contrato ou referencia obrigatoria nao puder ser baixado, o
planejamento fica bloqueado. `/sdd-build` compara a lista Jira e os hashes locais
com o manifesto e exige novo planejamento quando houver mudanca.

Agentes instalados:

- `sdd-orchestrator`
- `sdd-refinement-reviewer`
- `sdd-spec-writer`
- `sdd-researcher`
- `sdd-planner`
- `sdd-jira-coordinator`
- `sdd-implementer`
- `sdd-qa-reviewer`

O fluxo sempre possui duas etapas:

```text
sdd_init({ workspacePath: "/caminho/do/projeto", action: "preview" })
sdd_init({ action: "apply", previewId: "id-retornado-na-previa" })
```

A previa expira em 15 minutos, so pode ser aplicada uma vez e e invalidada se
algum arquivo planejado mudar. Sem `workspacePath`, o servidor usa MCP Roots
quando o cliente fornecer exatamente uma root. O Jira e opcional apenas para a
instrumentacao; os comandos operacionais SDD exigem vinculo. Quando o workspace
estiver vinculado, perfil e projeto aparecem na constituicao.

No Docker, configure o mapeamento entre os caminhos informados pelo cliente e o
volume montado no container:

```dotenv
MCP_WORKSPACES_HOST_ROOT=/Volumes/External HD/Projetos
MCP_WORKSPACES_CONTAINER_ROOT=/workspaces
SDD_CATALOG_PATH=./resources/sdd
```

## Docker Compose

O fluxo recomendado no Mac usa Docker Compose e um volume nomeado para preservar
o SQLite entre rebuilds.

Primeira configuracao:

```bash
./scripts/docker-setup.sh
```

O script cria `.env` com Bearer token, senha administrativa e chave AES aleatorios.
O arquivo fica com permissao `600` e nao entra no Git.

Build e primeira subida:

```bash
./scripts/docker-up.sh
```

Depois de qualquer melhoria no codigo, execute:

```bash
./scripts/docker-redeploy.sh
```

Esse comando roda o build multi-stage. Dentro da imagem sao executados typecheck,
testes e builds do backend e da interface; somente depois o Compose recria o
container e aguarda o health check.

Comandos operacionais:

```bash
./scripts/docker-build.sh       # valida e gera a imagem
./scripts/docker-up.sh          # build + up + health check
./scripts/docker-redeploy.sh    # ciclo completo apos uma alteracao
./scripts/docker-status.sh      # estado e health do container
./scripts/docker-logs.sh        # acompanha logs
./scripts/docker-down.sh        # encerra sem apagar o banco
```

O banco fica no volume `cloud-jira-mcp-data`. `docker-down.sh` nao remove esse
volume. Para usar outra porta no Mac, configure `MCP_DOCKER_PORT` no `.env`; o
servico continua ouvindo na porta `37242` dentro do container.

