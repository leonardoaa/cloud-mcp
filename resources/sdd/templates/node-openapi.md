# Padrão OpenAPI e Swagger para Node.js

<!-- sdd:section openapi.contract:start -->
## Contrato

- A especificação OpenAPI é parte do contrato da API e muda junto com endpoints.
- Documente autenticação, parâmetros, request, respostas de sucesso e erros.
- Reutilize `components/schemas`, parameters, responses e security schemes.
- Exemplos não podem conter credenciais ou dados reais.

Fontes: [OpenAPI 3.1](https://swagger.io/specification/v3) e
[Reusable Components](https://swagger.io/docs/specification/v3_0/components/).
<!-- sdd:section openapi.contract:end -->

<!-- sdd:section openapi.classmap:start -->
## Pipeline adotado no Classmap

Quando o projeto já usar `swagger-autogen`/`swagger-jsdoc`:

- gere o artefato OpenAPI antes do build/start de produção;
- inclua rotas TypeScript em desenvolvimento e JavaScript compilado em produção;
- derive a versão do `package.json`;
- configure servers por ambiente sem fixar host de produção no código;
- declare Bearer/JWT em `securitySchemes` e aplique security onde necessário;
- sirva Swagger UI em rota explícita e mantenha tema customizado isolado da spec;
- valide que o artefato gerado acompanha a imagem/deploy.
<!-- sdd:section openapi.classmap:end -->

<!-- sdd:section openapi.quality:start -->
## Qualidade

- Falhe o CI quando a spec for inválida ou a geração falhar.
- Evite duas fontes de verdade concorrentes sem uma regra clara de composição.
- Inclua testes mínimos para carregar a spec e encontrar operações críticas.
<!-- sdd:section openapi.quality:end -->
