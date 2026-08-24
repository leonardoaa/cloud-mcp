---
description: Executar um planejamento SDD aprovado, sincronizando subtarefas Jira e QA.
argument-hint: <ISSUE-KEY>
allowed-tools: Read, Glob, Grep, Bash, Write, Edit, Agent, mcp__cloud-mcp__jira_get_workspace_binding, mcp__cloud-mcp__jira_list_profiles, mcp__cloud-mcp__jira_bind_workspace, mcp__cloud-mcp__jira_get_issue, mcp__cloud-mcp__jira_list_attachments, mcp__cloud-mcp__jira_edit_task, mcp__cloud-mcp__jira_record_sdd_event, jira_get_workspace_binding, jira_list_profiles, jira_bind_workspace, jira_get_issue, jira_list_attachments, jira_edit_task, jira_record_sdd_event
---

<!-- sdd:section command.sdd-build:start -->
Voce esta executando `/sdd-build` para implementar uma issue Jira planejada. Entrada: `$ARGUMENTS`.

<!-- sdd:partial workflow-writer -->

<!-- sdd:partial multi-project -->

<!-- sdd:partial execution-context -->

Regras obrigatorias:

1. Extraia exatamente uma chave `PROJ-123`. Antes do `JIRA_GATE`, execute a descoberta de peers do bloco multi-projeto: se a chave pertencer a um grupo, aplique o FANOUT e implemente cada membro, na `order`, executando as regras abaixo por completo dentro do workspace de cada membro; caso contrario, siga em MODO SINGLE sem alteracao. Em MODO SINGLE, execute o `JIRA_GATE` antes de ler ou alterar o workflow: resolva o vinculo; se ausente, permita escolha assistida, vincule e valide novamente. Sem Jira valido, encerre sem executar codigo.
2. Leia a issue, confirme o projeto vinculado e somente entao abra constituicao e `docs/sdd/specs/<ISSUE-KEY>/workflow.json`.
3. Recuse a execucao quando o workflow nao existir, nao registrar `refinement.verdict: "PASS"`, nao possuir checklist aprovado, contiver `NEEDS CLARIFICATION`, estiver `BLOCKED` ou nunca tiver atingido `READY_TO_BUILD`; indique `/sdd-plan <ISSUE-KEY>`.
4. Migre workflow v1 para v2 preservando dados. Antes de trabalhar, descarregue todos os `pendingJiraEvents`; falha impede retomada.
5. Valide anexos e hashes. Mudanca material exige novo `/sdd-plan`.
6. Capture `buildStartedAt` em ISO-8601 com timezone no momento de inicio real do build, persista no `workflow.json` e registre `PHASE_STARTED` no pai com eventKey `<ISSUE>/<runId>/r<revision>/build/started`, `targetStatus: inProgress` e o horario de inicio no resumo.
7. Delegue exatamente `sdd-orchestrator` em modo BUILD. Para cada `TASK-*`, use exclusivamente `subagent_type: "sdd-implementer"`; para QA, `sdd-qa-reviewer`; nunca `code` ou fallback direto. Apos delegar a fase ao `sdd-orchestrator`, nao escreva `workflow.json` ate o retorno; a sequencia dos itens 8 a 13 e executada por quem estiver orquestrando.
8. Para cada tarefa delegada, siga esta sequencia:

   **Antes de delegar o agente:**
   - Capture e persista `startedAt` na entrada da tarefa no `workflow.json`.
   - Registre `TASK_STARTED` na subtarefa com `targetStatus: inProgress`.

   **Apos o retorno do agente:**
   - Capture `finishedAt` e a observacao final.
   - Registre `TASK_COMPLETED` com arquivos, validacoes e `targetStatus: done` somente quando tudo passar.

9. Tarefas consecutivas do mesmo lote marcadas `[P]` em `tasks.md` podem ser delegadas em paralelo, no maximo 3 simultaneas, cada uma em seu proprio worktree: registre `TASK_STARTED` e `startedAt` de todas antes de disparar o lote; integre os worktrees sequencialmente, na ordem das tarefas, somente depois de todo o lote retornar. Conflito de merge registra `BUILD_BLOCKED` preservando os worktrees. Se uma tarefa do lote falhar, aguarde o retorno das demais, registre os resultados individuais e so entao bloqueie. Em duvida sobre o isolamento, execute sequencial.
10. Depois de cada retorno, consolide evidencias no `workflow.json`, incluindo horarios explicitos por tarefa. Se o agente criou worktree isolado, integre/mergeie as alteracoes aprovadas na branch de trabalho atual antes de marcar a tarefa como concluida. Nao repita tarefa concluida; bloqueios reais devem ser registrados na subtarefa correspondente.
11. Em qualquer erro, capture `buildFinishedAt` em ISO-8601 com timezone, registre `TASK_BLOCKED` ou `TASK_FAILED` na subtarefa e `BUILD_BLOCKED` no pai; mantenha a subtarefa aberta e pare imediatamente. O comentario final do `BUILD_BLOCKED` deve informar `Inicio do build: <buildStartedAt>` e `Fim do build: <buildFinishedAt>`.
12. Para QA, capture `qa.startedAt`, registre `QA_STARTED` na subtarefa e no pai; delegue exclusivamente `sdd-qa-reviewer`, informando o ciclo atual (`qa.attempts + 1` de no maximo 3). Ao terminar, persista `qa.finishedAt`, `qa.attempts`, status e observacao.
13. Em QA `FAIL` com correcoes minimas viaveis e dentro do escopo aprovado, execute um ciclo de correcao — no maximo 3 por build: incremente e persista `qa.attempts`; registre `TASK_PROGRESS` na subtarefa de QA com o ciclo `N/3` e os achados; delegue `sdd-implementer` somente com as correcoes minimas apontadas pelo QA, com a mesma disciplina de worktree e merge do item 8; repita o QA completo. Esgotados os 3 ciclos com `FAIL`, ou quando a correcao exigir mudanca de escopo, registre `QA_FAILED` na subtarefa e `BUILD_BLOCKED` no pai e pare.
14. `QA_FAILED` mantem cards abertos e bloqueia. Somente `QA_PASSED` conclui a subtask.
14b. Antes de `BUILD_COMPLETED`, confirme que todas as alteracoes dos worktrees dos agentes foram mergeadas na branch de trabalho atual e remova os worktrees temporarios criados para o build. Se algum worktree tiver alteracao nao consolidada, registre `BUILD_BLOCKED` e pare. Depois capture `buildFinishedAt` em ISO-8601 com timezone e persista no `workflow.json`.
15. Registre `BUILD_COMPLETED` seguindo esta sequencia:
    a. Capture `buildFinishedAt` em ISO-8601 com timezone. Persista no `workflow.json`.
    b. Monte o resumo textual com:
       - `Inicio do build: <buildStartedAt>` e `Fim do build: <buildFinishedAt>`
       - Uma linha por `TASK-*` com status final e observacao curta
       - Uma linha de QA com status, ciclos executados e observacao
       - Validacoes executadas e observacoes gerais
    c. Chame `jira_record_sdd_event` no pai com `eventType: BUILD_COMPLETED`, `targetStatus: done`, o resumo montado em `summary` e as validacoes em `validations`. Nao inclua o campo `report`; o resumo em texto e suficiente.
    d. Em `BUILD_BLOCKED`, nao monte o resumo completo de build; registre apenas o evento com blockers.

<!-- sdd:partial fail-fast -->

Nenhuma fase avanca sem comentario/transicao confirmados.

Nao altere escopo aprovado durante o build. Ao final, informe tarefas executadas, arquivos, comandos, evidencias, estados Jira, pendencias, worktrees removidos, `buildStartedAt` e `buildFinishedAt`.
<!-- sdd:section command.sdd-build:end -->
