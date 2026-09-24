import pkg from 'whatsapp-web.js';
import type { Client as WebJsClient } from 'whatsapp-web.js';
import type { RawChat } from './domain/types.js';
import qrcodeTerminal from 'qrcode-terminal';
import type { BridgeConfig } from './config.js';
import { SessionState } from './state/SessionState.js';
import { EventStore } from './state/EventStore.js';
import { ContactStore } from './state/ContactStore.js';
import { LidMap } from './state/LidMap.js';
import { RecoveryBudget } from './whatsapp/RecoveryBudget.js';
import { SelfJidResolver } from './whatsapp/SelfJidResolver.js';
import { SessionManager } from './whatsapp/SessionManager.js';
import { ContactsService } from './whatsapp/ContactsService.js';
import { HistoryService } from './whatsapp/HistoryService.js';
import { MessageService } from './whatsapp/MessageService.js';
import { IngestionService } from './whatsapp/IngestionService.js';
import { WebSocketBroadcaster } from './ws/WebSocketBroadcaster.js';
import { HealthController } from './controllers/HealthController.js';
import { SessionController } from './controllers/SessionController.js';
import { ContactsController } from './controllers/ContactsController.js';
import { LabelsController } from './controllers/LabelsController.js';
import { EventsController } from './controllers/EventsController.js';
import { HistoryController } from './controllers/HistoryController.js';
import { MessagesController } from './controllers/MessagesController.js';
import { wait } from './utils/time.js';
import { errorMessageOf, telemetry } from './telemetry/Telemetry.js';

const { Client, LocalAuth } = pkg;

// Telemetria do navegador interno (Chrome/Edge controlado pelo puppeteer):
// queda do navegador ou travamento da página derrubam a sessão sem aviso claro.
const diagnosedPuppeteerObjects = new WeakSet<object>();

type EventTargetLike = { on?: (event: string, listener: (...args: unknown[]) => void) => unknown };

function attachPuppeteerDiagnostics(client: WebJsClient): void {
  const { pupPage, pupBrowser } = client as unknown as { pupPage?: EventTargetLike | null; pupBrowser?: EventTargetLike | null };

  if (pupBrowser && typeof pupBrowser.on === 'function' && !diagnosedPuppeteerObjects.has(pupBrowser)) {
    diagnosedPuppeteerObjects.add(pupBrowser);
    pupBrowser.on('disconnected', () => {
      telemetry.track('puppeteer.browser_disconnected', {});
    });
  }

  if (pupPage && typeof pupPage.on === 'function' && !diagnosedPuppeteerObjects.has(pupPage)) {
    diagnosedPuppeteerObjects.add(pupPage);
    pupPage.on('error', (error: unknown) => {
      telemetry.trackError('puppeteer.page_crashed', error);
    });
    pupPage.on('close', () => {
      telemetry.track('puppeteer.page_closed', {});
    });
    pupPage.on('pageerror', (error: unknown) => {
      telemetry.trackLimitedPageError(error);
    });
  }
}
const CLIENT_AUTH_TIMEOUT_MS = 60000;
const DEFAULT_AUTHENTICATED_READY_TIMEOUT_MS = 90_000;

const DEFAULT_CHAT_HYDRATION_TIMEOUT_MS = 120_000;
const DEFAULT_CHAT_HYDRATION_POLL_MS = 2_500;
const CHAT_HYDRATION_STABLE_POLLS = 2;

function getChatHydrationConfig(): { timeoutMs: number; pollMs: number } {
  const timeout = Number(process.env.WA_READY_CHATS_TIMEOUT_MS);
  const poll = Number(process.env.WA_READY_CHATS_POLL_MS);
  return {
    timeoutMs: Number.isFinite(timeout) && timeout >= 0 ? timeout : DEFAULT_CHAT_HYDRATION_TIMEOUT_MS,
    pollMs: Number.isFinite(poll) && poll > 0 ? poll : DEFAULT_CHAT_HYDRATION_POLL_MS
  };
}

type WebJsClientWithChatPage = WebJsClient & {
  getChats: () => Promise<RawChat[]>;
};

class ChatHydrationCancelledError extends Error {
  constructor() {
    super('chat hydration cancelled because the WhatsApp session changed');
  }
}

class ChatHydrationBrokenError extends Error {
  constructor(lastFailure: string) {
    super(`chat hydration kept failing: ${lastFailure}`);
  }
}

const CHAT_HYDRATION_MAX_CONSECUTIVE_FAILURES = 6;

function ensureChatHydrationIsActive(isActive: () => boolean): void {
  if (!isActive()) {
    throw new ChatHydrationCancelledError();
  }
}

async function loadHydratedChats(
  client: WebJsClientWithChatPage,
  isActive: () => boolean = () => true
): Promise<RawChat[]> {
  ensureChatHydrationIsActive(isActive);
  const { timeoutMs, pollMs } = getChatHydrationConfig();
  if (timeoutMs <= 0) {
    return client.getChats();
  }

  const deadline = Date.now() + timeoutMs;
  let chats: RawChat[] = [];
  let lastCount = -1;
  let stablePolls = 0;
  let consecutiveFailures = 0;

  while (Date.now() < deadline) {
    ensureChatHydrationIsActive(isActive);
    try {
      chats = await client.getChats();
      consecutiveFailures = 0;
      if (chats.length === lastCount) {
        stablePolls += 1;
        if (stablePolls >= CHAT_HYDRATION_STABLE_POLLS) {
          return chats;
        }
      } else {
        stablePolls = 0;
        console.log(`[whatsapp-webjs-bridge] Sincronizando conversas no WhatsApp Web... (${chats.length})`);
      }
      lastCount = chats.length;
    } catch (error) {
      const failureMessage = (error as { message?: string } | null)?.message || String(error);
      consecutiveFailures += 1;
      if (consecutiveFailures >= CHAT_HYDRATION_MAX_CONSECUTIVE_FAILURES) {
        throw new ChatHydrationBrokenError(failureMessage);
      }
      console.warn(
        '[whatsapp-webjs-bridge] getChats falhou durante hidratacao, tentando novamente:',
        failureMessage
      );
    }
    await wait(pollMs);
  }

  ensureChatHydrationIsActive(isActive);
  console.warn(`[whatsapp-webjs-bridge] Tempo maximo de sincronizacao atingido; usando as ${chats.length} conversas coletadas.`);
  return chats;
}

// Enquanto houver envios recentes (ex.: envio em massa), o recarregamento
// periódico de etiquetas espera: ele consulta as conversas de cada etiqueta
// no WhatsApp Web e disputa a página com os envios.
export const LABELS_POLL_PAUSE_AFTER_SEND_MS = 60_000;

export function isOutboundActive(lastOutboundAt: number, now = Date.now()): boolean {
  return lastOutboundAt > 0 && now - lastOutboundAt < LABELS_POLL_PAUSE_AFTER_SEND_MS;
}

function getAuthenticatedReadyTimeoutMs(): number {
  const raw = Number(process.env.WA_AUTHENTICATED_READY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUTHENTICATED_READY_TIMEOUT_MS;
}

export interface Container {
  config: BridgeConfig;
  client: WebJsClient;
  sessionState: SessionState;
  eventStore: EventStore;
  contactStore: ContactStore;
  lidMap: LidMap;
  selfJidResolver: SelfJidResolver;
  sessionManager: SessionManager;
  contactsService: ContactsService;
  historyService: HistoryService;
  messageService: MessageService;
  ingestionService: IngestionService;
  broadcaster: WebSocketBroadcaster;
  recoveryBudget: RecoveryBudget;
  controllers: {
    health: HealthController;
    session: SessionController;
    contacts: ContactsController;
    labels: LabelsController;
    events: EventsController;
    history: HistoryController;
    messages: MessagesController;
  };
}

export function buildContainer(config: BridgeConfig): Container {
  const puppeteerOptions: { executablePath?: string; args: string[] } = {
    args: config.puppeteerArgs
  };
  if (config.puppeteerExecutablePath) {
    puppeteerOptions.executablePath = config.puppeteerExecutablePath;
  }

  const localAuthOptions: {
    clientId: string;
    dataPath?: string;
    rmMaxRetries: number;
  } = {
    clientId: config.instanceName,
    dataPath: config.dataPath,
    // Windows may keep Chromium profile journal files locked for a short time.
    // More retries reduces false-fatal EBUSY errors during logout/cleanup.
    rmMaxRetries: 12
  };

  const client = new Client({
    authStrategy: new LocalAuth(localAuthOptions),
    puppeteer: puppeteerOptions,
    authTimeoutMs: CLIENT_AUTH_TIMEOUT_MS,
    webVersion: '2.3000.1040971408',
    // Pin a known WhatsApp Web HTML to avoid the "stuck after authenticated"
    // bug that happens when WhatsApp updates its frontend and breaks Store injection.
    // Source: https://github.com/wppconnect-team/wa-version
    webVersionCache: {
      type: 'remote',
      remotePath: process.env.WA_WEB_VERSION_HTML
        || 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1040971408-alpha.html'
    }
  });

  const selfJidResolver = new SelfJidResolver(client);
  const sessionState = new SessionState(config.instanceName, () => selfJidResolver.getOwnJid());
  const eventStore = new EventStore();
  const contactStore = new ContactStore();
  const lidMap = new LidMap();

  const sessionManager = new SessionManager(client, sessionState, selfJidResolver, config.instanceName);
  const contactsService = new ContactsService(client, sessionState, contactStore, eventStore, lidMap, selfJidResolver, {
    enableProfilePhotoFetch: config.enableProfilePhotoFetch
  });
  const historyService = new HistoryService(client, sessionState, lidMap, selfJidResolver, {
    enableHistoryEvents: config.enableHistoryEvents
  });
  const messageService = new MessageService(client, sessionState, eventStore, contactStore, lidMap, selfJidResolver);
  const ingestionService = new IngestionService(
    client,
    sessionState,
    eventStore,
    contactStore,
    lidMap,
    selfJidResolver
  );

  const broadcaster = new WebSocketBroadcaster();
  const recoveryBudget = new RecoveryBudget();

  const controllers = {
    health: new HealthController(),
    session: new SessionController(sessionManager, sessionState, recoveryBudget),
    contacts: new ContactsController(contactsService, contactStore, messageService, config.instanceName),
    labels: new LabelsController(contactsService, sessionState, config.instanceName),
    events: new EventsController(eventStore, historyService, ingestionService, config.instanceName, {
      enableHistoryEvents: config.enableHistoryEvents
    }),
    history: new HistoryController(
      historyService,
      messageService,
      eventStore,
      selfJidResolver,
      config.instanceName
    ),
    messages: new MessagesController(messageService, config.instanceName)
  };

  return {
    config,
    client,
    sessionState,
    eventStore,
    contactStore,
    lidMap,
    selfJidResolver,
    sessionManager,
    contactsService,
    historyService,
    messageService,
    ingestionService,
    broadcaster,
    recoveryBudget,
    controllers
  };
}

export function bindClientEvents(container: Container): void {
  const {
    client,
    sessionState,
    eventStore,
    contactStore,
    contactsService,
    ingestionService,
    messageService,
    sessionManager,
    broadcaster,
    recoveryBudget,
    selfJidResolver
  } = container;

  const LABELS_POLL_INTERVAL_MS = 30000;
  const LABELS_READY_LINK_RESOLUTION_LIMIT = 60;
  const DISCONNECTED_RECOVERY_DELAY_MS = 1200;
  let lastLabelsJson = '';
  let labelsPollTimer: ReturnType<typeof setInterval> | null = null;
  let labelsWarmupRunId = 0;
  let disconnectRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let authenticatedReadyTimer: ReturnType<typeof setTimeout> | null = null;
  let readyBootstrapInFlight = false;
  let readyBootstrapGeneration = 0;
  let authenticatedAt = 0;

  const cancelReadyBootstrap = (): void => {
    readyBootstrapGeneration += 1;
    readyBootstrapInFlight = false;
    contactsService.setInitialContactsWarmup(null);
  };

  const stopAuthenticatedReadyWatchdog = (): void => {
    if (authenticatedReadyTimer) {
      clearTimeout(authenticatedReadyTimer);
      authenticatedReadyTimer = null;
    }
  };

  const startAuthenticatedReadyWatchdog = (): void => {
    stopAuthenticatedReadyWatchdog();
    const timeoutMs = getAuthenticatedReadyTimeoutMs();

    authenticatedReadyTimer = setTimeout(() => {
      authenticatedReadyTimer = null;

      if (sessionState.status !== 'authenticated') {
        return;
      }

      const canRecover = recoveryBudget.tryConsume();
      telemetry.track('session.ready_watchdog_timeout', {
        timeoutMs,
        willRecover: canRecover,
        recoveryAttempt: recoveryBudget.attemptsInWindow
      });

      if (!canRecover) {
        sessionState.status = 'init_error';
        sessionState.qr = null;
        sessionState.lastError = `WhatsApp autenticou, mas nao ficou pronto apos ${recoveryBudget.attemptsInWindow}/${recoveryBudget.maxAttemptsAllowed} tentativas automaticas. Clique em "Tentar novamente" para reiniciar a conexao.`;
        console.error('[whatsapp-webjs-bridge] Limite de auto-recuperacao excedido enquanto aguardava ready apos authenticated.');
        broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
        return;
      }

      const attempt = recoveryBudget.attemptsInWindow;
      const maxAttempts = recoveryBudget.maxAttemptsAllowed;
      sessionState.status = 'init_error';
      sessionState.qr = null;
      sessionState.lastError = `WhatsApp autenticou, mas nao ficou pronto em ${Math.round(timeoutMs / 1000)}s. Tentando reiniciar a sessao (${attempt}/${maxAttempts})...`;
      console.error('[whatsapp-webjs-bridge] Timeout aguardando ready apos authenticated. Reiniciando sessao.');
      broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());

      void sessionManager.ensureInitialized().catch(error => {
        sessionState.status = 'init_error';
        sessionState.qr = null;
        sessionState.lastError = (error as { message?: string } | null)?.message || String(error);
        console.error(
          '[whatsapp-webjs-bridge] Falha ao recuperar sessao apos timeout authenticated->ready:',
          (error as { message?: string } | null)?.message || String(error)
        );
        broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
      });
    }, timeoutMs);

    authenticatedReadyTimer.unref?.();
  };

  client.on('qr', qr => {
    stopDisconnectRecovery();
    stopAuthenticatedReadyWatchdog();
    cancelReadyBootstrap();
    clearLabelsSnapshot('qr_required');
    sessionState.status = 'qr_required';
    sessionState.qr = qr;
    sessionState.lastError = '';
    attachPuppeteerDiagnostics(client);
    qrcodeTerminal.generate(qr, { small: true });
    console.log('[whatsapp-webjs-bridge] QR recebido. Escaneie no celular.');
    broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
  });

  client.on('authenticated', () => {
    stopDisconnectRecovery();
    startAuthenticatedReadyWatchdog();
    cancelReadyBootstrap();
    sessionState.status = 'authenticated';
    sessionState.qr = null;
    sessionState.lastError = '';
    authenticatedAt = Date.now();
    attachPuppeteerDiagnostics(client);
    console.log('[whatsapp-webjs-bridge] Sessao autenticada. Aguardando WhatsApp Web carregar (Store)...');
    broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
  });

  client.on('loading_screen', (percent: number, message: string) => {
    telemetry.track('client.loading_screen', { percent: Number(percent) || 0, message: String(message || '') });
    console.log(`[whatsapp-webjs-bridge] loading_screen ${percent}%: ${message}`);
  });

  client.on('change_state', (state: string) => {
    telemetry.track('client.change_state', { state: String(state || '') });
    console.log(`[whatsapp-webjs-bridge] change_state: ${state}`);
  });

  const refreshLabelsAndBroadcast = async (
    reason: string,
    options: { linkedChatResolutionLimit?: number } = {}
  ): Promise<void> => {
    const startedAt = Date.now();
    try {
      const labels = await contactsService.loadLabels({
        linkedChatResolutionLimit: options.linkedChatResolutionLimit
      });
      const serialized = JSON.stringify(labels);
      const changed = serialized !== lastLabelsJson;
      if (reason !== 'poll' || changed) {
        telemetry.track('labels.refresh', { reason, ms: Date.now() - startedAt, count: labels.length, changed });
      }
      if (!changed) {
        return;
      }
      lastLabelsJson = serialized;
      broadcaster.broadcast('labels_updated', { labels });
      console.log(`[whatsapp-webjs-bridge] labels_updated (${labels.length}, reason=${reason})`);
    } catch (error) {
      telemetry.trackError('error.labels_refresh', error, { reason, ms: Date.now() - startedAt });
      console.warn(
        '[whatsapp-webjs-bridge] Falha ao atualizar etiquetas:',
        (error as { message?: string } | null)?.message || String(error)
      );
    }
  };

  const stopLabelsPoll = (): void => {
    if (labelsPollTimer) {
      clearInterval(labelsPollTimer);
      labelsPollTimer = null;
    }
  };

  const stopDisconnectRecovery = (): void => {
    if (disconnectRecoveryTimer) {
      clearTimeout(disconnectRecoveryTimer);
      disconnectRecoveryTimer = null;
    }
  };

  const clearLabelsSnapshot = (reason: string): void => {
    stopLabelsPoll();
    stopDisconnectRecovery();
    labelsWarmupRunId += 1;
    if (lastLabelsJson === '[]') {
      return;
    }

    lastLabelsJson = '[]';
    broadcaster.broadcast('labels_updated', { labels: [] });
    console.log(`[whatsapp-webjs-bridge] labels_updated (0, reason=${reason})`);
  };

  const startLabelsPoll = (): void => {
    stopLabelsPoll();
    labelsPollTimer = setInterval(() => {
      if (sessionState.status !== 'ready') {
        return;
      }
      if (isOutboundActive(messageService.lastOutboundAt)) {
        return;
      }
      void refreshLabelsAndBroadcast('poll');
    }, LABELS_POLL_INTERVAL_MS);
  };

  const startLabelsWarmup = (): void => {
    labelsWarmupRunId += 1;
    const runId = labelsWarmupRunId;
    stopLabelsPoll();

    void (async () => {
      const attemptDelaysMs = [0, 1500, 3000, 5000, 8000, 12000];
      for (const delay of attemptDelaysMs) {
        if (delay) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        if (runId !== labelsWarmupRunId || sessionState.status !== 'ready') {
          return;
        }

        await refreshLabelsAndBroadcast('ready', {
          linkedChatResolutionLimit: LABELS_READY_LINK_RESOLUTION_LIMIT
        });

        if (lastLabelsJson && lastLabelsJson !== '[]') {
          break;
        }
      }

      if (runId === labelsWarmupRunId && sessionState.status === 'ready') {
        startLabelsPoll();
      }
    })();
  };

  client.on('ready', async () => {
    stopDisconnectRecovery();
    stopAuthenticatedReadyWatchdog();
    recoveryBudget.reset();
    const duplicateReadyWhileBootstrapping = sessionState.status === 'ready' && readyBootstrapInFlight;
    telemetry.track('client.ready', {
      duplicate: duplicateReadyWhileBootstrapping,
      msSinceAuthenticated: authenticatedAt ? Date.now() - authenticatedAt : null
    });
    attachPuppeteerDiagnostics(client);
    sessionState.status = 'ready';
    sessionState.qr = null;
    sessionState.lastError = '';
    if (duplicateReadyWhileBootstrapping) {
      console.log('[whatsapp-webjs-bridge] Cliente pronto (evento duplicado ignorado).');
      broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
      return;
    }

    const bootstrapGeneration = ++readyBootstrapGeneration;
    const isCurrentBootstrap = (): boolean => sessionState.status === 'ready'
      && bootstrapGeneration === readyBootstrapGeneration;
    readyBootstrapInFlight = true;
    console.log('[whatsapp-webjs-bridge] Cliente pronto.');
    broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
    startLabelsWarmup();

    let initialContactsWarmup: Promise<void> | null = null;
    try {
      const clientWithChats = client as WebJsClientWithChatPage;
      initialContactsWarmup = (async () => {
        const hydrationStartedAt = Date.now();
        const chats = await loadHydratedChats(clientWithChats, isCurrentBootstrap);
        if (!isCurrentBootstrap()) return;
        const hydrationMs = Date.now() - hydrationStartedAt;
        telemetry.track('boot.chats_hydrated', { chats: chats.length, ms: hydrationMs });
        console.log(`[whatsapp-webjs-bridge] Conversas hidratadas: ${chats.length} em ${hydrationMs}ms. Iniciando refresh de contatos.`);
        const refreshStartedAt = Date.now();
        await contactsService.triggerRefresh({ preloadedChats: chats, reason: 'ready' });
        if (!isCurrentBootstrap()) return;
        const refreshMs = Date.now() - refreshStartedAt;
        telemetry.track('boot.contacts_refreshed', { ms: refreshMs, contacts: contactStore.size });
        console.log(`[whatsapp-webjs-bridge] tempo refresh de contatos (ready): ${refreshMs}ms`);
        const seedStartedAt = Date.now();
        await ingestionService.seedEventsFromRecentChats(chats);
        telemetry.track('boot.events_seeded', { ms: Date.now() - seedStartedAt });
      })();
      contactsService.setInitialContactsWarmup(initialContactsWarmup);
      await initialContactsWarmup;
    } catch (error) {
      if (error instanceof ChatHydrationCancelledError) {
        telemetry.track('session.hydration_cancelled', { status: sessionState.status });
        console.log('[whatsapp-webjs-bridge] Hidratacao de conversas cancelada porque a sessao mudou.');
      } else if (error instanceof ChatHydrationBrokenError && bootstrapGeneration === readyBootstrapGeneration) {
        telemetry.trackError('session.hydration_broken', error, { recoveryAttempt: recoveryBudget.attemptsInWindow });
        console.error('[whatsapp-webjs-bridge] WhatsApp Web perdeu a conexao interna apos ready. Reiniciando sessao:', error.message);
        if (recoveryBudget.tryConsume()) {
          sessionState.status = 'init_error';
          sessionState.qr = null;
          sessionState.lastError = 'Conexao com o WhatsApp Web se perdeu durante o carregamento. Reiniciando a sessao...';
          broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
          void sessionManager.ensureInitialized().catch(initError => {
            sessionState.status = 'init_error';
            sessionState.lastError = (initError as { message?: string } | null)?.message || String(initError);
            broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
          });
        } else {
          sessionState.status = 'init_error';
          sessionState.qr = null;
          sessionState.lastError = `Sessao do WhatsApp nao respondeu apos ${recoveryBudget.attemptsInWindow}/${recoveryBudget.maxAttemptsAllowed} tentativas automaticas. Clique em "Tentar novamente" para reiniciar a conexao.`;
          broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
        }
      } else {
        telemetry.trackError('error.ready_bootstrap', error);
        console.error('[whatsapp-webjs-bridge] Falha ao carregar contatos:', (error as { message?: string } | null)?.message || String(error));
      }
    } finally {
      if (bootstrapGeneration === readyBootstrapGeneration) {
        contactsService.setInitialContactsWarmup(null);
        readyBootstrapInFlight = false;
      }
    }
  });

  client.on('auth_failure', (message: string) => {
    stopDisconnectRecovery();
    stopAuthenticatedReadyWatchdog();
    cancelReadyBootstrap();
    telemetry.track('session.auth_failure', { message: String(message || '') });
    sessionState.status = 'auth_failure';
    sessionState.lastError = String(message || 'Authentication failure');
    console.error('[whatsapp-webjs-bridge] Falha de autenticacao:', message);
    clearLabelsSnapshot('auth_failure');
    broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
  });

  // Razões "terminais" do whatsapp-web.js — quando recebemos uma dessas, a
  // sessão foi removida do servidor (ou pelo phone "deslinkando", ou por
  // bloqueio TOS, ou por LOGOUT explícito). Reconectar automaticamente é
  // inútil porque a sessão LocalAuth já não bate mais com o que o WhatsApp
  // tem registrado — só vai gerar QR. Pior: as tentativas em loop podem
  // causar "logout fantasma" no celular oficial. Deixa em 'disconnected' e
  // espera o usuário clicar em "Gerar novo QR".
  const TERMINAL_DISCONNECT_REASONS = /\b(LOGOUT|TOS_BLOCK|BAN|UNPAIRED|CONFLICT)\b/i;

  client.on('disconnected', (reason: string) => {
    const reasonText = String(reason || 'Disconnected');
    // Eco de disconnect do cliente antigo durante um restart é ruído — mas
    // razão terminal (LOGOUT/UNPAIRED/...) significa sessão removida no
    // servidor e precisa ser processada, senão o init espera autenticação
    // impossível até estourar timeout.
    const terminal = TERMINAL_DISCONNECT_REASONS.test(reasonText);
    const ignoredDuringInit = sessionManager.isInitializeInFlight() && !terminal;
    const manual = sessionManager.isManualDisconnectInProgress();
    telemetry.track('session.disconnected', {
      reason: reasonText,
      terminal,
      ignoredDuringInit,
      manual,
      previousStatus: sessionState.status,
      recoveryPending: Boolean(disconnectRecoveryTimer),
      recoveryAttempts: recoveryBudget.attemptsInWindow
    });

    if (ignoredDuringInit) {
      console.warn('[whatsapp-webjs-bridge] Desconexao ignorada durante inicializacao em andamento. Reason:', JSON.stringify(reasonText));
      return;
    }

    stopAuthenticatedReadyWatchdog();
    cancelReadyBootstrap();
    sessionState.status = 'disconnected';
    sessionState.qr = null;
    sessionState.lastError = reasonText;
    console.warn('[whatsapp-webjs-bridge] Cliente desconectado. Reason:', JSON.stringify(reasonText));
    clearLabelsSnapshot('disconnected');
    broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());

    if (sessionManager.isManualDisconnectInProgress() || disconnectRecoveryTimer) {
      return;
    }

    if (TERMINAL_DISCONNECT_REASONS.test(reasonText)) {
      console.warn(
        '[whatsapp-webjs-bridge] Razão terminal detectada — sessão removida no servidor. '
        + 'Não vou tentar reconectar; usuário precisa clicar em "Gerar novo QR".'
      );
      return;
    }

    if (!recoveryBudget.tryConsume()) {
      telemetry.track('session.recovery_exhausted', { origin: 'disconnected', attempts: recoveryBudget.attemptsInWindow });
      sessionState.status = 'init_error';
      sessionState.lastError = `Sessao do WhatsApp nao respondeu apos ${recoveryBudget.attemptsInWindow}/${recoveryBudget.maxAttemptsAllowed} tentativas automaticas. Clique em "Tentar novamente" para reiniciar a conexao.`;
      console.error('[whatsapp-webjs-bridge] Limite de auto-recuperacao excedido apos desconexao transitória.');
      broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
      return;
    }

    telemetry.track('session.recovery_scheduled', { origin: 'disconnected', attempt: recoveryBudget.attemptsInWindow });
    disconnectRecoveryTimer = setTimeout(() => {
      disconnectRecoveryTimer = null;
      void sessionManager.ensureInitialized().catch(initError => {
        sessionState.status = 'init_error';
        sessionState.lastError = (initError as { message?: string } | null)?.message || String(initError);
        console.error(
          '[whatsapp-webjs-bridge] Falha ao recuperar sessao apos desconexao:',
          (initError as { message?: string } | null)?.message || String(initError)
        );
        broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
      });
    }, DISCONNECTED_RECOVERY_DELAY_MS);
  });

  client.on('message', message => {
    console.log('[whatsapp-webjs-bridge] evento message:', {
      from: message?.from,
      to: message?.to,
      fromMe: selfJidResolver.resolveIsFromMe(message),
      type: message?.type
    });
    ingestionService.ingestInboundMessage(message, 'webjs-inbound').catch(err => {
      console.warn(
        '[whatsapp-webjs-bridge] ingestInboundMessage falhou:',
        (err as { message?: string } | null)?.message || String(err)
      );
    });
  });

  client.on('message_ack', (message, ack: number) => {
    const messageId = typeof message?.id === 'object' && message.id?._serialized
      ? message.id._serialized
      : '';
    if (typeof ack === 'number' && ack < 0) {
      telemetry.track('message.ack_error', { ack, type: String(message?.type || '') });
    }
    if (messageId) {
      eventStore.updateEventAck(messageId, ack);
      messageService.propagateAckToContact(messageId, ack);
      broadcaster.broadcast('message_ack', { messageId, ack });
    }
  });

  client.on('message_create', message => {
    console.log('[whatsapp-webjs-bridge] evento message_create:', {
      from: message?.from,
      to: message?.to,
      fromMe: selfJidResolver.resolveIsFromMe(message),
      type: message?.type
    });

    const fromMe = selfJidResolver.resolveIsFromMe(message);
    telemetry.track('message.created', {
      fromMe,
      type: String(message?.type || ''),
      group: String(message?.from || '').endsWith('@g.us') || String(message?.to || '').endsWith('@g.us')
    });
    if (!fromMe) {
      ingestionService.ingestInboundMessage(message, 'webjs-inbound-create').catch(err => {
        console.warn(
          '[whatsapp-webjs-bridge] ingestInboundMessage falhou:',
          (err as { message?: string } | null)?.message || String(err)
        );
      });
      return;
    }

    ingestionService.ingestOutboundFromCreate(message, 'webjs-outbound-create').catch(err => {
      console.warn(
        '[whatsapp-webjs-bridge] ingestOutboundFromCreate falhou:',
        (err as { message?: string } | null)?.message || String(err)
      );
    });
  });

  eventStore.setOnEventPushed(event => {
    broadcaster.broadcast('new_message', event);
  });

  contactsService.setOnContactsUpdated(contacts => {
    broadcaster.broadcast('contacts_updated', { contacts });
  });

  ingestionService.setOnUnresolvedLid(lidJid => {
    if (sessionState.status !== 'ready') {
      return;
    }
    void contactsService.triggerRefresh({ reason: `unresolved-lid:${lidJid}` });
  });
}
