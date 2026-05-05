# Roadmap de evolução

> Documento de **direção**, não de plano fechado. Lista o que precisa amadurecer no app antes de migrar partes pra Firebase, focando em: **prevenção de erros**, **observabilidade**, **escalabilidade** e **desacoplamento**.
>
> O Firebase entra **depois** dessa fundação — caso contrário, qualquer bug que existir hoje passa a ser bug distribuído (mais difícil de diagnosticar) sem nenhum ganho.

---

## 1. Prevenção de erros

O app já tem testes unitários do bridge ([whatsapp-webjs-bridge/tests/](../whatsapp-webjs-bridge/tests/)) — 50+ casos cobrindo `MessageService`, `IngestionService`, `SessionManager`, `ContactsService`. **O front-end Angular tem cobertura mais rasa**, focada em smoke tests dos componentes. É a maior alavanca pra reduzir regressão.

### Próximos passos (ordem de impacto)

1. **Subir a cobertura do `WhatsappStateService`** ([src/app/modules/whatsapp/services/whatsapp-state.service.ts](../src/app/modules/whatsapp/services/whatsapp-state.service.ts)). Esse arquivo é 2.3k linhas com 90% da regra do chat. Falta teste pra:
   - `mergeServerMessages` / `mergeWithLocal` / `pruneMessages` (o pipeline de mensagens — onde os bugs de ordem/dup nascem)
   - `applyContactsSnapshot` com auto-seleção via WS push (regressão recente: WS arbitrário podia auto-selecionar contato indesejado)
   - `appendOutgoingMessage` reconciliando otimista com servidor
   - Bootstrap retries (recém-mudou de 5 pra 2 — adicionar teste pra travar a configuração)

2. **Property-based tests pra `phone.ts` / `jid.ts`**. Com `fast-check` ou similar, gerar telefones aleatórios brasileiros e validar que `brazilianAlternativeJid(brazilianAlternativeJid(x)) === x` (involução), que `normalizeJid` é idempotente etc. **Esses utils são fundação de tudo** — bug aqui vaza pra todo o resto.

3. **Schema validation runtime nas fronteiras**: hoje a bridge confia que o JSON vindo do whatsapp-web.js tem o shape esperado (ver `RawMessage`, `RawChat` em [domain/types.ts](../whatsapp-webjs-bridge/src/domain/types.ts)). Quando a lib muda o shape silenciosamente (atualização do WhatsApp Web), o app começa a comportar errado sem erro óbvio. Solução: passar tudo por [`zod`](https://zod.dev/) (ou similar) na fronteira `client.on(...)` e logar com clareza quando shape diverge.

4. **CI rodando os testes em cada PR**. Hoje precisa rodar à mão (`npm test` na bridge, `ng test` no front). Subir GitHub Actions com:
   - `npm run bridge:build && npm test --prefix whatsapp-webjs-bridge`
   - `ng test --watch=false --browsers=ChromeHeadless`
   - `ng build --configuration production` (pra travar budgets também)
   - Lint (nem o front nem a bridge têm config de lint hoje — adicionar ESLint com regras estritas é parte disso)

5. **Snapshots de regressão da UI**. Playwright + um workflow que sobe o Electron empacotado, renderiza as 3-4 telas principais (home, console, modais) e compara com baseline. Pega regressões de CSS (tipo "movi a classe pro componente errado e quebrou o layout").

6. **Detectar regressões de behavior recurrentes via testes "scenario"**. Os bugs reportados (9º dígito, LID dup, logout fantasma) já têm testes unitários como guard. Próximo nível: cenários end-to-end mockando o `whatsapp-web.js` Client e simulando sequências reais (envio → resposta LID → refresh → não pode duplicar).

---

## 2. Observabilidade (encontrar bugs em produção)

Hoje o único log é `error/bridge-YYYY-MM-DD.log`. **O front não tem log nenhum** — quando algo dá errado na máquina do usuário, você só descobre se ele te avisar.

### Próximos passos

1. **Logger estruturado no front**. Service `LogService` que captura:
   - Erros (`window.onerror`, `unhandledrejection`)
   - Falhas de gateway (4xx/5xx do bridge)
   - Reconexões WS, timeouts, falhas de retry
   - Eventos importantes (envio bem-sucedido, novo contato, etc.) com nível `info`
   - Persiste em arquivo local (Electron pode escrever em `userData/logs/`)
   - Limita por tamanho/idade

2. **Bridge: mover `console.log` pra logger estruturado**. A bridge já loga muita coisa, mas em texto cru. Migrar pra `pino` ou `winston` com níveis (`debug`/`info`/`warn`/`error`) e formato JSON. Facilita depois mandar pro Firebase Logging / Sentry.

3. **Sentry (ou alternativa) pra erros não tratados**. Tanto front quanto bridge. Captura stack trace + breadcrumbs + contexto. Custo: configurar SDK + DSN. Benefício: você sabe que tem bug **antes** do usuário reclamar.

4. **Health endpoint mais rico no bridge**. `/api/health` hoje só retorna ok. Expandir pra:
   - `sessionStatus`
   - `contactStoreSize`
   - `lidMapSize`
   - `eventStoreSize`
   - `lastContactsRefreshAt`
   - `bridgeUptimeSec`
   - `wsClientCount`

   Front pode renderizar isso numa tela admin de "diagnóstico" — útil pra você inspecionar remotamente.

5. **Trace IDs em ações importantes**. Quando o usuário envia uma mensagem, gera um `traceId` no front, passa via header pro bridge, propaga via `eventStore.pushEvent`, aparece no log. Quando algo der errado, você consegue rastrear o caminho.

---

## 3. Escalabilidade

O app hoje é single-instance, single-user (uma sessão WhatsApp por máquina). Antes de escalar, vale entender as limitações atuais:

### Limites conhecidos

- **EventStore: ring buffer in-memory de 200 eventos**. Reinicia a cada boot da bridge. Se a feature precisar de "histórico persistente além do que o WhatsApp Web fornece", isso quebra.
- **ContactStore: in-memory**. Mesma coisa — reinicia. Repopula via getChats no boot.
- **LidMap: in-memory**. O mapeamento aprendido se perde a cada reboot e precisa ser re-aprendido.
- **Logs**: arquivo local sem rotação além de "um arquivo por dia". Pode encher disco em ambientes com muito volume.
- **Bulk send**: queue persiste em `localStorage`, sequencial, sem retry inteligente. Se o usuário fechar o app no meio, retoma na próxima abertura mas com `isPaused: true`.

### Próximos passos

1. **Persistir LidMap** num arquivo JSON em `userData/`. Pequeno (algumas centenas de kB no max), reduz latência de aprendizado e elimina muitas duplicações de contato após reinício.

2. **Persistir EventStore opcionalmente** — útil pra ter histórico do que aconteceu mesmo após reboot. Pode ser SQLite (`better-sqlite3`) com schema mínimo (id, chatJid, isFromMe, text, payload JSON, receivedAt). Quando migrar pro Firebase: trocar SQLite por Firestore mantendo a mesma interface.

3. **Bulk send com retry inteligente**: hoje se o WhatsApp rejeita uma mensagem do bulk, ela vai pro estado `error` e o usuário precisa interferir manualmente. Adicionar:
   - Retry exponencial (3 tentativas com backoff)
   - Pular automaticamente após N falhas
   - Resumo no fim ("enviado pra X, falhou em Y, lista dos que falharam pra retentar")

4. **Throttling de envio em massa** baseado em sinais de risco. WhatsApp baneia contas que enviam rápido demais. Hoje há `POST_SEND_DELAY_MS = 500` fixo. Adicionar:
   - Delay aleatório entre 800ms-2.5s pra parecer humano
   - Pause obrigatória depois de N envios (configurable)
   - Detectar resposta de "rate-limited" e pausar mais agressivo

5. **WhatsApp Web version pinning policy**. Hoje o `webVersionCache` aponta pra um HTML específico no GitHub do wppconnect-team. Quando o WhatsApp atualiza e a lib quebra, precisa atualizar manualmente o pin. Documentar:
   - Como verificar se a versão atual ainda funciona
   - Como bumpar pro mais novo testado
   - Plano B se a versão pinada sumir (fork do wa-version, mirror próprio)

---

## 4. Desacoplamento (preparação pro Firebase)

A regra do app está hoje **toda misturada com a UI Angular** (no `WhatsappStateService` de 2.3k linhas) e com a **integração WhatsApp** (`whatsapp-webjs-bridge`). Pra mover algumas peças pro Firebase sem reescrever tudo, primeiro precisa separar **regra de negócio** de **acesso a dados**.

### Estado atual da arquitetura

```
┌──────────────────┐      ┌────────────────┐
│ Angular UI       │ <──> │ State Service  │ <──> Bridge HTTP/WS
│ (componentes)    │      │ (regra + dados)│
└──────────────────┘      └────────────────┘
                                   ↕
                           localStorage
                                   
┌──────────────────┐      ┌────────────────┐
│ Bridge HTTP/WS   │ <──> │ ContactsService│ <──> whatsapp-web.js
│                  │      │ MessageService │      Client
└──────────────────┘      └────────────────┘
```

Tudo bem acoplado. Mover qualquer coisa pro Firebase exige tocar em múltiplos lugares.

### Direção sugerida — "ports & adapters" / hexagonal

```
                          Domínio (regra pura)
┌──────────────────────────────────────────────────────┐
│  - WhatsappContact, WhatsappMessage, etc.            │
│  - merge / dedup / sort / validate                   │
│  - bulk-send fsm                                     │
└──────────────────────────────────────────────────────┘
        ↑                ↑                  ↑
        │                │                  │
   ┌────┴───┐       ┌────┴───┐         ┌────┴────┐
   │ Inbound│       │Outbound│         │Persist  │
   │ Port   │       │ Port   │         │ Port    │
   └────────┘       └────────┘         └─────────┘
        ↑                ↑                  ↑
        │                │                  │
  ┌─────┴──────┐  ┌──────┴─────┐    ┌───────┴────────┐
  │ Adapters:  │  │ Adapters:  │    │ Adapters:      │
  │ - bridge WS│  │ - bridge   │    │ - localStorage │
  │ - mock     │  │   REST     │    │ - SQLite       │
  │ - replay   │  │ - mock     │    │ - Firestore    │
  └────────────┘  └────────────┘    └────────────────┘
```

A ideia: o **domínio** não sabe se os dados vêm da bridge, do Firebase ou de um mock. Trocar o adapter de persistência (`LocalStorageAdapter` → `FirestoreAdapter`) não quebra a regra.

### Próximos passos

1. **Extrair tipos de domínio puros**. Hoje os modelos (`WhatsappContact`, `WhatsappMessage`) carregam coisas específicas do WhatsApp Web. Criar versões puras (sem `payload: any`, sem campos legacy) e usar **tipos separados** pra dados externos (`RawMessage` da lib) vs domínio (`Message` do app).

2. **Separar "regra" de "I/O" no `WhatsappStateService`**. Hoje ele faz HTTP + WS + state + regra. Quebrar em:
   - `WhatsappRepository` — só HTTP+WS, retorna Promise/Observable de dados domínio
   - `WhatsappState` — só state (BehaviorSubjects), recebe dados via método e expõe via Observable
   - `WhatsappOrchestrator` — consome repo e atualiza state, com merge/dedup/etc
   - **Cada uma testável isoladamente**.

3. **Persistence layer abstrata**. Hoje cada serviço (templates, quick replies, agendamentos, labels) lê/escreve `localStorage` direto. Criar uma interface:

   ```ts
   interface KeyValueStore<T> {
     read(key: string): Promise<T | null>;
     write(key: string, value: T): Promise<void>;
     remove(key: string): Promise<void>;
     list(prefix?: string): Promise<string[]>;
   }
   ```

   Implementação inicial: `LocalStorageKVS`. Depois adicionar `FirestoreKVS` sem tocar nos services. O `quick-reply.service.ts`, `message-template.service.ts`, `label.service.ts`, `scheduled-message.service.ts` viram consumidores de `KeyValueStore<X>` em vez de chamar `localStorage` direto.

4. **Event-driven entre módulos**. Hoje há acoplamento direto entre componentes via `ManagerLaunchService`, `PendingBulkSendService`, etc. — tudo via `Subject` + `Service`. Funciona, mas conforme o app cresce vira spaghetti. Considerar um event bus tipado (NgRx Signals + actions, ou um bus simples baseado em discriminated union de eventos), o que torna o fluxo entre módulos rastreável.

5. **Bridge: separar transporte (Express+WS) de regra (services)**. Hoje os controllers HTTP fazem dispatch direto pros services. Adicionar uma camada de "use cases" (ex: `SendMessageUseCase`, `LoadContactsUseCase`) que recebe DTOs e devolve resultados — facilitaria testes E2E sem subir HTTP server e mover transporte (HTTP → IPC direto, ou GRPC, ou outra coisa) sem reescrever lógica.

---

## 5. Migração progressiva pro Firebase

Quando a fundação acima estiver de pé, dá pra migrar peça por peça:

### Ordem sugerida (do menor risco ao maior)

1. **Logs de erro → Firebase Crashlytics ou Cloud Logging**. Zero risco, ganho imediato em observabilidade. Já planejado em §2.3.

2. **Etiquetas (custom labels do app, separadas das do WhatsApp) → Firestore**. Documento por usuário (`/users/{uid}/labels/{labelId}`). Sincroniza entre dispositivos. Volume baixo. Útil pra usuário que usa o app em mais de uma máquina.

3. **Templates de mensagem + quick replies → Firestore + Storage**. Texto no Firestore, imagens (data URLs grandes — 3MB cada) no Storage. Sincroniza entre dispositivos. Cuidado com custos do Storage se o usuário tiver muitas imagens.

4. **Agendamentos → Firestore + Cloud Function**. Hoje os agendamentos só rodam se o app estiver aberto. Migrando pra Cloud Function com `onCreate(scheduledMessage)`, dá pra disparar a notificação mesmo com o app fechado (o disparo do envio em si continua precisando da bridge local — Firestore só agenda).

5. **Histórico de mensagens → Firestore (opcional, custo alto)**. O WhatsApp Web já mantém o histórico — duplicar no Firestore só faz sentido se a feature precisar de busca ou exportação. Avaliar com calma.

### O que **NÃO** migrar pro Firebase

- **Sessão do WhatsApp** (`.wwebjs_auth/`). Fica local, é vinculada à máquina via `LocalAuth`. Mover pra cloud é complicado e arriscado (lockfiles, permissões).
- **Cache do WhatsApp Web** (`.wwebjs_cache/`). Local, descartável.
- **Mensagens de tempo real**. Bridge → front é local (low latency). Firestore como middleware adicionaria 200-500ms de latência por mensagem.

---

## 6. Quick wins enquanto isso

Coisas pequenas, alta razão valor/esforço:

- [ ] **Adicionar ESLint** com regras estritas em ambos os projetos. Pega bugs que TypeScript não pega (promises não-aguardadas, variáveis não-usadas, etc).
- [ ] **Snapshot de versão** ([version.json](../version.json)) servir como source-of-truth do `package.json` e `APP_VERSION` — hoje há 3 lugares pra atualizar.
- [ ] **Validação de uploads de mídia**: hoje `MessagesController.sendMedia` aceita qualquer mimetype até 50MB. Adicionar whitelist de tipos seguros (image/*, application/pdf, audio/*, video/mp4) e rejeitar o resto antes de enfiar no whatsapp-web.js.
- [ ] **Botões de "Reset session"** na tela de configurações: limpa `.wwebjs_auth`, força novo QR. Útil pra debug do logout fantasma.
- [ ] **Tela de "diagnóstico"** mostrando snapshot do `health` endpoint enriquecido (§2.4). Acessível por atalho oculto.

---

## Status atual dos cenários conhecidos

| Cenário | Status | Onde |
|---|---|---|
| 9º dígito: send falha quando preferred é alt e ela falha | **Corrigido** + teste regressão | [MessageService.sendWithBrazilianAlternative](../whatsapp-webjs-bridge/src/whatsapp/MessageService.ts) |
| Número desconhecido na rede: nenhuma variante BR funciona | **Mitigado** com `getNumberId()` lookup como última tentativa | mesmo arquivo |
| Contato LID duplicado (Vanessa) | **Mitigado**: `registerCanonicalLid` agora sempre dispara `mergeAliasContactIntoCanonical` mesmo sem displaced canonical | [IngestionService](../whatsapp-webjs-bridge/src/whatsapp/IngestionService.ts) + [ContactsService](../whatsapp-webjs-bridge/src/whatsapp/ContactsService.ts) |
| Tela "Carregando contatos" trava por 5min | **Não corrigido — revertido**. Tentei reduzir retries de 5 pra 2 + 2ª sem `waitForRefresh`, mas o app passou a vir com 0 ou 1 contato no primeiro boot pós-QR (lib whatsapp-web.js demora a popular getChats). Voltou pro retry generoso. Próxima abordagem: ouvir push WS `contacts_updated` e cancelar o polling quando chegar lista não-vazia, em vez de cortar no número de tentativas. |
| Demora 1-2min pra detectar logout pelo celular | **Não corrigido** — depende de ouvir `change_state: UNPAIRED` do whatsapp-web.js, exige investigação. Está no roadmap. |
| Logout fantasma na inicialização | **Corrigido**: `RecoverableErrors.ts` + `installProcessGuards` cobrem o caminho de recuperação por erro de processo. |
| Tela "Inicializando sessão do WhatsApp..." eterna | **Corrigido**: `scheduleStartupRecovery` em [server.ts](../whatsapp-webjs-bridge/src/server.ts) recursava sem limite quando o `client.initialize()` falhava com erro recuperável. Agora limita a **5 tentativas**, depois desiste e fica em `init_error` (UI mostra botão "Tentar novamente"). |
| App deslogou sozinho durante carga inicial (e celular oficial também) | **Mitigado**: handler de `'disconnected'` em [container.ts](../whatsapp-webjs-bridge/src/container.ts) agora detecta razões **terminais** (`LOGOUT`, `TOS_BLOCK`, `BAN`, `UNPAIRED`, `CONFLICT`) e **não tenta reconectar** nesse caso — espera o usuário clicar "Gerar novo QR". Antes sempre tentava reconectar, o que pode ter contribuído pra logout fantasma porque o WhatsApp Server vê várias tentativas de reconexão como sessão suspeita. Também adicionado log loud em `SessionManager.disconnect()` (com stack trace) — único caminho que dispara `client.logout()` no bridge — pra diagnosticar futuras chamadas inesperadas. |
