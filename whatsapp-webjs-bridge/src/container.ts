import pkg from 'whatsapp-web.js';
import type { Client as WebJsClient } from 'whatsapp-web.js';
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

const { Client, LocalAuth } = pkg;
const CLIENT_AUTH_TIMEOUT_MS = 60000;

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
    // Pin a known WhatsApp Web HTML to avoid the "stuck after authenticated"
    // bug that happens when WhatsApp updates its frontend and breaks Store injection.
    // Source: https://github.com/wppconnect-team/wa-version
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1037994907-alpha.html'
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
  let readyBootstrapInFlight = false;

  client.on('qr', qr => {
    stopDisconnectRecovery();
    readyBootstrapInFlight = false;
    sessionState.status = 'qr_required';
    sessionState.qr = qr;
    sessionState.lastError = '';
    qrcodeTerminal.generate(qr, { small: true });
    console.log('[whatsapp-webjs-bridge] QR recebido. Escaneie no celular.');
    broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
  });

  client.on('authenticated', () => {
    stopDisconnectRecovery();
    readyBootstrapInFlight = false;
    sessionState.status = 'authenticated';
    sessionState.qr = null;
    sessionState.lastError = '';
    console.log('[whatsapp-webjs-bridge] Sessao autenticada. Aguardando WhatsApp Web carregar (Store)...');
    broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
  });

  client.on('loading_screen', (percent: number, message: string) => {
    console.log(`[whatsapp-webjs-bridge] loading_screen ${percent}%: ${message}`);
  });

  client.on('change_state', (state: string) => {
    console.log(`[whatsapp-webjs-bridge] change_state: ${state}`);
  });

  const refreshLabelsAndBroadcast = async (
    reason: string,
    options: { linkedChatResolutionLimit?: number } = {}
  ): Promise<void> => {
    try {
      const labels = await contactsService.loadLabels({
        linkedChatResolutionLimit: options.linkedChatResolutionLimit
      });
      const serialized = JSON.stringify(labels);
      if (serialized === lastLabelsJson) {
        return;
      }
      lastLabelsJson = serialized;
      broadcaster.broadcast('labels_updated', { labels });
      console.log(`[whatsapp-webjs-bridge] labels_updated (${labels.length}, reason=${reason})`);
    } catch (error) {
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
    recoveryBudget.reset();
    const duplicateReadyWhileBootstrapping = sessionState.status === 'ready' && readyBootstrapInFlight;
    sessionState.status = 'ready';
    sessionState.qr = null;
    sessionState.lastError = '';
    if (duplicateReadyWhileBootstrapping) {
      console.log('[whatsapp-webjs-bridge] Cliente pronto (evento duplicado ignorado).');
      broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
      return;
    }

    readyBootstrapInFlight = true;
    console.log('[whatsapp-webjs-bridge] Cliente pronto.');
    broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
    startLabelsWarmup();

    try {
      const clientWithChats = client as unknown as { getChats: () => Promise<Parameters<typeof contactsService.refreshContactsFromChats>[0] extends infer R ? NonNullable<R> : never> };
      const chats = await clientWithChats.getChats();
      await contactsService.triggerRefresh({ preloadedChats: chats, reason: 'ready' });
      await ingestionService.seedEventsFromRecentChats(chats);
    } catch (error) {
      console.error('[whatsapp-webjs-bridge] Falha ao carregar contatos:', (error as { message?: string } | null)?.message || String(error));
    } finally {
      readyBootstrapInFlight = false;
    }
  });

  client.on('auth_failure', (message: string) => {
    stopDisconnectRecovery();
    readyBootstrapInFlight = false;
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
    readyBootstrapInFlight = false;
    sessionState.status = 'disconnected';
    sessionState.qr = null;
    const reasonText = String(reason || 'Disconnected');
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
      sessionState.status = 'init_error';
      sessionState.lastError = `Sessao do WhatsApp nao respondeu apos ${recoveryBudget.attemptsInWindow}/${recoveryBudget.maxAttemptsAllowed} tentativas automaticas. Clique em "Tentar novamente" para reiniciar a conexao.`;
      console.error('[whatsapp-webjs-bridge] Limite de auto-recuperacao excedido apos desconexao transitória.');
      broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
      return;
    }

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
