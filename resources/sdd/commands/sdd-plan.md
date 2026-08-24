---
description: Especificar e planejar uma issue Jira com agentes SDD, sem implementar codigo.
argument-hint: <ISSUE-KEY>
allowed-tools: Read, Glob, Grep, Bash, Write, Edit, Agent, mcp__cloud-mcp__jira_get_workspace_binding, mcp__cloud-mcp__jira_list_profiles, mcp__cloud-mcp__jira_bind_workspace, mcp__cloud-mcp__jira_get_issue, mcp__cloud-mcp__jira_list_attachments, mcp__cloud-mcp__jira_read_attachment, mcp__cloud-mcp__jira_create_subtask, mcp__cloud-mcp__jira_edit_task, mcp__cloud-mcp__jira_record_sdd_event, jira_get_workspace_binding, jira_list_profiles, jira_bind_workspace, jira_get_issue, jira_list_attachments, jira_read_attachment, jira_create_subtask, jira_edit_task, jira_record_sdd_event
---

<!-- sdd:section command.sdd-plan:start -->
Voce esta executando `/sdd-plan` para planejar uma issue Jira. Entrada: `$ARGUMENTS`.

<!-- sdd:partial workflow-writer -->

<!-- sdd:partial multi-project -->

<!-- sdd:partial execution-context -->

Regras obrigatorias:

1. Extraia exatamente uma chave no formato `PROJ-123`. Se estiver ausente ou ambigua, pergunte antes de continuar. Antes do `JIRA_GATE`, execute a descoberta de peers do bloco multi-projeto: se a chave pertencer a um grupo, aplique o FANOUT e planeje cada membro, na `order`, executando as regras abaixo por completo dentro do workspace de cada membro; caso contrario, siga em MODO SINGLE sem alteracao.
2. Execute o `JIRA_GATE` antes de criar ou alterar `docs/sdd/specs`: chame `jira_get_workspace_binding`. Se nao houver vinculo, liste perfis, pergunte qual perfil/projeto usar, vincule e valide novamente. Sem contexto Jira valido, encerre sem gerar planejamento local.
3. Execute o checkpoint inicial na seguinte sequencia:
   a. Leia a issue com `jira_get_issue`. Recuse se o projeto nao corresponder ao binding.
   b. Calcule um hash normalizado dos campos principais da issue.
   c. Chame `jira_record_sdd_event` no pai com `eventKey: <ISSUE>/plan/<hash12>/started`, `eventType: PLAN_STARTED`, `targetStatus: inProgress` e o proximo passo.
   d. Falha neste checkpoint bloqueia o comando. Nao prossiga.
4. Consulte anexos. Nesta fase, leia os relevantes diretamente do Jira apenas para avaliacao; nao crie diretorio, asset, spec, workflow ou subtarefa.
5. Leia `.claude/agents/sdd-refinement-reviewer.md` e delegue usando exatamente `subagent_type: "sdd-refinement-reviewer"`. Nunca use `code`, `developer` ou agente generico.
6. Se o veredito for `BLOCKED`, registre `PLAN_BLOCKED` no pai com a mesma revisao, blockers e proximo passo; pare antes de qualquer escrita local ou subtarefa.
7. Para refinar, colete respostas do usuario e mostre um patch Jira proposto. Somente apos confirmacao explicita use `jira_edit_task`; depois releia a issue e repita o `REFINEMENT_GATE` completo. Resposta em chat sem persistencia no Jira nao libera o planejamento.
8. O gate so passa com zero blockers, zero `NEEDS CLARIFICATION`, criterios verificaveis e anexos obrigatorios acessiveis. Warnings aceitos devem virar premissas explicitas e reversiveis.
9. Somente apos `REFINEMENT_GATE: PASS`, leia os padroes e crie/retome a pasta. Inicialize ou migre `workflow.json` schema v2 com `runId`, `planRevision`, `attempts`, `eventLedger` e `pendingJiraEvents`.
10. Execute `ATTACHMENT_INGEST`: baixe todos os anexos listados para `assets/`. Use `<attachmentId>-<nome-saneado>`, removendo diretorios, controles e caracteres fora de `[A-Za-z0-9._-]`; nunca sobrescreva IDs diferentes.
11. Grave texto em UTF-8 e decodifique binarios Base64 sem imprimir conteudo em logs. Calcule SHA-256 e gere `assets/manifest.json` com ID, nome original, path relativo, MIME, tamanhos, hash, status e erro seguro. Nunca execute anexos.
12. Antes dos agentes, delegue exatamente `sdd-jira-coordinator` para criar/reconciliar `[SDD][SPEC] Specification`, `[SDD][RESEARCH] Technical Research` e `[SDD][PLAN] Technical Plan`.
13. Leia `sdd-orchestrator.md` e delegue exatamente `sdd-orchestrator` em modo PLAN. Para cada agente, o orquestrador deve transicionar/comentar a subtarefa com `TASK_STARTED` antes da chamada e `TASK_COMPLETED` somente apos artefato/check aprovado.14. A sequencia exata e `sdd-spec-writer`, `sdd-researcher`, `sdd-planner`; depois `sdd-jira-coordinator` reconcilia as `TASK-*` e a subtarefa `[SDD][QA] Quality Review`, cuja chave confirmada e registrada em `qa.issueKey`. Spec com `NEEDS CLARIFICATION` registra falha e volta ao refinement.
15. Nao edite codigo, nao crie branch e nao invoque implementador ou QA neste comando.
16. Grave `phase: "READY_TO_BUILD"` somente com refinement PASS, checklist PASS, documentos completos, hashes consistentes e subtarefas reconciliadas.

<!-- sdd:partial fail-fast -->
<!-- sdd:section command.sdd-plan:end -->
