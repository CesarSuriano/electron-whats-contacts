import { randomUUID } from 'crypto';
import type { Client as WebJsClient } from 'whatsapp-web.js';
import type {
  HistoryDiagnostics,
  RawChat,
  RawMessage,
  WhatsappEvent
} from '../domain/types.js';
import { SessionState } from '../state/SessionState.js';
import { LidMap } from '../state/LidMap.js';
import { SelfJidResolver } from './SelfJidResolver.js';
import { normalizePhone } from '../utils/phone.js';
import {
  isPersonalJid,
  isPersonalOrLinkedJid,
  isSameConversationJid,
  isValidPersonalJid
} from '../utils/jid.js';
import { isBlankMessage, isIgnoredWhatsappMessage, resolveMessagePreviewText } from '../utils/message.js';
import { resolveLidFromPhone, resolvePhoneFromLid } from '../utils/lidResolver.js';
import { withTimeout } from '../utils/time.js';

export interface HistoryServiceOptions {
  enableHistoryEvents?: boolean;
}

const HISTORY_CHAT_LIMIT = 40;
const HISTORY_MESSAGES_PER_CHAT = 8;
const HISTORY_CACHE_TTL_MS = 30000;
const HISTORY_FETCH_TIMEOUT_MS = 1800;
const HISTORY_FAILURE_LIMIT = 6;
const HISTORY_FAILURE_WINDOW_MS = 60000;
const HISTORY_COOLDOWN_MS = 120000;
const CHAT_HISTORY_COOLDOWN_MS = 5 * 60 * 1000;
const HISTORY_ENDPOINT_CONCURRENCY = 4;
const HISTORY_SHORT_CIRCUIT_MIN_MESSAGES = 30;

type WebJsClientWithChats = WebJsClient & {
  getChats: () => Promise<RawChat[]>;
  getChatById: (id: string) => Promise<RawChat | null | undefined>;
  pupPage?: {
    evaluate: <T>(pageFunction: (...args: unknown[]) => T | Promise<T>, ...args: unknown[]) => Promise<T>;
  };
};

export class HistoryService {
  private readonly failureState = {
    windowStartedAt: 0,
    failures: 0,
    disabledUntil: 0
  };
  private readonly chatHistoryDisabledUntil = new Map<string, number>();
  private historyCache = {
    fetchedAt: 0,
    events: [] as WhatsappEvent[]
  };
  private activeHistoryRequests = 0;
  private readonly historyRequestQueue: Array<() => void> = [];

  constructor(
    private readonly client: WebJsClient,
    private readonly sessionState: SessionState,
    private readonly lidMap: LidMap,
    private readonly selfJidResolver: SelfJidResolver,
    private readonly options: HistoryServiceOptions = {}
  ) {}

  async acquireHistorySlot(): Promise<void> {
    if (this.activeHistoryRequests < HISTORY_ENDPOINT_CONCURRENCY) {
      this.activeHistoryRequests += 1;
      return;
    }

    await new Promise<void>(resolve => {
      this.historyRequestQueue.push(resolve);
    });
    this.activeHistoryRequests += 1;
  }

  releaseHistorySlot(): void {
    this.activeHistoryRequests = Math.max(0, this.activeHistoryRequests - 1);
    const next = this.historyRequestQueue.shift();
    if (next) {
      next();
    }
  }

  private registerHistoryFailure(): void {
    const now = Date.now();
    if (!this.failureState.windowStartedAt || now - this.failureState.windowStartedAt > HISTORY_FAILURE_WINDOW_MS) {
      this.failureState.windowStartedAt = now;
      this.failureState.failures = 0;
    }

    this.failureState.failures += 1;
    if (this.failureState.failures >= HISTORY_FAILURE_LIMIT) {
      this.failureState.disabledUntil = now + HISTORY_COOLDOWN_MS;
      console.warn('[whatsapp-webjs-bridge] Historico temporariamente desativado por falhas repetidas.');
    }
  }

  private disableChatHistoryTemporarily(chatJid: string): void {
    if (!chatJid) {
      return;
    }
    this.chatHistoryDisabledUntil.set(chatJid, Date.now() + CHAT_HISTORY_COOLDOWN_MS);
  }

  private isChatHistoryTemporarilyDisabled(chatJid: string, now: number): boolean {
    const disabledUntil = this.chatHistoryDisabledUntil.get(chatJid) || 0;
    if (!disabledUntil) {
      return false;
    }

    if (disabledUntil <= now) {
      this.chatHistoryDisabledUntil.delete(chatJid);
      return false;
    }

    return true;
  }

  private async discoverConfirmedLidForHistory(requestedJid: string): Promise<string> {
    if (!isPersonalJid(requestedJid) || !isValidPersonalJid(requestedJid)) {
      return '';
    }

    try {
      const discoveredLid = await resolveLidFromPhone(this.client, requestedJid);
      if (!discoveredLid) {
        return '';
      }

      const roundTripPhone = await resolvePhoneFromLid(this.client, discoveredLid);
      if (!roundTripPhone || !isSameConversationJid(roundTripPhone, requestedJid)) {
        return '';
      }

      return discoveredLid;
    } catch {
      return '';
    }
  }

  async resolveChatsForHistory(requestedJid: string): Promise<RawChat[]> {
    if (!requestedJid) {
      return [];
    }

    const clientWithChats = this.client as WebJsClientWithChats;
    const candidates = new Set<string>([requestedJid]);
    const requestedPhone = normalizePhone(requestedJid);

    if (requestedPhone) {
      candidates.add(`${requestedPhone}@c.us`);
    }

    if (isPersonalJid(requestedJid)) {
      const knownLid = this.lidMap.getLid(requestedJid);
      if (knownLid) {
        candidates.add(knownLid);
      } else {
        const discoveredLid = await this.discoverConfirmedLidForHistory(requestedJid);
        if (discoveredLid) {
          this.lidMap.set(requestedJid, discoveredLid);
          candidates.add(discoveredLid);
        }
      }
    }

    const resolved: RawChat[] = [];
    const seen = new Set<string>();
    const addChat = (chat: RawChat | null | undefined): void => {
      const chatId = chat?.id?._serialized || '';
      if (!chat || !chatId || seen.has(chatId)) {
        return;
      }
      seen.add(chatId);
      resolved.push(chat);
    };

    for (const candidate of candidates) {
      try {
        const byId = await withTimeout(
          clientWithChats.getChatById(candidate),
          9000,
          `getChatById(${candidate})`
        );
        addChat(byId);
      } catch {
        // Ignore and continue with next strategy.
      }
    }

    let chats: RawChat[] = [];
    try {
      chats = await withTimeout(clientWithChats.getChats(), 12000, 'getChats(resolveChatsForHistory)');
    } catch {
      return resolved;
    }

    for (const chat of chats) {
      const chatJid = chat?.id?._serialized || '';
      if (!chatJid) {
        continue;
      }

      if (isSameConversationJid(chatJid, requestedJid)) {
        addChat(chat);
        continue;
      }

      if (
        requestedPhone
        && isPersonalOrLinkedJid(chatJid)
        && normalizePhone(chatJid) === requestedPhone
      ) {
        addChat(chat);
      }
    }

    return resolved;
  }

  async fetchMessagesFromStore(chatId: string, limit: number): Promise<RawMessage[]> {
    if (!chatId) {
      return [];
    }

    const normalizedLimit = Math.max(1, Math.min(300, Number(limit || 120)));
    const clientWithPage = this.client as WebJsClientWithChats;
    if (!clientWithPage.pupPage) {
      return [];
    }

    return withTimeout(
      clientWithPage.pupPage.evaluate(async (targetChatId: unknown, targetLimit: unknown) => {
        type StoreModel = {
          id?: { _serialized?: string; fromMe?: boolean; remote?: { _serialized?: string } | string };
          t?: number;
          timestamp?: number;
          isNotification?: boolean;
          fromMe?: boolean | number;
          body?: string;
          type?: string;
          isMedia?: boolean;
          isMMS?: boolean;
          mediaData?: { mimetype?: string; filename?: string };
          mimetype?: string;
          filename?: string;
          chat?: { id?: { _serialized?: string } };
          chatId?: { _serialized?: string };
          from?: string;
          to?: string;
        };
        type StoreCollection<T> = {
          getModelsArray?: () => T[];
          models?: T[];
          loadEarlierMsgs?: () => Promise<T[] | null>;
        };
        type StoreChat = {
          id?: { _serialized?: string };
          msgs?: StoreCollection<StoreModel>;
        };
        type StoreShape = {
          Chat?: {
            getModelsArray?: () => StoreChat[];
            get?: (wid: unknown) => StoreChat | null;
            find?: (wid: unknown) => Promise<StoreChat | null>;
          };
          WidFactory?: { createWid?: (id: string) => unknown };
          Msg?: { getModelsArray?: () => StoreModel[] };
          Cmd?: {
            openChatBottom?: (chat: StoreChat) => Promise<unknown>;
            openChatAt?: (chat: StoreChat, index: number) => Promise<unknown>;
            openChat?: (chat: StoreChat) => Promise<unknown>;
          };
          ConversationMsgs?: {
            loadEarlierMsgs?: (chat: StoreChat, msgs?: StoreCollection<StoreModel>) => Promise<StoreModel[] | null>;
          };
        };
        type WWebJsShape = {
          getMessageModel?: (model: StoreModel) => unknown;
        };
        const store = (window as unknown as { Store?: StoreShape }).Store;
        const wWebJs = (window as unknown as { WWebJS?: WWebJsShape }).WWebJS;

        const getModelsArray = <T>(collection: StoreCollection<T> | undefined | null): T[] => {
          if (!collection) {
            return [];
          }
          if (typeof collection.getModelsArray === 'function') {
            return collection.getModelsArray();
          }
          if (Array.isArray(collection.models)) {
            return collection.models;
          }
          return [];
        };

        const readTimestamp = (model: StoreModel | null | undefined): number =>
          Number(model?.t || model?.timestamp || 0);
        const isNotification = (model: StoreModel | null | undefined): boolean =>
          Boolean(model?.isNotification);
        const normalizeDigits = (value: unknown): string => String(value || '')
          .split('@')[0]
          .split(':')[0]
          .replace(/\D/g, '');
        const isPersonalOrLinked = (value: unknown): boolean => {
          const jid = String(value || '');
          return jid.endsWith('@c.us') || jid.endsWith('@lid');
        };
        const targetPhone = normalizeDigits(targetChatId);
        const resolveFromMe = (model: StoreModel | null | undefined): boolean => {
          if (typeof model?.id?.fromMe === 'boolean') {
            return model.id.fromMe;
          }
          if (typeof model?.fromMe === 'boolean') {
            return model.fromMe;
          }
          if (typeof model?.fromMe === 'number') {
            return model.fromMe === 1;
          }
          return false;
        };
        const waitMs = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

        const allChats = store?.Chat?.getModelsArray ? store.Chat.getModelsArray() : [];
        const candidateIds = new Set<string>([String(targetChatId)]);

        if (targetPhone) {
          allChats.forEach(model => {
            const serialized = model?.id?._serialized || '';
            if (!serialized) {
              return;
            }
            if (normalizeDigits(serialized) === targetPhone) {
              candidateIds.add(serialized);
            }
          });
        }

        const resolveChat = async (candidateId: string): Promise<StoreChat | null> => {
          if (!candidateId) {
            return null;
          }

          let wid: unknown = null;
          if (store?.WidFactory?.createWid) {
            try {
              wid = store.WidFactory.createWid(candidateId);
            } catch {
              wid = null;
            }
          }

          let chat: StoreChat | null = null;
          if (store?.Chat?.get) {
            chat = store.Chat.get(wid || candidateId) || null;
          }

          if (!chat && store?.Chat?.find) {
            try {
              chat = await store.Chat.find(wid || candidateId);
            } catch {
              chat = null;
            }
          }

          if (!chat && allChats.length) {
            chat = allChats.find(model => (model?.id?._serialized || '') === candidateId) || null;
          }

          return chat;
        };

        const resolvedChats: StoreChat[] = [];
        const seenChatIds = new Set<string>();
        for (const candidateId of candidateIds) {
          const chat = await resolveChat(candidateId);
          const serialized = chat?.id?._serialized || '';
          if (!chat || !serialized || seenChatIds.has(serialized)) {
            continue;
          }
          seenChatIds.add(serialized);
          resolvedChats.push(chat);
        }

        if (!resolvedChats.length) {
          return [];
        }

        const conversationMsgs = store?.ConversationMsgs;
        const canLoadEarlier = Boolean(conversationMsgs && typeof conversationMsgs.loadEarlierMsgs === 'function');
        const mergedById = new Map<string, StoreModel>();

        const appendMessages = (chunk: StoreModel[] | null | undefined): void => {
          (chunk || []).forEach(model => {
            if (!model || isNotification(model)) {
              return;
            }

            const serializedId = model?.id?._serialized || '';
            const syntheticId = serializedId || `ts:${readTimestamp(model)}:${mergedById.size}`;
            if (!mergedById.has(syntheticId)) {
              mergedById.set(syntheticId, model);
            }
          });
        };

        const targetLimitNumber = Number(targetLimit);
        for (const chat of resolvedChats) {
          let msgs = getModelsArray(chat?.msgs).filter(model => !isNotification(model));
          appendMessages(msgs);

          if (msgs.length <= 1) {
            try {
              if (store?.Cmd?.openChatBottom) {
                await store.Cmd.openChatBottom(chat);
              } else if (store?.Cmd?.openChatAt) {
                await store.Cmd.openChatAt(chat, 0);
              } else if (store?.Cmd?.openChat) {
                await store.Cmd.openChat(chat);
              }
            } catch {
              // Ignore warm-up failures and keep trying legacy loaders.
            }

            try {
              await new Promise(resolve => setTimeout(resolve, 120));
            } catch {
              // Ignore delay failures.
            }

            msgs = getModelsArray(chat?.msgs).filter(model => !isNotification(model));
            appendMessages(msgs);
          }

          const chatMsgsCollection = chat?.msgs;
          const canLoadEarlierFromChatMsgs = Boolean(chatMsgsCollection && typeof chatMsgsCollection.loadEarlierMsgs === 'function');

          if (canLoadEarlierFromChatMsgs && chatMsgsCollection) {
            let rounds = 0;
            let emptyRounds = 0;
            while (msgs.length < targetLimitNumber && rounds < 120 && emptyRounds < 6) {
              rounds += 1;

              let loaded: StoreModel[] | null = null;
              try {
                loaded = await chatMsgsCollection.loadEarlierMsgs!();
              } catch {
                loaded = null;
              }

              const refreshed = getModelsArray(chatMsgsCollection).filter(model => !isNotification(model));
              if (refreshed.length > msgs.length) {
                msgs = refreshed;
                appendMessages(refreshed);
                emptyRounds = 0;
                continue;
              }

              if (!loaded || !loaded.length) {
                emptyRounds += 1;
                await waitMs(120);
                continue;
              }

              msgs = [...loaded, ...msgs].filter(model => !isNotification(model));
              appendMessages(loaded);
              emptyRounds = 0;
            }
          }

          if (canLoadEarlier && conversationMsgs) {
            let rounds = 0;
            let emptyRounds = 0;
            while (msgs.length < targetLimitNumber && rounds < 80 && emptyRounds < 6) {
              rounds += 1;

              let loaded: StoreModel[] | null = null;
              try {
                loaded = await conversationMsgs.loadEarlierMsgs!(chat, chat.msgs);
              } catch {
                try {
                  loaded = await conversationMsgs.loadEarlierMsgs!(chat);
                } catch {
                  loaded = null;
                }
              }

              const refreshed = getModelsArray(chat?.msgs).filter(model => !isNotification(model));
              if (refreshed.length > msgs.length) {
                msgs = refreshed;
                appendMessages(refreshed);
                emptyRounds = 0;
                continue;
              }

              if (!loaded || !loaded.length) {
                emptyRounds += 1;
                await waitMs(120);
                continue;
              }

              msgs = [...loaded, ...msgs].filter(model => !isNotification(model));
              appendMessages(loaded);
              emptyRounds = 0;
            }
          }
        }

        if (mergedById.size <= 1 && targetPhone && store?.Msg?.getModelsArray) {
          const globalMsgs = store.Msg.getModelsArray();
          globalMsgs.forEach(model => {
            const remoteField = model?.id?.remote;
            const remoteCandidates = [
              typeof remoteField === 'object' ? remoteField?._serialized : remoteField,
              model?.chat?.id?._serialized,
              model?.chatId?._serialized,
              model?.from,
              model?.to
            ];

            const match = remoteCandidates.some(candidate => {
              if (!candidate || !isPersonalOrLinked(candidate)) {
                return false;
              }
              return normalizeDigits(candidate) === targetPhone;
            });

            if (match) {
              appendMessages([model]);
            }
          });
        }

        let msgs = Array.from(mergedById.values());
        msgs.sort((a, b) => readTimestamp(a) - readTimestamp(b));
        if (msgs.length > targetLimitNumber) {
          msgs = msgs.slice(msgs.length - targetLimitNumber);
        }

        return msgs.map(model => {
          if (wWebJs?.getMessageModel) {
            try {
              return wWebJs.getMessageModel(model);
            } catch {
              // Fall through to manual serialization.
            }
          }

          return {
            id: model?.id,
            body: typeof model?.body === 'string' ? model.body : '',
            timestamp: readTimestamp(model),
            fromMe: resolveFromMe(model),
            type: model?.type || '',
            hasMedia: Boolean(model?.isMedia || model?.mediaData || model?.isMMS),
            _data: {
              mimetype: model?.mimetype || model?.mediaData?.mimetype || '',
              filename: model?.filename || model?.mediaData?.filename || ''
            }
          };
        });
      }, chatId, normalizedLimit),
      25000,
      `fetchMessagesFromStore(${chatId})`
    ) as Promise<RawMessage[]>;
  }

  async fetchChatHistoryWithRecovery(
    chat: RawChat,
    requestedJid: string,
    limit: number,
    diagnostics: HistoryDiagnostics | null = null
  ): Promise<RawMessage[]> {
    if (!chat || typeof chat.fetchMessages !== 'function') {
      throw new Error('Resolved chat does not support fetchMessages');
    }

    const clientWithChats = this.client as WebJsClientWithChats;

    const setDiagnostics = <K extends keyof HistoryDiagnostics>(key: K, value: HistoryDiagnostics[K]): void => {
      if (diagnostics) {
        diagnostics[key] = value;
      }
    };

    let history: RawMessage[] = [];
    let lastError: unknown = null;
    let historySource = 'none';

    try {
      const fetchedHistory = await withTimeout(
        chat.fetchMessages({ limit }),
        15000,
        `fetchMessages(${requestedJid})`
      );
      history = Array.isArray(fetchedHistory) ? fetchedHistory : [];
      if (history.length > 0) {
        historySource = 'fetchMessages';
      }
      setDiagnostics('fetchMessagesCount', history.length);
    } catch (error) {
      lastError = error;
      setDiagnostics('fetchMessagesError', (error as { message?: string } | null)?.message || String(error));
    }

    const shortCircuitThreshold = Math.min(limit, HISTORY_SHORT_CIRCUIT_MIN_MESSAGES);
    if (Array.isArray(history) && history.length >= shortCircuitThreshold) {
      setDiagnostics('finalSource', historySource);
      setDiagnostics('finalCount', history.length);
      console.log(
        '[whatsapp-webjs-bridge] history',
        requestedJid,
        'source=', historySource,
        'count=', history.length,
        'limit=', limit
      );
      return history;
    }

    setDiagnostics('syncHistoryAttempted', typeof chat.syncHistory === 'function');
    if (typeof chat.syncHistory === 'function') {
      try {
        await withTimeout(
          chat.syncHistory(),
          20000,
          `syncHistory(${requestedJid})`
        );

        const syncedHistory = await withTimeout(
          chat.fetchMessages({ limit }),
          15000,
          `fetchMessages(${requestedJid}) after syncHistory`
        );

        const syncedCount = Array.isArray(syncedHistory) ? syncedHistory.length : 0;
        setDiagnostics('syncFetchCount', syncedCount);

        if (Array.isArray(syncedHistory) && syncedHistory.length > (Array.isArray(history) ? history.length : 0)) {
          history = syncedHistory;
          historySource = 'syncHistory';
        }
      } catch (error) {
        lastError = error;
        setDiagnostics('syncHistoryError', (error as { message?: string } | null)?.message || String(error));
      }
    }

    const resolvedChatId = chat.id?._serialized || '';
    setDiagnostics('resolvedChatId', resolvedChatId);
    if (resolvedChatId) {
      try {
        const freshChat = await withTimeout(
          clientWithChats.getChatById(resolvedChatId),
          12000,
          `getChatById(${resolvedChatId}) refresh`
        );

        if (freshChat && typeof freshChat.fetchMessages === 'function') {
          const refreshedHistory = await withTimeout(
            freshChat.fetchMessages({ limit }),
            15000,
            `fetchMessages(${resolvedChatId}) refresh`
          );

          const refreshedCount = Array.isArray(refreshedHistory) ? refreshedHistory.length : 0;
          setDiagnostics('refreshFetchCount', refreshedCount);

          if (Array.isArray(refreshedHistory) && refreshedHistory.length > (Array.isArray(history) ? history.length : 0)) {
            history = refreshedHistory;
            historySource = 'refreshChat';
          }
        }
      } catch (error) {
        lastError = error;
        setDiagnostics('refreshError', (error as { message?: string } | null)?.message || String(error));
      }
    }

    const shouldTryStoreFallback = !Array.isArray(history) || history.length <= 1;
    setDiagnostics('storeFallbackAttempted', shouldTryStoreFallback);
    if (shouldTryStoreFallback) {
      const storeHistory = await this.fetchMessagesFromStore(resolvedChatId || requestedJid, limit)
        .catch(error => {
          lastError = error;
          setDiagnostics('storeFallbackError', (error as { message?: string } | null)?.message || String(error));
          return [] as RawMessage[];
        });

      const storeCount = Array.isArray(storeHistory) ? storeHistory.length : 0;
      setDiagnostics('storeFallbackCount', storeCount);

      if (Array.isArray(storeHistory) && storeHistory.length > (Array.isArray(history) ? history.length : 0)) {
        history = storeHistory;
        historySource = 'storeFallback';
      }
    }

    if ((!Array.isArray(history) || history.length === 0) && lastError) {
      setDiagnostics('finalSource', historySource);
      setDiagnostics('finalCount', 0);
      setDiagnostics('fatalError', (lastError as { message?: string } | null)?.message || String(lastError));
      throw lastError;
    }

    setDiagnostics('finalSource', historySource);
    setDiagnostics('finalCount', Array.isArray(history) ? history.length : 0);
    console.log(
      '[whatsapp-webjs-bridge] history',
      requestedJid,
      'source=', historySource,
      'count=', Array.isArray(history) ? history.length : 0,
      'limit=', limit
    );
    return Array.isArray(history) ? history : [];
  }

  async loadRecentChatEvents(limit: number): Promise<WhatsappEvent[]> {
    if (this.options.enableHistoryEvents === false) {
      return [];
    }

    if (!this.sessionState.isReady()) {
      return [];
    }

    const now = Date.now();
    if (this.failureState.disabledUntil > now) {
      return [];
    }

    if (this.historyCache.events.length && now - this.historyCache.fetchedAt < HISTORY_CACHE_TTL_MS) {
      return this.historyCache.events.slice(0, limit);
    }

    const clientWithChats = this.client as WebJsClientWithChats;
    let chats: RawChat[] = [];
    try {
      chats = await clientWithChats.getChats();
    } catch (error) {
      console.warn('[whatsapp-webjs-bridge] Falha ao obter chats para /events:', (error as { message?: string } | null)?.message || String(error));
      return [];
    }

    const personalChats = chats
      .filter(chat => !chat.isGroup && isValidPersonalJid(chat.id?._serialized))
      .filter(chat => !this.selfJidResolver.isSelfJid(chat.id?._serialized || ''))
      .filter(chat => !this.isChatHistoryTemporarilyDisabled(chat.id?._serialized || '', now))
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, HISTORY_CHAT_LIMIT);

    const historyEvents: WhatsappEvent[] = [];

    for (const chat of personalChats) {
      const chatJid = chat.id?._serialized || '';
      if (!chatJid || typeof chat.fetchMessages !== 'function') {
        continue;
      }

      try {
        const recent = await withTimeout(
          chat.fetchMessages({ limit: HISTORY_MESSAGES_PER_CHAT }),
          HISTORY_FETCH_TIMEOUT_MS,
          `fetching history for ${chatJid}`
        );
        recent
          .filter(message => !isIgnoredWhatsappMessage(message) && !isBlankMessage(message))
          .forEach(message => {
            const mediaMimetype = typeof message?._data?.mimetype === 'string' ? message._data.mimetype : '';
            const mediaFilename = typeof message?._data?.filename === 'string' ? message._data.filename : '';
            const sentAt = typeof message.timestamp === 'number' && message.timestamp > 0
              ? new Date(message.timestamp * 1000).toISOString()
              : new Date().toISOString();

            const ack = typeof message.ack === 'number' ? message.ack : null;
            const messageIdSerialized = typeof message.id === 'object' && message.id?._serialized
              ? message.id._serialized
              : '';

            historyEvents.push({
              id: messageIdSerialized || randomUUID(),
              source: 'webjs-history',
              receivedAt: sentAt,
              isFromMe: this.selfJidResolver.resolveIsFromMe(message),
              chatJid,
              phone: normalizePhone(chatJid),
              text: resolveMessagePreviewText(message),
              ack,
              payload: {
                id: messageIdSerialized,
                timestamp: message.timestamp || 0,
                type: message.type || '',
                hasMedia: Boolean(message.hasMedia),
                mediaMimetype,
                mediaFilename,
                mediaDataUrl: null,
                ack
              }
            });
          });
      } catch (error) {
        this.registerHistoryFailure();
        this.disableChatHistoryTemporarily(chatJid);
        console.warn('[whatsapp-webjs-bridge] Falha ao buscar historico do chat', chatJid, (error as { message?: string } | null)?.message || String(error));
      }
    }

    const dedup = new Map<string, WhatsappEvent>();
    historyEvents.forEach(event => {
      if (!dedup.has(event.id)) {
        dedup.set(event.id, event);
      }
    });

    const normalized = Array.from(dedup.values()).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    this.historyCache.fetchedAt = now;
    this.historyCache.events = normalized;

    return normalized.slice(0, limit);
  }
}
