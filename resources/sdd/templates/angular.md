# Padrão de desenvolvimento Angular

<!-- sdd:section angular.principles:start -->
## Princípios

- Organize jornadas e domínios em módulos independentes.
- Use o fluxo `View -> Controller Service -> Repository -> Model`.
- Views (Components) renderizam UI e encaminham eventos.
- Controller Services mantêm estado, validações e ações do fluxo.
- Repositories escondem HTTP, storage e fontes externas.
- Models representam dados e conceitos de domínio.
- Prefira Standalone Components, `inject()` e Signals no código novo.
- Preserve o framework, o router e as ferramentas detectados no projeto.
- Não introduza bibliotecas de estado sem necessidade e aprovação.
<!-- sdd:section angular.principles:end -->

<!-- sdd:section angular.layout:start -->
## Estrutura de diretórios

```text
src/
  app/
    core/
      config/
      errors/
      http/
      storage/
    shared/
      components/
      models/
      repositories/
      utils/
    modules/
      <module>/
        <flow>/
          controllers/
            <flow>.controller.ts
          models/
            <flow>.model.ts
          repository/
            <flow>.repository.ts
          view/
            components/
            <flow>.component.ts
            <flow>.component.html
            <flow>.component.scss
            <flow>.component.spec.ts
    app.config.ts
    app.routes.ts
    app.component.ts
```

Um módulo representa um domínio ou uma jornada, como `onboarding`, `auth`,
`students` ou `billing`. Um flow representa uma capacidade concreta dentro do
módulo, como `cpf`, `login`, `list` ou `checkout`.

Respeite a estrutura equivalente já existente. Não mova código apenas para
forçar esta árvore; use-a em módulos novos e em reorganizações aprovadas.
<!-- sdd:section angular.layout:end -->

<!-- sdd:section angular.responsibilities:start -->
## Responsabilidades

### `src/app/core`

Infraestrutura sem dependência de UI: cliente HTTP, interceptors, configuração,
storage, telemetria e erros base. Código de `core` não importa arquivos de
`modules`.

### `src/app/shared`

Código reutilizado por módulos distintos. Promova algo para `shared` somente
quando houver reuso real; components e services específicos permanecem no flow.

### `models`

Models são tipos e objetos de domínio. Podem validar construção, normalizar
dados e representar estados discriminados, mas não usam `HttpClient`, não
acessam DOM ou router e não executam requests.

### `repository`

Repositories expõem operações orientadas ao domínio e escondem HTTP, storage e
formato externo. Convertem respostas em Models e normalizam erros. Não mantêm
estado de UI, não renderizam template e não navegam.

### `controllers`

Controller Services coordenam o flow: estado, validações, chamadas ao repository
e ações entregues à View. São `@Injectable` providos no limite do Component,
expõem estado via Signals e retornam uma interface pequena orientada à UI.

### `view`

Views são Components que renderizam o estado recebido do Controller Service.
Podem manter estado estritamente visual e local, mas não fazem requests nem
conhecem detalhes de payload, endpoint ou storage.
<!-- sdd:section angular.responsibilities:end -->

<!-- sdd:section angular.controller:start -->
## Controller Services

Crie um Controller Service quando a View precisar coordenar validação, loading,
erro, chamadas assíncronas ou mais de uma ação relacionada. Proveja o Controller
no próprio Component (`providers: [CpfController]`) para que cada instância do
Component tenha seu próprio estado.

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
import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";

import { isCpfResult, type CpfResult } from "../models/cpf.model";

@Injectable({ providedIn: "root" })
export class CpfRepository {
  private readonly http = inject(HttpClient);

  async validate(cpf: string): Promise<CpfResult> {
    const payload = await firstValueFrom(
      this.http.post<unknown>("/api/onboarding/cpf", { cpf }),
    );

    if (!isCpfResult(payload)) {
      throw new Error("Resposta inválida ao validar o CPF.");
    }

    return payload;
  }
}
```

```ts
// modules/onboarding/cpf/controllers/cpf.controller.ts
import { Injectable, computed, inject, signal } from "@angular/core";

import type { CpfStatus } from "../models/cpf.model";
import { CpfRepository } from "../repository/cpf.repository";

@Injectable()
export class CpfController {
  private readonly repository = inject(CpfRepository);

  readonly cpf = signal("");
  private readonly status = signal<CpfStatus>("idle");
  readonly errorMessage = signal<string | null>(null);
  readonly isSubmitting = computed(() => this.status() === "submitting");

  async submit(): Promise<void> {
    this.status.set("submitting");
    this.errorMessage.set(null);

    try {
      await this.repository.validate(this.cpf());
      this.status.set("success");
    } catch (error) {
      this.status.set("error");
      this.errorMessage.set(
        error instanceof Error ? error.message : "Erro inesperado.",
      );
    }
  }
}
```

```ts
// modules/onboarding/cpf/view/cpf.component.ts
import { Component } from "@angular/core";
import { FormsModule } from "@angular/forms";

import { CpfController } from "../controllers/cpf.controller";
import { CpfRepository } from "../repository/cpf.repository";

@Component({
  selector: "app-cpf",
  standalone: true,
  imports: [FormsModule],
  providers: [CpfController, CpfRepository],
  templateUrl: "./cpf.component.html",
})
export class CpfComponent {
  constructor(readonly controller: CpfController) {}
}
```

```html
<!-- modules/onboarding/cpf/view/cpf.component.html -->
<form (ngSubmit)="controller.submit()">
  <input name="cpf" [ngModel]="controller.cpf()" (ngModelChange)="controller.cpf.set($event)" />
  <button type="submit" [disabled]="controller.isSubmitting()">Continuar</button>
  @if (controller.errorMessage(); as message) {
    <p role="alert">{{ message }}</p>
  }
</form>
```

O Controller expõe estado reativo via Signals; a View apenas lê Signals e
encaminha eventos. Prover o Controller no Component garante uma instância por
uso; para estado realmente global, use um service `providedIn: "root"` no limite
da aplicação.
<!-- sdd:section angular.controller:end -->

<!-- sdd:section angular.state:start -->
## Estado e sessão

- Estado visual local permanece na View.
- Estado do flow permanece no Controller Service via Signals.
- Dados persistidos ou remotos passam pelo Repository.
- Estado global deve ser raro e ter ownership explícito em um service `root`.
- Prefira Signals a `BehaviorSubject` para estado síncrono de UI.
- Respeite a biblioteca de estado ou server state já adotada pelo projeto.

Uma sessão global deve ter uma única fonte de verdade. Um `SessionService`
`providedIn: "root"` restaura a sessão, expõe usuário e permissões via Signals e
oferece ações como `signIn` e `signOut`. Módulos injetam esse service; não criam
outra instância de sessão.

Modele estados assíncronos explicitamente, como `idle`, `loading`, `success`,
`empty` e `error`. Não mantenha em Signal valores que podem ser derivados com
`computed`.
<!-- sdd:section angular.state:end -->

<!-- sdd:section angular.rules:start -->
## Components, Services e Change Detection

- Prefira Standalone Components e `inject()` a NgModules e injeção por construtor
  extensa no código novo.
- Adote `ChangeDetectionStrategy.OnPush` em Components novos.
- Use Signals e `computed` para estado derivado; evite lógica pesada no template.
- Faça unsubscribe de streams com `takeUntilDestroyed` ou o pipe `async`.
- Não faça requests diretamente em Components; use o Repository.
- Não coloque template ou dependência de UI em Controllers, Models ou
  Repositories.
- Divida Components por responsabilidade e coesão, não por quantidade de linhas.

Fontes: [Angular Signals](https://angular.dev/guide/signals),
[Standalone Components](https://angular.dev/guide/components/importing) e
[Dependency Injection](https://angular.dev/guide/di).
<!-- sdd:section angular.rules:end -->

<!-- sdd:section angular.naming:start -->
## Nomenclatura

- Components (View): `*.component.ts`
- Controller Services: `*.controller.ts`
- Models: `*.model.ts`
- Repositories: `*.repository.ts`
- Services globais: `*.service.ts`
- Templates e styles: `*.component.html`, `*.component.scss` ou padrão existente
- Tests: `*.spec.ts` na mesma pasta do arquivo testado, espelhando o nome, como
  `cpf.component.ts` -> `cpf.component.spec.ts` e
  `cpf.controller.ts` -> `cpf.controller.spec.ts`. Não use uma pasta de testes
  separada.
<!-- sdd:section angular.naming:end -->

<!-- sdd:section angular.new-flow:start -->
## Novo flow

1. Crie o flow em `src/app/modules/<module>/<flow>/`.
2. Defina Models e estados discriminados em `models/`.
3. Implemente o contrato de acesso a dados em `repository/`.
4. Crie o `<Flow>Controller` em `controllers/`.
5. Crie o Component da View e seus componentes locais em `view/`.
6. Proveja Controller e Repository no Component e conecte a rota sem mover lógica
   do flow para o arquivo de rotas.
7. Promova código para `shared/` somente após reuso entre módulos.
8. Cubra Controller, Repository e comportamento observável do Component com
   arquivos `*.spec.ts` na mesma pasta de cada arquivo testado.
<!-- sdd:section angular.new-flow:end -->

<!-- sdd:section angular.quality:start -->
## TypeScript, UX e qualidade

- Use TypeScript em modo estrito e evite `any`.
- Valide dados externos antes de tratá-los como Models confiáveis.
- Todo fluxo interativo deve funcionar por teclado e expor semântica acessível.
- Teste comportamento observável, não detalhes internos de implementação.
- Teste Controllers com suas transições e falhas relevantes.
- Teste Repositories com respostas válidas, erros HTTP e payload inválido.
- Rode lint, typecheck, testes e build definidos no `package.json`.
<!-- sdd:section angular.quality:end -->

<!-- sdd:section angular.agent:start -->
## Regras para agentes

- Leia este padrão antes de criar arquivos Angular.
- Preserve framework, router, styling e ferramentas já adotados.
- Não crie services globais para estado pertencente a um flow.
- Não faça requests diretamente em Components.
- Não coloque template ou lógica de UI em Controllers, Models ou Repositories.
- Não crie abstrações em `shared/` antes de existir reuso real.
- Reutilize o design system e os componentes corporativos existentes.
<!-- sdd:section angular.agent:end -->
