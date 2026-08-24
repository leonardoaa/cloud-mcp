Fluxo multi-projeto (opcional, ativado apenas com dois ou mais workspaces vinculados). Enquanto houver um unico workspace vinculado, este bloco nao muda nada: siga o fluxo padrao do comando sem qualquer alteracao.

Vocabulario:

- Grupo: uma mesma feature que atravessa dois ou mais projetos (por exemplo backend, frontend e uma biblioteca de componentes). Cada projeto participante vira UMA Task Jira top-level propria. Subtarefa exige o mesmo projeto do pai, portanto o grupo usa tasks separadas, linkadas nativamente no Jira via `jira_link_issues` (`Relates`) e unidas pelo label compartilhado, nunca subtarefas entre projetos.
- `groupId`: identificador estavel do grupo no formato `grp-<YYYYMMDD>-<slug-curto>`. O mesmo valor aparece no label `sdd-group:<groupId>` de todas as tasks e no `group.json` de cada membro.
- Membro: um par `{ projeto Jira, workspace }` que participa do grupo, com um `role` curto e humano (`backend`, `frontend`, `components`).

MULTI_GATE (deteccao — execute depois do `JIRA_GATE` e antes de agir):

1. Liste os workspaces abertos na sessao (os roots do cliente). Para cada um, chame `jira_get_workspace_binding` com o `workspacePath` absoluto.
2. Conte os workspaces com vinculo Jira habilitado (perfil + projeto validos).
   - 0 ou 1 vinculado: MODO SINGLE. Ignore todo o restante deste bloco e siga o fluxo padrao do comando, sem alteracao.
   - 2 ou mais vinculados: MODO MULTI candidato. Nao ative automaticamente. Apresente os projetos detectados e pergunte se esta feature deve ser distribuida entre eles. Sem confirmacao explicita, permaneca em MODO SINGLE usando o workspace escolhido pelo usuario.
3. Em MODO MULTI, confirme com o usuario a lista final de membros (default: todos os vinculados) e a `order` entre eles. A ordem e sequencial e reflete dependencia: tipicamente o projeto que define o contrato/API vem antes dos consumidores.

`group.json` (um por spec, gravado em `docs/sdd/specs/<ISSUE-KEY>/group.json` de cada membro):

```json
{
  "groupId": "grp-20260819-checkout",
  "createdAt": "<ISO-8601 com timezone>",
  "order": ["BACK-12", "FRONT-8"],
  "members": [
    { "project": "BACK", "issueKey": "BACK-12", "workspacePath": "/abs/backend", "role": "backend" },
    { "project": "FRONT", "issueKey": "FRONT-8", "workspacePath": "/abs/frontend", "role": "frontend" }
  ]
}
```

Regras do manifesto:

- Todos os membros compartilham exatamente o mesmo `groupId`, o mesmo array `order` e a mesma lista `members`; apenas o arquivo vive dentro de cada workspace.
- `order` lista as issueKeys na ordem de execucao. `members` descreve cada par projeto/workspace com `project`, `issueKey`, `workspacePath` absoluto e `role`.
- Grave o `group.json` de todos os membros somente depois que TODAS as tasks do grupo foram criadas e suas chaves confirmadas.

Descoberta de peers (execute quando o comando recebe uma issueKey):

1. Procure `docs/sdd/specs/<ISSUE-KEY>/group.json` no workspace atual.
2. Sem arquivo, ou arquivo sem a issueKey recebida em `members`: a issue NAO pertence a nenhum grupo. Siga o fluxo single padrao, sem alteracao.
3. Com arquivo valido: confirme que cada membro em `members` ainda e alcancavel — o workspace existe e `jira_get_issue` retorna a issue no projeto esperado. Membro inacessivel bloqueia o modo multi; relate e pare antes de agir.

FANOUT (execucao de fase em MODO MULTI):

- Itere `order` de forma sequencial. Para cada issueKey, execute o fluxo single COMPLETO deste comando dentro do workspace do membro correspondente: seu proprio binding, seu proprio `docs/sdd/specs/<KEY>/`, seus proprios agentes. Um membro so inicia depois que o anterior concluiu com sucesso.
- Cada membro e uma execucao single independente e idempotente: retomar o grupo nao repete membros ja concluidos.
- Falha ou bloqueio em um membro interrompe o grupo imediatamente, preservando os membros ja concluidos. Relate qual membro bloqueou e o motivo e nao inicie os membros seguintes.
- Ao final, consolide um resumo com uma linha por membro: issueKey, projeto, status final e observacao curta.
