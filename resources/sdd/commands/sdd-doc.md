---
description: Documentar um ou mais projetos no Confluence do site vinculado, criando ou atualizando paginas.
argument-hint: <projetos e instrucoes de documentacao>
allowed-tools: Read, Glob, Grep, Bash, Write, Edit, Agent, mcp__cloud-mcp__jira_get_workspace_binding, mcp__cloud-mcp__jira_list_profiles, mcp__cloud-mcp__jira_bind_workspace, mcp__cloud-mcp__confluence_list_spaces, mcp__cloud-mcp__confluence_find_page, mcp__cloud-mcp__confluence_get_page, mcp__cloud-mcp__confluence_create_page, mcp__cloud-mcp__confluence_update_page, jira_get_workspace_binding, jira_list_profiles, jira_bind_workspace, confluence_list_spaces, confluence_find_page, confluence_get_page, confluence_create_page, confluence_update_page
---

<!-- sdd:section command.sdd-doc:start -->
Voce esta executando `/sdd-doc` para documentar projetos no Confluence. Entrada: `$ARGUMENTS`.

Este comando e desacoplado de `/sdd-task`, `/sdd-plan` e `/sdd-build`: nao cria issues, subtarefas, specs, branches nem registra eventos SDD. Ele apenas le o repositorio e grava documentacao no Confluence do mesmo site Atlassian do perfil vinculado.

<!-- sdd:partial untrusted-content -->

<!-- sdd:partial multi-project -->

<!-- sdd:partial doc-structure -->

Regras obrigatorias:

1. Execute o `JIRA_GATE`: identifique o `workspacePath` e chame `jira_get_workspace_binding`. O binding resolve o perfil e, portanto, o site Confluence (`${baseUrl}/wiki`). Sem vinculo, liste perfis com `jira_list_profiles`, pergunte qual perfil usar, vincule com `jira_bind_workspace` e valide de novo. Sem contexto valido, encerre.
2. Execute o `MULTI_GATE` do bloco multi-projeto para descobrir quais workspaces vinculados participam. Com 2+ vinculados, confirme com o usuario a lista final de projetos e a ordem. Com 1, siga em modo single.
3. Confirme com o usuario o nome do produto (titulo da pagina-HUB) e o space Confluence de destino. Chame `confluence_list_spaces` para listar as opcoes; aceite tambem uma chave informada diretamente (spaces pessoais tem chave `~<accountId>`).
4. AVISO DE SEGREDOS: esta doc grava senhas e chaves em texto claro. Antes de escrever, confirme explicitamente com o usuario que o space escolhido e restrito. Se ele recusar ou o space for aberto, nao grave a secao de segredos.
5. Interprete pela frase do usuario se a intencao e criar ou atualizar, mas SEMPRE valide contra o Confluence antes de gravar: chame `confluence_find_page(spaceKey, title)` para o HUB e para cada pagina filha. Pagina existente -> atualizar (preservando o que ainda vale e atualizando as secoes); ausente -> criar. Nunca crie cega quando ja existe pagina de mesmo titulo no space.
6. Trate o HUB primeiro: localize ou crie a pagina-HUB e capture seu `pageId`, pois ele e o `parentId` das filhas. Monte o HUB conforme o padrao (secao "Pagina-HUB").
7. Para cada projeto, na ordem definida, delegue exatamente `subagent_type: "sdd-doc-writer"`, passando: `workspacePath` do projeto, `spaceKey`, `parentId` (o `pageId` do HUB), o titulo da pagina filha, a decisao criar/atualizar ja validada e se a secao de segredos foi autorizada. Nunca use `code`, `developer` ou agente generico. Nao use `run_in_background`.
8. Depois que todas as filhas existirem, atualize no HUB a tabela "Projetos do produto", a secao "Ambientes" consolidada e o "Indice" com os links das filhas (use `confluence_update_page` no HUB).
9. Ao final, liste por pagina: titulo, acao (criada/atualizada), URL e projeto correspondente. Relate qualquer projeto pulado e o motivo.

Protocolo de erro: em falha transitoria (timeout, rede, `429`, `5xx`) repita uma vez a mesma chamada. Em falha definitiva (tool MCP ausente, permissao, input invalido, space nao encontrado), pare e reporte sem gravar paginas parciais. Nunca invente conteudo como fallback.
<!-- sdd:section command.sdd-doc:end -->
