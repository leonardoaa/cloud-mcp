# Padrão de desenvolvimento Node.js + TypeScript

<!-- sdd:section node.architecture:start -->
## Arquitetura

- Preserve o framework e a estrutura existentes.
- Routes/controllers validam entrada, invocam use cases/services e traduzem a
  resposta HTTP; não concentram regra de negócio.
- Services/use cases implementam regras e dependem de interfaces explícitas.
- Repositories encapsulam banco, cache e fontes externas.
- Clients encapsulam APIs externas, timeouts, retries e autenticação.
- Novos domínios devem manter controller, schemas, service e repository próximos
  quando o projeto já usa módulos por domínio.
<!-- sdd:section node.architecture:end -->

<!-- sdd:section node.types:start -->
## TypeScript e contratos

- Habilite `strict` em projetos novos e evite ampliar dívida em projetos legados.
- Não use `any` em fronteiras; valide env, request, eventos e respostas externas.
- Diferencie DTOs, entidades de domínio e modelos de persistência quando os
  formatos tiverem responsabilidades distintas.
- Erros esperados usam códigos/tipos estruturados; não dependa de texto para
  controle de fluxo.

Fonte: [TSConfig Reference](https://www.typescriptlang.org/tsconfig/).
<!-- sdd:section node.types:end -->

<!-- sdd:section node.runtime:start -->
## Runtime e segurança

- Defina limites de body, timeouts, tratamento de socket e encerramento gracioso.
- Propague cancellation com `AbortSignal` em I/O quando suportado.
- Não logue tokens, cookies, headers sensíveis, payloads ou PII sem allowlist.
- Use lockfile, `npm ci`, auditoria de dependências e versões LTS suportadas.
- Compare segredos com primitivas adequadas e valide autorização no servidor.

Fonte: [Node.js Security Best Practices](https://nodejs.org/en/learn/getting-started/security-best-practices).
<!-- sdd:section node.runtime:end -->

<!-- sdd:section node.api:start -->
## APIs e persistência

- Valide request antes de chamar regra de negócio.
- Respostas e erros possuem schema estável e status coerente.
- Queries são parametrizadas; migrations são versionadas e reversíveis quando
  possível.
- Operações externas têm timeout; retry só ocorre quando seguro e idempotente.
- Não exponha stack trace ou detalhes internos ao consumidor.
<!-- sdd:section node.api:end -->

<!-- sdd:section node.quality:start -->
## Qualidade

- Teste regra de negócio isoladamente e contratos HTTP com integração.
- Coloque os testes `*.spec.ts` na mesma pasta do arquivo testado, espelhando o
  nome, como `cpf.service.ts` -> `cpf.service.spec.ts`. Não use uma pasta de
  testes separada.
- Bugs recebem teste de regressão.
- Rode typecheck, testes, build e auditoria já definidos no projeto.
- Não misture refactors amplos a mudanças funcionais sem necessidade.
<!-- sdd:section node.quality:end -->
