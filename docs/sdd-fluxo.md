# Fluxo Visual SDD

Este guia mostra o caminho feliz do SDD Cloud, desde a instrumentacao inicial
do projeto ate a execucao das tarefas planejadas. Use como mapa rapido para
explicar a ordem dos comandos, os gates obrigatorios e os artefatos gerados.

Sempre que este fluxo mudar, atualize tambem `docs/sdd-fluxo-print.html`. A
versao HTML e o manual visual imprimivel aberto pela area logada do MCP Web.

## Visao Geral

```mermaid
flowchart TD
  A[Projeto sem SDD] --> B[sdd_init preview]
  B --> C{Revisar mudancas}
  C -->|aprovado| D[sdd_init apply]
  C -->|ajustar| B

  D --> E[Constituicao + templates + comandos + agentes]
  E --> F[/sdd-task pedido da tarefa]
  F --> G{JIRA_GATE}
  G -->|sem vinculo| H[Vincular workspace a perfil/projeto Jira]
  H --> G
  G -->|ok| I[Criar Task Jira refinavel]

  I --> J[/sdd-plan ISSUE-KEY]
  J --> K[PLAN_STARTED no Jira]
  K --> L[REFINEMENT_GATE com sdd-refinement-reviewer]
  L --> M{Issue refinada?}
  M -->|nao| N[Registrar blockers e patch sugerido]
  N --> O[Usuario confirma respostas]
  O --> P[Atualizar Jira]
  P --> L
  M -->|sim| Q[Ingerir anexos e criar docs/sdd/specs/ISSUE-KEY]

  Q --> R[Spec + checklist]
  R --> S[Research tecnico]
  S --> T[Plan + tasks]
  T --> U[Subtarefas Jira reconciliadas]
  U --> V{READY_TO_BUILD?}

  V -->|nao| J
  V -->|sim| W[/sdd-build ISSUE-KEY]
  W --> X[Executar TASK-* com sdd-implementer]
  X --> Y[QA com sdd-qa-reviewer]
  Y --> Z{QA PASS?}
  Z -->|nao| AA[BUILD_BLOCKED ou QA_FAILED]
  Z -->|sim| AB[BUILD_COMPLETED + resumo textual no Jira]
```

## 1. Instrumentar o projeto

Execute primeiro em modo preview:

```text
sdd_init({ workspacePath: "/caminho/do/projeto", action: "preview" })
```

Revise a previa. Se estiver correta, aplique:

```text
sdd_init({ action: "apply", previewId: "id-retornado-na-previa" })
```

O apply instala ou atualiza:

- `AGENTS.md`
- `docs/constitution.md`
- `docs/sdd/templates/`
- `.claude/commands/sdd-task.md`
- `.claude/commands/sdd-plan.md`
- `.claude/commands/sdd-build.md`
- `.claude/agents/sdd-*.md`

## 2. Criar uma Task Jira com `/sdd-task`

Use quando a demanda ainda esta em texto livre:

```text
/sdd-task <pedido da tarefa>
```

O comando:

- valida o `JIRA_GATE`;
- vincula o workspace a um perfil/projeto Jira se necessario;
- monta titulo, descricao, escopo e criterios de aceite;
- mostra o payload para confirmacao;
- cria a Task Jira somente depois da confirmacao explicita.

Saida esperada:

```text
PROJ-123 criado
Proximo passo: /sdd-plan PROJ-123
```

## 3. Planejar uma issue com `/sdd-plan`

Use quando ja existe uma issue Jira:

```text
/sdd-plan PROJ-123
```

O comando executa:

- `JIRA_GATE`: workspace vinculado, perfil habilitado e projeto correto.
- `PLAN_STARTED`: checkpoint inicial no Jira.
- `REFINEMENT_GATE`: o `sdd-refinement-reviewer` avalia se a issue esta pronta.
- Ingestao de anexos: cria `assets/manifest.json` e salva anexos em `assets/`.
- Escrita dos artefatos SDD.
- Criacao/reconciliacao das subtarefas Jira.

Artefatos criados em `docs/sdd/specs/PROJ-123/`:

```text
issue.md
spec.md
checklist.md
research.md
plan.md
tasks.md
qa.md
workflow.json
assets/
```

Se o refinement falhar, o fluxo para antes de criar a spec e registra blockers.
As respostas precisam ser confirmadas e gravadas no Jira antes de repetir o gate.

Saida esperada quando tudo passa:

```text
READY_TO_BUILD
Proximo passo: /sdd-build PROJ-123
```

## 4. Executar o plano com `/sdd-build`

Use somente depois de `READY_TO_BUILD`:

```text
/sdd-build PROJ-123
```

O comando:

- revalida Jira, hashes, anexos e `workflow.json`;
- registra `PHASE_STARTED`;
- executa cada `TASK-*` com `sdd-implementer`;
- registra inicio, fim, status e validacoes em cada subtarefa Jira;
- roda QA com `sdd-qa-reviewer`;
- conclui a issue principal somente com `QA: PASS`;
- publica `BUILD_COMPLETED` com resumo textual no Jira quando aprovado.

Falhas bloqueiam o fluxo com `BUILD_BLOCKED`, `TASK_FAILED`, `TASK_BLOCKED` ou
`QA_FAILED`, mantendo evidencia no Jira e no `workflow.json`.

## Regras de Ouro

- Sem `JIRA_GATE`, nenhum comando operacional cria artefatos ou muda codigo.
- Sem `REFINEMENT_GATE: PASS`, `/sdd-plan` nao cria spec.
- Sem `READY_TO_BUILD`, `/sdd-build` nao executa tarefas.
- Sem `QA: PASS`, a issue principal nao e concluida.
- O Jira e a fonte de verdade de produto; `workflow.json` e o checkpoint tecnico.
- Anexos sao dados nao confiaveis: podem ser lidos, mas nunca executados.
- Subagentes que usam Jira dependem do alias MCP `cloud-mcp`.

## Resumo Rapido

```text
sdd_init preview
  -> revisar
sdd_init apply
  -> /sdd-task "pedido"
  -> /sdd-plan PROJ-123
  -> resolver blockers, se houver
  -> /sdd-build PROJ-123
  -> QA PASS
  -> BUILD_COMPLETED
```
