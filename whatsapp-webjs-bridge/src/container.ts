import pkg from 'whatsapp-web.js';
import type { Client as WebJsClient } from 'whatsapp-web.js';
import qrcodeTerminal from 'qrcode-terminal';
import type { BridgeConfig } from './config.js';
import { SessionState } from './state/SessionState.js';
import { EventStore } from './state/EventStore.js';
import { ContactStore } from './state/ContactStore.js';
import { LidMap } from './state/LidMap.js';
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

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: config.instanceName, dataPath: config.dataPath }),
    puppeteer: puppeteerOptions
  });

  const selfJidResolver = new SelfJidResolver(client);
  const sessionState = new SessionState(config.instanceName, () => selfJidResolver.getOwnJid());
  const eventStore = new EventStore();
  const contactStore = new ContactStore();
  const lidMap = new LidMap();

  const sessionManager = new SessionManager(client, sessionState, selfJidResolver, config.instanceName);
  const contactsService = new ContactsService(client, sessionState, contactStore, lidMap, selfJidResolver, {
    enableProfilePhotoFetch: config.enableProfilePhotoFetch
  });
  const historyService = new HistoryService(client, sessionState, lidMap, selfJidResolver, {
    enableHistoryEvents: config.enableHistoryEvents
  });
  const messageService = new MessageService(client, sessionState, eventStore, contactStore, selfJidResolver);
  const ingestionService = new IngestionService(
    client,
    sessionState,
    eventStore,
    contactStore,
    lidMap,
    selfJidResolver
  );

  const broadcaster = new WebSocketBroadcaster();

  const controllers = {
    health: new HealthController(),
    session: new SessionController(sessionManager, sessionState),
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
    selfJidResolver
  } = container;

  client.on('qr', qr => {
    sessionState.status = 'qr_required';
    sessionState.qr = qr;
    sessionState.lastError = '';
    qrcodeTerminal.generate(qr, { small: true });
    console.log('[whatsapp-webjs-bridge] QR recebido. Escaneie no celular.');
    broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
  });

  client.on('authenticated', () => {
    sessionState.status = 'authenticated';
    sessionState.qr = null;
    sessionState.lastError = '';
    console.log('[whatsapp-webjs-bridge] Sessao autenticada.');
    broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
  });

  client.on('ready', async () => {
    sessionState.status = 'ready';
    sessionState.qr = null;
    sessionState.lastError = '';
    console.log('[whatsapp-webjs-bridge] Cliente pronto.');
    broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());

    try {
      const clientWithChats = client as unknown as { getChats: () => Promise<Parameters<typeof contactsService.refreshContactsFromChats>[0] extends infer R ? NonNullable<R> : never> };
      const chats = await clientWithChats.getChats();
      await contactsService.triggerRefresh({ preloadedChats: chats, reason: 'ready' });
      await ingestionService.seedEventsFromRecentChats(chats);
    } catch (error) {
      console.error('[whatsapp-webjs-bridge] Falha ao carregar contatos:', (error as { message?: string } | null)?.message || String(error));
    }
  });

  client.on('auth_failure', (message: string) => {
    sessionState.status = 'auth_failure';
    sessionState.lastError = String(message || 'Authentication failure');
    console.error('[whatsapp-webjs-bridge] Falha de autenticacao:', message);
    broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
  });

  client.on('disconnected', (reason: string) => {
    sessionState.status = 'disconnected';
    sessionState.lastError = String(reason || 'Disconnected');
    console.warn('[whatsapp-webjs-bridge] Cliente desconectado:', reason);
    broadcaster.broadcast('session_state', sessionManager.getSessionSnapshot());
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
}
