# Padrão Datadog para Node.js

<!-- sdd:section datadog.bootstrap:start -->
## Inicialização

- Inicialize `dd-trace` antes de qualquer módulo instrumentado.
- Em TypeScript, mantenha tracer em arquivo dedicado e carregue-o primeiro.
- Em ESM moderno, use o mecanismo de `--import` compatível com a versão do Node.
- Configure `service`, `env` e `version` para Unified Service Tagging.

Fonte: [Datadog Node.js tracing](https://docs.datadoghq.com/tracing/trace_collection/automatic_instrumentation/dd_libraries/nodejs/).
<!-- sdd:section datadog.bootstrap:end -->

<!-- sdd:section datadog.telemetry:start -->
## Traces e logs

- Use auto-instrumentation para frameworks suportados e spans customizados apenas
  para operações de negócio relevantes.
- Propague trace/request ID em logs estruturados.
- Não adicione corpo de request/response, Authorization, cookies, tokens, e-mail,
  documentos ou PII em tags e logs sem allowlist e justificativa.
- Marque erros e status, mas sanitize mensagens externas.
- Finalize spans em `finally` e preserve o erro original.
<!-- sdd:section datadog.telemetry:end -->

<!-- sdd:section datadog.validation:start -->
## Validação

- Verifique que o tracer inicia antes do servidor e que traces não ficam órfãos.
- Teste com tracing desabilitado e indisponibilidade do Agent.
- Não faça a aplicação falhar apenas porque telemetria está indisponível.
<!-- sdd:section datadog.validation:end -->
