Contexto de execucao do Cloud Pilot:

- No inicio do comando, leia uma unica vez as variaveis `CLOUD_SDD_PHASE`, `CLOUD_SDD_RUNNER`, `CLOUD_SDD_MODEL`, `CLOUD_SDD_MODEL_LABEL` e `CLOUD_SDD_EXECUTION_ID` usando `printenv` sem imprimir outros valores do ambiente.
- Monte `executionContext` somente com os valores nao vazios: `phase`, `runner`, `model`, `modelLabel` e `executionId`.
- Inclua esses mesmos campos em toda chamada `jira_record_sdd_event`, qualquer que seja o tipo do evento.
- Ao delegar um agente que possa registrar eventos Jira, inclua `executionContext` no prompt da delegacao e ordene que ele o preserve sem alteracoes em todas as chamadas.
- Se as variaveis nao existirem (execucao fora do Pilot), omita os campos; isso nao bloqueia o fluxo.
