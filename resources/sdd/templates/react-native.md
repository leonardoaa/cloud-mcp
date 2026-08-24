# Padrão de desenvolvimento React Native

<!-- sdd:section react-native.foundation:start -->
## Fundação

Este padrão complementa `react.md`; ambos são obrigatórios. React Native usa a
mesma arquitetura modular:

```text
Screen -> Controller Hook -> Repository -> Model
```

- Screens renderizam componentes nativos e encaminham eventos.
- Controller Hooks coordenam estado e ações do flow.
- Repositories escondem API, storage e integrações externas.
- Models representam dados e conceitos de domínio.
- Preserve Expo Router, React Navigation ou o router já adotado.
- Não introduza stores ou bibliotecas de estado sem necessidade e aprovação.
<!-- sdd:section react-native.foundation:end -->

<!-- sdd:section react-native.layout:start -->
## Estrutura de diretórios

```text
src/
  app/
    providers/
    navigation/
    app.tsx
  core/
    config/
    errors/
    http/
    storage/
    platform/
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
        services/
          <flow>.service.ts
        view/
          components/
          screens/
            <Flow>.screen.tsx
          styles.ts
```

Quando Expo Router exigir arquivos em `app/`, trate-os como entradas finas de
navegação. O arquivo de rota importa e renderiza a Screen do módulo; regras,
estado e acesso a dados permanecem em `src/modules`.

Respeite a estrutura equivalente já existente. Não mova código apenas para
forçar esta árvore; use-a em módulos novos e reorganizações aprovadas.
<!-- sdd:section react-native.layout:end -->

<!-- sdd:section react-native.responsibilities:start -->
## Responsabilidades mobile

### `view/screens`

Screens compõem a UI nativa, consomem o Controller Hook e lidam com detalhes
visuais como teclado, safe area, foco e feedback tátil. Não fazem requests nem
acessam storage diretamente.

### `view/components`

Componentes específicos do flow. Promova para `src/shared/components` somente
quando houver reuso real entre módulos.

### `services`

Services do flow encapsulam APIs de dispositivo e SDKs nativos, como câmera,
localização, notificações, biometria e compartilhamento. Repositories podem
coordenar esses services com HTTP ou storage.

### `core/platform`

Adapters compartilhados de plataforma. Use interfaces estáveis para esconder
diferenças entre Expo, módulos nativos e implementações web.

### Navegação

Arquivos de rota e navigators decidem composição e transição. Parâmetros
recebidos da navegação são validados antes de entrar no Controller Hook. O
Controller retorna resultados e ações; não importa router nem executa navegação.
<!-- sdd:section react-native.responsibilities:end -->

<!-- sdd:section react-native.controller:start -->
## Screen e Controller Hook

O mesmo Controller Hook pode ser reutilizado entre React web e React Native
quando não depender de DOM, router ou APIs específicas da plataforma. A camada
visual muda; Repository e Models permanecem compartilháveis.

```tsx
// modules/onboarding/cpf/view/screens/Cpf.screen.tsx
import { useMemo } from "react";
import {
  Button,
  Text,
  TextInput,
  View,
} from "react-native";

import { useCpfController } from "../../hooks/controller/useCpfController";
import { createCpfRepository } from "../../repository/cpf.repository";
import { styles } from "../styles";

export function CpfScreen() {
  const repository = useMemo(() => createCpfRepository(), []);
  const controller = useCpfController(repository);

  return (
    <View style={styles.container}>
      <TextInput
        accessibilityLabel="CPF"
        inputMode="numeric"
        onChangeText={controller.setCpf}
        value={controller.cpf}
      />
      <Button
        disabled={controller.isSubmitting}
        onPress={() => void controller.submit()}
        title="Continuar"
      />
      {controller.errorMessage && (
        <Text accessibilityRole="alert">{controller.errorMessage}</Text>
      )}
    </View>
  );
}
```

Não use `useMemo` por reflexo. No exemplo ele mantém uma única instância do
Repository durante a vida da Screen; prefira injeção por Provider quando o
projeto já possuir um composition root para dependências.
<!-- sdd:section react-native.controller:end -->

<!-- sdd:section react-native.session:start -->
## Sessão e persistência

- A sessão possui uma única fonte de verdade em `src/app/providers`.
- O Provider restaura credenciais, usuário e permissões durante o bootstrap.
- Módulos consomem `useSession()`; não criam Providers de sessão próprios.
- Tokens e segredos ficam em storage seguro, nunca em AsyncStorage.
- AsyncStorage é permitido apenas para preferências e dados não sensíveis.
- O Repository de sessão coordena autenticação, storage seguro e limpeza no
  logout.
- Não inclua token, segredo ou dado pessoal em logs, analytics, crash reports,
  deep links ou parâmetros de navegação.

Durante a restauração, represente explicitamente `restoring`, `authenticated` e
`unauthenticated`. Não renderize brevemente a navegação autenticada antes de
concluir o bootstrap.

Fonte: [Security](https://reactnative.dev/docs/security).
<!-- sdd:section react-native.session:end -->

<!-- sdd:section react-native.platform:start -->
## Código de plataforma

Use `Platform.select` para diferenças pequenas. Quando a implementação mudar
substancialmente, use arquivos específicos:

```text
location.service.ts
location.service.native.ts
location.service.ios.ts
location.service.android.ts
location.service.web.ts
```

Mantenha a mesma interface exportada por todas as variantes. Importe sem a
extensão de plataforma e deixe Metro escolher a implementação.

Não espalhe verificações de `Platform.OS` pelas Screens. Centralize diferenças
em components, services ou adapters dedicados.

Fonte: [Platform-Specific Code](https://reactnative.dev/docs/platform-specific-code.html).
<!-- sdd:section react-native.platform:end -->

<!-- sdd:section react-native.ui:start -->
## UI, listas e desempenho

- Use componentes nativos e o design system já adotado.
- Trate safe areas, teclado, foco, orientation e dimensões de tela.
- Para listas extensas, use `FlatList` ou `SectionList`, keys estáveis e itens
  leves; não renderize coleções grandes com `ScrollView`.
- Passe dependências externas ao item por props estáveis e use `extraData`
  quando a lista depender de estado fora de `data`.
- Não aplique `memo`, `useMemo` ou `useCallback` sem necessidade medida.
- Valide desempenho em build release e em dispositivos representativos.
- Cancele subscriptions, listeners e timers no cleanup do Effect.

Fonte: [FlatList](https://reactnative.dev/docs/flatlist).
<!-- sdd:section react-native.ui:end -->

<!-- sdd:section react-native.accessibility:start -->
## Acessibilidade

- Defina `accessibilityRole`, `accessibilityLabel`, `accessibilityHint` e
  `accessibilityState` em controles customizados.
- Garanta área de toque, contraste e ordem de foco coerentes.
- Anuncie mudanças importantes de loading, erro e sucesso.
- Teste fluxos críticos com TalkBack e VoiceOver.

Fonte: [Accessibility](https://reactnative.dev/docs/accessibility).
<!-- sdd:section react-native.accessibility:end -->

<!-- sdd:section react-native.naming:start -->
## Nomenclatura

- Screens: `*.screen.tsx`
- Controller Hooks: `use*Controller.ts`
- Models: `*.model.ts`
- Repositories: `*.repository.ts`
- Services de plataforma: `*.service.ts`
- Components locais: `*.component.tsx`
- Styles: `styles.ts` ou convenção equivalente já adotada
- Variações: `*.ios.tsx`, `*.android.tsx`, `*.native.tsx`, `*.web.tsx`
- Tests: `*.spec.ts`/`*.spec.tsx` na mesma pasta do arquivo testado, espelhando
  o nome, como `Cpf.screen.tsx` -> `Cpf.screen.spec.tsx`. Não use uma pasta de
  testes separada.
<!-- sdd:section react-native.naming:end -->

<!-- sdd:section react-native.new-flow:start -->
## Novo flow mobile

1. Crie o flow em `src/modules/<module>/<flow>/`.
2. Defina Models em `models/`.
3. Implemente Repositories e services de plataforma necessários.
4. Crie `use<Flow>Controller` em `hooks/controller/`.
5. Crie a Screen e componentes locais em `view/`.
6. Adicione uma entrada fina no router ou navigator.
7. Valide permissões, indisponibilidade e diferenças Android/iOS.
8. Teste Controller Hook, Repository, Screen e jornada crítica.
<!-- sdd:section react-native.new-flow:end -->

<!-- sdd:section react-native.quality:start -->
## Validação

- Rode lint, TypeScript, testes e build definidos pelo projeto.
- Teste Hooks e Repositories isoladamente.
- Teste Screens por comportamento com React Native Testing Library.
- Cubra jornadas críticas com o E2E já adotado, como Maestro ou Detox.
- Quando houver código nativo, valide Android e iOS.
- Valide deep links, permissões, offline, retomada do background e sessão
  expirada quando fizerem parte do fluxo.
<!-- sdd:section react-native.quality:end -->

<!-- sdd:section react-native.agent:start -->
## Regras para agentes

- Leia `react.md` e este padrão antes de criar arquivos React Native.
- Preserve router, styling, design system e ferramentas já adotados.
- Não implemente regras do flow diretamente em arquivos de rota.
- Não faça requests ou acesso a storage diretamente em Screens.
- Não coloque JSX em Controller Hooks, Models, Repositories ou services.
- Não armazene tokens em AsyncStorage.
- Não crie abstrações em `shared/` antes de existir reuso real.
- Não adicione dependências nativas sem verificar suporte às plataformas alvo.
<!-- sdd:section react-native.agent:end -->
