# Padrão de desenvolvimento React

<!-- sdd:section react.principles:start -->
## Princípios

- Organize jornadas e domínios em módulos independentes.
- Use o fluxo `View -> Controller Hook -> Repository -> Model`.
- Views renderizam UI e encaminham eventos.
- Controller Hooks mantêm estado, validações e ações do fluxo.
- Repositories escondem API, storage e fontes externas.
- Models representam dados e conceitos de domínio.
- Preserve o framework e o router detectados, como Next.js ou Vite.
- Não introduza stores ou bibliotecas de estado sem necessidade e aprovação.
<!-- sdd:section react.principles:end -->

<!-- sdd:section react.layout:start -->
## Estrutura de diretórios

```text
src/
  app/
    providers/
    routes/
    app.tsx
  core/
    config/
    errors/
    http/
    storage/
  shared/
    components/
    hooks/
    models/
    repositories/
    utils/
  modules/
    <module>/
      <flow>/
        hooks/
          controller/
            use<Flow>Controller.ts
        models/
          <flow>.model.ts
        repository/
          <flow>.repository.ts
        view/
          components/
          <Flow>.view.tsx
          <flow>.module.css
```

Um módulo representa um domínio ou uma jornada, como `onboarding`, `auth`,
`students` ou `billing`. Um flow representa uma capacidade concreta dentro do
módulo, como `cpf`, `login`, `list` ou `checkout`.

Respeite a estrutura equivalente já existente. Não mova código apenas para
forçar esta árvore; use-a em módulos novos e em reorganizações aprovadas.
<!-- sdd:section react.layout:end -->

<!-- sdd:section react.responsibilities:start -->
## Responsabilidades

### `src/app`

Contém a composição da aplicação: providers globais, router, layouts raiz,
tratamento global de erros e bootstrap. Não contém regras específicas de um
módulo.

### `src/core`

Infraestrutura sem dependência de UI: cliente HTTP, configuração, storage,
telemetria e erros base. Código de `core` não importa arquivos de `modules`.

### `src/shared`

Código reutilizado por módulos distintos. Promova algo para `shared` somente
quando houver reuso real; componentes e hooks específicos permanecem no flow.

### `models`

Models são tipos e objetos de domínio. Podem validar construção, normalizar
dados e representar estados discriminados, mas não usam Hooks, não acessam DOM,
router ou Context e não executam requests.

### `repository`

Repositories expõem operações orientadas ao domínio e escondem HTTP, storage e
formato externo. Convertem respostas em Models e normalizam erros. Não mantêm
estado React, não renderizam UI e não navegam.

### `hooks/controller`

Controller Hooks coordenam o flow: estado, validações, chamadas ao repository e
handlers entregues à View. Devem começar com `use`, chamar Hooks apenas no topo
e retornar uma interface pequena orientada à UI.

### `view`

Views renderizam o estado recebido do Controller Hook. Podem manter estado
estritamente visual e local, mas não fazem requests nem conhecem detalhes de
payload, endpoint ou storage.
<!-- sdd:section react.responsibilities:end -->

<!-- sdd:section react.controller:start -->
## Controller Hooks

Crie um Controller Hook quando a View precisar coordenar validação, loading,
erro, chamadas assíncronas ou mais de uma ação relacionada. Não extraia um Hook
que apenas renomeia `useState` sem encapsular uma responsabilidade concreta.

```ts
// modules/onboarding/cpf/models/cpf.model.ts
export type CpfStatus = "idle" | "submitting" | "success" | "error";

export interface CpfResult {
  cpf: string;
  isEligible: boolean;
}

export function isCpfResult(value: unknown): value is CpfResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.cpf === "string" &&
    typeof result.isEligible === "boolean"
  );
}
```

```ts
// modules/onboarding/cpf/repository/cpf.repository.ts
import {
  isCpfResult,
  type CpfResult,
} from "../models/cpf.model";

export interface CpfRepository {
  validate(cpf: string): Promise<CpfResult>;
}

export function createCpfRepository(): CpfRepository {
  return {
    async validate(cpf) {
      const response = await fetch("/api/onboarding/cpf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cpf }),
      });

      if (!response.ok) {
        throw new Error("Não foi possível validar o CPF.");
      }

      const payload: unknown = await response.json();
      if (!isCpfResult(payload)) {
        throw new Error("Resposta inválida ao validar o CPF.");
      }

      return payload;
    },
  };
}
```

```ts
// modules/onboarding/cpf/hooks/controller/useCpfController.ts
import { useState } from "react";

import type { CpfStatus } from "../../models/cpf.model";
import type { CpfRepository } from "../../repository/cpf.repository";

export function useCpfController(repository: CpfRepository) {
  const [cpf, setCpf] = useState("");
  const [status, setStatus] = useState<CpfStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function submit() {
    setStatus("submitting");
    setErrorMessage(null);

    try {
      await repository.validate(cpf);
      setStatus("success");
    } catch (error) {
      setStatus("error");
      setErrorMessage(
        error instanceof Error ? error.message : "Erro inesperado.",
      );
    }
  }

  return {
    cpf,
    setCpf,
    submit,
    isSubmitting: status === "submitting",
    errorMessage,
  };
}
```

```tsx
// modules/onboarding/cpf/view/Cpf.view.tsx
import { createCpfRepository } from "../repository/cpf.repository";
import { useCpfController } from "../hooks/controller/useCpfController";

const cpfRepository = createCpfRepository();

export function CpfView() {
  const controller = useCpfController(cpfRepository);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void controller.submit();
      }}
    >
      <input
        value={controller.cpf}
        onChange={(event) => controller.setCpf(event.target.value)}
      />
      <button disabled={controller.isSubmitting} type="submit">
        Continuar
      </button>
      {controller.errorMessage && <p role="alert">{controller.errorMessage}</p>}
    </form>
  );
}
```

O Hook compartilha lógica, não uma instância de estado. Cada chamada a
`useCpfController` cria um estado independente. Para estado realmente global,
use um Provider explícito no limite da aplicação.

No Next App Router, adicione `"use client"` no menor limite que renderiza a View
ou executa o Controller Hook. Pages e layouts de servidor apenas importam esse
limite; não mova o flow inteiro para Client Components sem necessidade.
<!-- sdd:section react.controller:end -->

<!-- sdd:section react.state:start -->
## Estado e sessão

- Estado visual local permanece na View.
- Estado do flow permanece no Controller Hook.
- Dados persistidos ou remotos passam pelo Repository.
- Estado global deve ser raro e ter ownership explícito em `src/app/providers`.
- Use Context com `useReducer` para sessão ou estado transversal pequeno.
- Não use Context como substituto genérico para todo estado da aplicação.
- Respeite a biblioteca de estado ou server state já adotada pelo projeto.

Uma sessão global deve ter uma única fonte de verdade. O Provider restaura a
sessão, expõe usuário e permissões e oferece ações como `signIn` e `signOut`.
Módulos consomem `useSession()`; não criam outra instância de sessão.

Modele estados assíncronos explicitamente, como `idle`, `loading`, `success`,
`empty` e `error`. Não mantenha em state valores que podem ser derivados durante
render.
<!-- sdd:section react.state:end -->

<!-- sdd:section react.rules:start -->
## Components, Hooks e Effects

- Components e Hooks devem ser puros e idempotentes durante render.
- Props e state são snapshots imutáveis; nunca os altere diretamente.
- Hooks são chamados apenas no topo de Components ou outros Hooks.
- Side effects ficam em handlers ou Effects, nunca durante render.
- Use Effects somente para sincronizar com sistemas externos.
- Não use Effect para calcular dados derivados ou reagir a um clique que pode
  ser tratado diretamente no handler.
- Não aplique `memo`, `useMemo` ou `useCallback` sem necessidade medida.
- Divida Views por responsabilidade e coesão, não por quantidade de linhas.

Fontes: [Rules of React](https://react.dev/reference/rules),
[Custom Hooks](https://react.dev/learn/reusing-logic-with-custom-hooks) e
[You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect).
<!-- sdd:section react.rules:end -->

<!-- sdd:section react.naming:start -->
## Nomenclatura

- Views: `*.view.tsx`
- Controller Hooks: `use*Controller.ts`
- Models: `*.model.ts`
- Repositories: `*.repository.ts`
- Components locais: `*.component.tsx` ou convenção equivalente existente
- Styles locais: `*.module.css`, `*.module.scss` ou padrão já adotado
- Tests: `*.spec.ts`/`*.spec.tsx` na mesma pasta do arquivo testado, espelhando
  o nome, como `Cpf.view.tsx` -> `Cpf.view.spec.tsx` e
  `useCpfController.ts` -> `useCpfController.spec.ts`. Não use uma pasta de
  testes separada.
<!-- sdd:section react.naming:end -->

<!-- sdd:section react.new-flow:start -->
## Novo flow

1. Crie o flow em `src/modules/<module>/<flow>/`.
2. Defina Models e estados discriminados em `models/`.
3. Implemente o contrato de acesso a dados em `repository/`.
4. Crie `use<Flow>Controller` em `hooks/controller/`.
5. Crie a View e seus componentes locais em `view/`.
6. Conecte a View ao router sem mover lógica do flow para a rota.
7. Promova código para `shared/` somente após reuso entre módulos.
8. Cubra Controller Hook, Repository e comportamento observável da View.
<!-- sdd:section react.new-flow:end -->

<!-- sdd:section react.quality:start -->
## TypeScript, UX e qualidade

- Use TypeScript e evite `any`.
- Valide dados externos antes de tratá-los como Models confiáveis.
- Todo fluxo interativo deve funcionar por teclado e expor semântica acessível.
- Teste comportamento observável, não detalhes internos de implementação.
- Teste Controller Hooks com suas transições e falhas relevantes.
- Teste Repositories com respostas válidas, erros HTTP e payload inválido.
- Rode lint, typecheck, testes e build definidos no `package.json`.
<!-- sdd:section react.quality:end -->

<!-- sdd:section react.agent:start -->
## Regras para agentes

- Leia este padrão antes de criar arquivos React.
- Preserve framework, router, styling e ferramentas já adotados.
- Não crie stores globais para estado pertencente a um flow.
- Não faça requests diretamente em Views ou Components.
- Não coloque JSX em Controller Hooks, Models ou Repositories.
- Não crie abstrações em `shared/` antes de existir reuso real.
- Reutilize o design system e os componentes corporativos existentes.
<!-- sdd:section react.agent:end -->
