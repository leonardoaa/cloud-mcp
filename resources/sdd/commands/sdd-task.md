---
description: Refinar e criar uma Task no Jira conectado ao projeto.
argument-hint: <pedido da tarefa>
allowed-tools: Read, Glob, Grep, mcp__cloud-mcp__jira_get_workspace_binding, mcp__cloud-mcp__jira_list_profiles, mcp__cloud-mcp__jira_bind_workspace, mcp__cloud-mcp__jira_create_task, mcp__cloud-mcp__jira_link_issues, jira_get_workspace_binding, jira_list_profiles, jira_bind_workspace, jira_create_task, jira_link_issues
---

<!-- sdd:section command.sdd-task:start -->
Voce esta executando o comando `/sdd-task`.

Objetivo: transformar o pedido do usuario em uma Task Jira clara, verificavel e pronta para planejamento usando as tools Jira do MCP.

Entrada do usuario:

$ARGUMENTS

<!-- sdd:partial multi-project -->

Fluxo obrigatorio:

1. Execute o `JIRA_GATE`: identifique o `workspacePath` e chame `jira_get_workspace_binding` antes de analisar o pedido ou escrever qualquer arquivo. Em seguida execute o `MULTI_GATE`.
2. Se nao houver vinculo, liste os perfis com `jira_list_profiles`, pergunte qual perfil e projeto usar e chame `jira_bind_workspace`. Nao escolha um Jira por conta propria.
3. Chame `jira_get_workspace_binding` novamente. Prossiga somente depois de receber perfil habilitado, projeto e `customFieldMap`. Se a vinculacao falhar ou for recusada, encerre sem criar rascunho local ou issue.
4. Leia `docs/constitution.md` e os templates obrigatorios. Use exclusivamente o contexto Jira validado para este workspace.
5. Inspecione apenas o contexto necessario do projeto para identificar stack, componentes afetados, restricoes, integracoes e comandos de validacao.
6. Separe fatos fornecidos de inferencias. Nunca invente regra de negocio, prazo, comportamento ou decisao de produto.
7. Prepare um titulo objetivo, ator/problema/resultado, escopo e de dois a cinco criterios de aceite observaveis em Dado/Quando/Entao. Antecipe regras, permissoes, erros, dados e integracoes relevantes para reduzir bloqueios no `/sdd-plan`.
8. Verifique e apresente possiveis problemas: ambiguidades, regras ausentes, cenarios de erro, permissoes, seguranca, dados, integracoes, observabilidade, migracao e impacto em compatibilidade.
9. Registre perguntas e decisoes pendentes na descricao em `Faltou discutir com a equipe`. Campos sem resposta nao devem ser preenchidos com fatos inventados.
10. Para campos personalizados, consulte `jiraProfile.customFieldMap` do contexto retornado. Passe em `fields` apenas nomes logicos existentes nesse mapa; o MCP converte esses nomes para os IDs `customfield_*` do Jira conectado. Use o argumento dedicado `acceptanceCriteria` quando esse alias estiver configurado.
11. Mostre ao usuario o payload final resumido e solicite confirmacao explicita antes de qualquer escrita no Jira.
12. Somente apos a confirmacao, chame `jira_create_task` com `workspacePath`, `summary`, `description`, `acceptanceCriteria` e `fields` aplicaveis ao perfil conectado.
13. Ao final, informe chave Jira, campos preenchidos, campos nao configurados, pendencias registradas e sugira `/sdd-plan <ISSUE-KEY>`.

MODO MULTI (somente quando o `MULTI_GATE` confirmou dois ou mais projetos e o usuario aprovou distribuir a feature):

M1. Defina um `groupId` no formato `grp-<YYYYMMDD>-<slug-curto>` derivado do pedido.
M2. Para cada membro aprovado, refine uma task com escopo proprio daquele projeto: reaproveite os passos 4 a 10 usando o `workspacePath` e o contexto Jira daquele membro. Backend concentra API, dados e regras; frontend concentra UI e integracao; bibliotecas concentram componentes reutilizaveis. Nunca duplique o mesmo escopo em projetos diferentes.
M3. Mostre um unico payload consolidado com todas as tasks propostas (uma por projeto) e solicite UMA confirmacao explicita para o conjunto.
M4. Somente apos a confirmacao, crie as tasks na ordem definida chamando `jira_create_task` por membro, cada uma com seu `workspacePath` e incluindo `fields.labels` com o valor `sdd-group:<groupId>`. Colete as chaves retornadas.
M5. Depois que TODAS as chaves foram confirmadas, crie os links nativos entre as tasks do grupo: para cada par distinto, chame `jira_link_issues` com o `workspacePath` da issue de origem, `issueKey` da origem e `targetIssueKey` do par, usando `linkType: "Relates"`. Basta um link por par (o Jira registra os dois sentidos). Falha de link nao apaga tasks ja criadas: relate o par que ficou sem link e siga.
M6. Depois dos links, grave o `group.json` identico em `docs/sdd/specs/<ISSUE-KEY>/group.json` de cada membro, conforme o esquema do bloco multi-projeto. Nao grave nenhum `group.json` antes de ter todas as chaves.
M7. Ao final, liste as chaves criadas por projeto, o `groupId`, os labels aplicados, os links criados e sugira `/sdd-plan <qualquer-chave-do-grupo>`. Qualquer falha de criacao de task interrompe o conjunto: relate o que ja foi criado, nao grave `group.json` parcial e nao invente vinculos.

Nao crie subtarefas, nao altere status e nao inicie implementacao neste comando.
<!-- sdd:section command.sdd-task:end -->
