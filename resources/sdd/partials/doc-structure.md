Padrao de documentacao (fonte unica de estrutura). Toda pagina e gravada em storage-format XHTML do Confluence. Diagramas usam a macro `mermaidjs` (app de Mermaid instalado no site), que renderiza o diagrama em vez de mostrar codigo. Atencao: o corpo da macro NAO e o Mermaid cru; e um objeto JSON `{"diagramDefinition":"<mermaid>"}` (com `\n` e aspas escapados pelo JSON) dentro de CDATA. Preencha assim:

```
<ac:structured-macro ac:name="mermaidjs" ac:schema-version="1" data-layout="default" ac:local-id="<uuid-1>" ac:macro-id="<uuid-2>"><ac:parameter ac:name="fileName">mermaid_<timestamp></ac:parameter><ac:parameter ac:name="theme">default</ac:parameter><ac:parameter ac:name="version">2</ac:parameter><ac:plain-text-body><![CDATA[{"diagramDefinition":"flowchart LR\n  A[\"x\"]-->B"}]]></ac:plain-text-body></ac:structured-macro>
```

Regras da macro `mermaidjs`:
- `diagramDefinition`: o codigo Mermaid inteiro, serializado como string JSON (use um serializador JSON; nunca cole quebras de linha ou aspas cruas dentro do JSON).
- `fileName`, `ac:local-id` e `ac:macro-id`: derive de um hash (ex.: SHA-256) do proprio `theme`+diagrama, para que um diagrama inalterado gere sempre o mesmo storage (sem diffs espurios ao re-executar). Use `mermaid_<hash16>` no fileName e dois ids distintos (`<hash>|local` e `<hash>|macro`). Nao use timestamp nem UUID aleatorio.
- `theme`: `default` ou `dark`. `version`: `2`.
- Sintaxe do diagrama: em rotulos de aresta (entre `|...|`) evite `*`, parenteses e outros caracteres especiais, que quebram o parser do Mermaid (barras e dois-pontos sao aceitos); rotulos de no devem ficar entre aspas (`N["texto (ok)"]`). Prefira texto simples em arestas para evitar "Syntax error in text".
- Requer o app de Mermaid instalado no site; sem ele, o diagrama nao renderiza.

Pagina-HUB (produto). Titulo = nome do produto (ex.: "Cloud Amora"). Secoes obrigatorias:

1. Visao geral: o que e o produto, para que serve e contexto de negocio.
2. Projetos do produto: tabela com Projeto, Repositorio GitHub, Branch principal, Stack e Responsabilidade resumida.
3. Diagrama de fluxo geral (Mermaid): como os projetos se comunicam entre si e com servicos externos.
4. Ambientes: visao consolidada com URLs base de producao e homologacao por projeto, quando disponivel.
5. Indice: links para cada pagina filha.

Pagina-FILHA (um por projeto). Titulo = nome do projeto. Fica sob o HUB via `parentId`. Secoes obrigatorias:

1. O que faz: responsabilidade e papel dentro do produto.
2. Repositorio e branches: URL do GitHub e apenas as branches principais, extraidas do git local (`git remote -v`, `git branch`).
3. Onde esta armazenado / hospedado: infra, regiao e forma de deploy.
4. Ambientes (URLs), quando disponivel: tabela Ambiente x URL, com producao e homologacao, lidas de `.env`/config/deploy locais.
5. Chaves e credenciais por ambiente: tabela Chave x Homologacao x Producao, em texto claro, lidas de arquivos locais (`.env`, config). Esta secao grava segredos em texto claro; so execute em espaco Confluence restrito.
6. API / Swagger, quando disponivel: link para o spec OpenAPI/swagger do repo e/ou tabela dos endpoints principais.
7. Diagrama de fluxo do projeto (Mermaid): requisicoes e integracoes internas.
8. Diagrama do banco de dados (Mermaid `erDiagram`): tabelas e relacoes.
9. Diagrama de arquitetura/infra (Mermaid): deploy, hospedagem e servicos externos.
10. Dependencias: outros projetos do grupo que consome ou expoe.

Regras de conteudo: preencha somente com fatos observados no repositorio e nos arquivos locais. Nunca invente segredos, URLs, endpoints ou regras de negocio; quando uma secao nao tiver fonte, registre "Nao identificado" em vez de inventar.
