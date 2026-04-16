/**
 * Chat history fetching, caching, and failure-circuit-breaker logic.
 * Call init(client, sessionState, options) once the client is available.
 */

import { randomUUID } from 'crypto';
import {
  withTimeout,
  normalizePhone,
  isPersonalJid,
  isPersonalOrLinkedJid,
  isSameConversationJid,
  isValidPersonalJid,
  isBlankMessage,
  resolveMessagePreviewText,
  toIsoFromUnixTimestamp
} from './utils.js';
import { resolveIsFromMe } from './jid.js';
import { lidByPhoneJid } from './events.js';

const HISTORY_CHAT_LIMIT = 40;
const HISTORY_MESSAGES_PER_CHAT = 8;
const HISTORY_CACHE_TTL_MS = 30000;
const HISTORY_FETCH_TIMEOUT_MS = 1800;
const HISTORY_FAILURE_LIMIT = 6;
const HISTORY_FAILURE_WINDOW_MS = 60000;
const HISTORY_COOLDOWN_MS = 120000;
const CHAT_HISTORY_COOLDOWN_MS = 5 * 60 * 1000;
const HISTORY_ENDPOINT_CONCURRENCY = 4;

let _client = null;
let _sessionState = null;
let _enableHistoryEvents = true;

export function init(client, sessionState, { enableHistoryEvents = true } = {}) {
  _client = client;
  _sessionState = sessionState;
  _enableHistoryEvents = enableHistoryEvents;
}

const historyFailureState = {
  windowStartedAt: 0,
  failures: 0,
  disabledUntil: 0
};
const chatHistoryDisabledUntil = new Map();
const historyCache = {
  fetchedAt: 0,
  events: []
};

let activeHistoryRequests = 0;
const historyRequestQueue = [];

export async function acquireHistorySlot() {
  if (activeHistoryRequests < HISTORY_ENDPOINT_CONCURRENCY) {
    activeHistoryRequests += 1;
    return;
  }

  await new Promise(resolve => {
    historyRequestQueue.push(resolve);
  });
  activeHistoryRequests += 1;
}

export function releaseHistorySlot() {
  activeHistoryRequests = Math.max(0, activeHistoryRequests - 1);
  const next = historyRequestQueue.shift();
  if (next) {
    next();
  }
}

export function registerHistoryFailure() {
  const now = Date.now();
  if (!historyFailureState.windowStartedAt || now - historyFailureState.windowStartedAt > HISTORY_FAILURE_WINDOW_MS) {
    historyFailureState.windowStartedAt = now;
    historyFailureState.failures = 0;
  }

  historyFailureState.failures += 1;
  if (historyFailureState.failures >= HISTORY_FAILURE_LIMIT) {
    historyFailureState.disabledUntil = now + HISTORY_COOLDOWN_MS;
    console.warn('[whatsapp-webjs-bridge] Historico temporariamente desativado por falhas repetidas.');
  }
}

export function disableChatHistoryTemporarily(chatJid) {
  if (!chatJid) {
    return;
  }

  chatHistoryDisabledUntil.set(chatJid, Date.now() + CHAT_HISTORY_COOLDOWN_MS);
}

export function isChatHistoryTemporarilyDisabled(chatJid, now) {
  const disabledUntil = chatHistoryDisabledUntil.get(chatJid) || 0;
  if (!disabledUntil) {
    return false;
  }

  if (disabledUntil <= now) {
    chatHistoryDisabledUntil.delete(chatJid);
    return false;
  }

  return true;
}

export async function resolveChatForHistory(requestedJid) {
  if (!requestedJid) {
    return null;
  }

  const candidates = [requestedJid];
  if (isPersonalJid(requestedJid)) {
    const knownLid = lidByPhoneJid.get(requestedJid);
    if (knownLid && !candidates.includes(knownLid)) {
      candidates.push(knownLid);
    }
  }

  for (const candidate of candidates) {
    try {
      const byId = await withTimeout(
        _client.getChatById(candidate),
        9000,
        `getChatById(${candidate})`
      );
      if (byId) {
        return byId;
      }
    } catch {
      // Ignore and continue with next strategy.
    }
  }

  let chats = [];
  try {
    chats = await withTimeout(_client.getChats(), 12000, 'getChats(resolveChatForHistory)');
  } catch {
    return null;
  }

  const exact = chats.find(chat => isSameConversationJid(chat.id?._serialized || '', requestedJid));
  if (exact) {
    return exact;
  }

  const requestedPhone = normalizePhone(requestedJid);
  if (requestedPhone) {
    const phoneMatch = chats.find(chat => {
      const chatJid = chat.id?._serialized || '';
      return isPersonalOrLinkedJid(chatJid) && normalizePhone(chatJid) === requestedPhone;
    });
    if (phoneMatch) {
      return phoneMatch;
    }
  }

  return null;
}

export async function resolveChatsForHistory(requestedJid) {
  if (!requestedJid) {
    return [];
  }

  const candidates = new Set([requestedJid]);
  const requestedPhone = normalizePhone(requestedJid);

  if (requestedPhone) {
    candidates.add(`${requestedPhone}@c.us`);
  }

  if (isPersonalJid(requestedJid)) {
    const knownLid = lidByPhoneJid.get(requestedJid);
    if (knownLid) {
      candidates.add(knownLid);
    }
  }

  const resolved = [];
  const seen = new Set();
  const addChat = chat => {
    const chatId = chat?.id?._serialized || '';
    if (!chatId || seen.has(chatId)) {
      return;
    }
    seen.add(chatId);
    resolved.push(chat);
  };

  for (const candidate of candidates) {
    try {
      const byId = await withTimeout(
        _client.getChatById(candidate),
        9000,
        `getChatById(${candidate})`
      );
      addChat(byId);
    } catch {
      // Ignore and continue with next strategy.
    }
  }

  let chats = [];
  try {
    chats = await withTimeout(_client.getChats(), 12000, 'getChats(resolveChatsForHistory)');
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

export async function fetchMessagesFromStore(chatId, limit) {
  if (!chatId) {
    return [];
  }

  const normalizedLimit = Math.max(1, Math.min(300, Number(limit || 120)));

  return withTimeout(
    _client.pupPage.evaluate(async (targetChatId, targetLimit) => {
      const getModelsArray = collection => {
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

      const readTimestamp = model => Number(model?.t || model?.timestamp || 0);
      const isNotification = model => Boolean(model?.isNotification);
      const normalizeDigits = value => String(value || '')
        .split('@')[0]
        .split(':')[0]
        .replace(/\D/g, '');
      const isPersonalOrLinkedJid = value => {
        const jid = String(value || '');
        return jid.endsWith('@c.us') || jid.endsWith('@lid');
      };
      const targetPhone = normalizeDigits(targetChatId);
      const resolveFromMe = model => {
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
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

      const allChats = window.Store?.Chat?.getModelsArray
        ? window.Store.Chat.getModelsArray()
        : [];
      const candidateIds = new Set([targetChatId]);

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

      const resolveChat = async candidateId => {
        if (!candidateId) {
          return null;
        }

        let wid = null;
        if (window.Store?.WidFactory?.createWid) {
          try {
            wid = window.Store.WidFactory.createWid(candidateId);
          } catch {
            wid = null;
          }
        }

        let chat = null;
        if (window.Store?.Chat?.get) {
          chat = window.Store.Chat.get(wid || candidateId) || null;
        }

        if (!chat && window.Store?.Chat?.find) {
          try {
            chat = await window.Store.Chat.find(wid || candidateId);
          } catch {
            chat = null;
          }
        }

        if (!chat && allChats.length) {
          chat = allChats.find(model => (model?.id?._serialized || '') === candidateId) || null;
        }

        return chat;
      };

      const resolvedChats = [];
      const seenChatIds = new Set();
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

      const conversationMsgs = window.Store?.ConversationMsgs;
      const canLoadEarlier = conversationMsgs && typeof conversationMsgs.loadEarlierMsgs === 'function';
      const mergedById = new Map();

      const appendMessages = chunk => {
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

      for (const chat of resolvedChats) {
        let msgs = getModelsArray(chat?.msgs).filter(model => !isNotification(model));
        appendMessages(msgs);

        if (msgs.length <= 1) {
          try {
            if (window.Store?.Cmd?.openChatBottom) {
              await window.Store.Cmd.openChatBottom(chat);
            } else if (window.Store?.Cmd?.openChatAt) {
              await window.Store.Cmd.openChatAt(chat, 0);
            } else if (window.Store?.Cmd?.openChat) {
              await window.Store.Cmd.openChat(chat);
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
        const canLoadEarlierFromChatMsgs = chatMsgsCollection && typeof chatMsgsCollection.loadEarlierMsgs === 'function';

        if (canLoadEarlierFromChatMsgs) {
          let rounds = 0;
          let emptyRounds = 0;
          while (msgs.length < targetLimit && rounds < 120 && emptyRounds < 6) {
            rounds += 1;

            let loaded = null;
            try {
              loaded = await chatMsgsCollection.loadEarlierMsgs();
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
              await wait(120);
              continue;
            }

            msgs = [...loaded, ...msgs].filter(model => !isNotification(model));
            appendMessages(loaded);
            emptyRounds = 0;
          }
        }

        if (canLoadEarlier) {
          let rounds = 0;
          let emptyRounds = 0;
          while (msgs.length < targetLimit && rounds < 80 && emptyRounds < 6) {
            rounds += 1;

            let loaded = null;
            try {
              loaded = await conversationMsgs.loadEarlierMsgs(chat, chat.msgs);
            } catch {
              try {
                loaded = await conversationMsgs.loadEarlierMsgs(chat);
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
              await wait(120);
              continue;
            }

            msgs = [...loaded, ...msgs].filter(model => !isNotification(model));
            appendMessages(loaded);
            emptyRounds = 0;
          }
        }
      }

      if (mergedById.size <= 1 && targetPhone && window.Store?.Msg?.getModelsArray) {
        const globalMsgs = window.Store.Msg.getModelsArray();
        globalMsgs.forEach(model => {
          const remoteCandidates = [
            model?.id?.remote?._serialized,
            model?.id?.remote,
            model?.chat?.id?._serialized,
            model?.chatId?._serialized,
            model?.from,
            model?.to
          ];

          const match = remoteCandidates.some(candidate => {
            if (!candidate || !isPersonalOrLinkedJid(candidate)) {
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
      if (msgs.length > targetLimit) {
        msgs = msgs.slice(msgs.length - targetLimit);
      }

      return msgs.map(model => {
        if (window.WWebJS?.getMessageModel) {
          try {
            return window.WWebJS.getMessageModel(model);
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
  );
}

export async function fetchChatHistoryWithRecovery(chat, requestedJid, limit, diagnostics = null) {
  if (!chat || typeof chat.fetchMessages !== 'function') {
    throw new Error('Resolved chat does not support fetchMessages');
  }

  const setDiagnostics = (key, value) => {
    if (diagnostics) {
      diagnostics[key] = value;
    }
  };

  let history = [];
  let lastError = null;
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
    setDiagnostics('fetchMessagesError', error?.message || String(error));
  }

  if (Array.isArray(history) && history.length > 1) {
    setDiagnostics('finalSource', historySource);
    setDiagnostics('finalCount', history.length);
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
      setDiagnostics('syncHistoryError', error?.message || String(error));
      // Ignore sync errors and keep best available history.
    }
  }

  const resolvedChatId = chat.id?._serialized || '';
  setDiagnostics('resolvedChatId', resolvedChatId);
  if (resolvedChatId) {
    try {
      const freshChat = await withTimeout(
        _client.getChatById(resolvedChatId),
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
      setDiagnostics('refreshError', error?.message || String(error));
      // Ignore refresh errors and keep best available history.
    }
  }

  const shouldTryStoreFallback = !Array.isArray(history) || history.length <= 1;
  setDiagnostics('storeFallbackAttempted', shouldTryStoreFallback);
  if (shouldTryStoreFallback) {
    const storeHistory = await fetchMessagesFromStore(resolvedChatId || requestedJid, limit)
      .catch(error => {
        lastError = error;
        setDiagnostics('storeFallbackError', error?.message || String(error));
        return [];
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
    setDiagnostics('fatalError', lastError?.message || String(lastError));
    throw lastError;
  }

  setDiagnostics('finalSource', historySource);
  setDiagnostics('finalCount', Array.isArray(history) ? history.length : 0);
  return Array.isArray(history) ? history : [];
}

export async function loadRecentChatEvents(limit) {
  if (!_enableHistoryEvents) {
    return [];
  }

  if (_sessionState.status !== 'ready') {
    return [];
  }

  const now = Date.now();
  if (historyFailureState.disabledUntil > now) {
    return [];
  }

  if (historyCache.events.length && now - historyCache.fetchedAt < HISTORY_CACHE_TTL_MS) {
    return historyCache.events.slice(0, limit);
  }

  let chats = [];
  try {
    chats = await _client.getChats();
  } catch (error) {
    console.warn('[whatsapp-webjs-bridge] Falha ao obter chats para /events:', error?.message || String(error));
    return [];
  }

  const personalChats = chats
    .filter(chat => !chat.isGroup && isValidPersonalJid(chat.id?._serialized))
    .filter(chat => !isChatHistoryTemporarilyDisabled(chat.id?._serialized || '', now))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, HISTORY_CHAT_LIMIT);

  const historyEvents = [];

  for (const chat of personalChats) {
    const chatJid = chat.id?._serialized || '';
    if (!chatJid) {
      continue;
    }

    try {
      const recent = await withTimeout(
        chat.fetchMessages({ limit: HISTORY_MESSAGES_PER_CHAT }),
        HISTORY_FETCH_TIMEOUT_MS,
        `fetching history for ${chatJid}`
      );
      recent.filter(message => !message.isNotification && !isBlankMessage(message)).forEach(message => {
        const mediaMimetype = typeof message?._data?.mimetype === 'string' ? message._data.mimetype : '';
        const mediaFilename = typeof message?._data?.filename === 'string' ? message._data.filename : '';
        const sentAt = typeof message.timestamp === 'number' && message.timestamp > 0
          ? new Date(message.timestamp * 1000).toISOString()
          : new Date().toISOString();

        const ack = typeof message.ack === 'number' ? message.ack : null;
        historyEvents.push({
          id: message.id?._serialized || randomUUID(),
          source: 'webjs-history',
          receivedAt: sentAt,
          isFromMe: resolveIsFromMe(message),
          chatJid,
          phone: normalizePhone(chatJid),
          text: resolveMessagePreviewText(message),
          ack,
          payload: {
            id: message.id?._serialized || '',
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
      registerHistoryFailure();
      disableChatHistoryTemporarily(chatJid);
      console.warn('[whatsapp-webjs-bridge] Falha ao buscar historico do chat', chatJid, error?.message || String(error));
      // Ignore individual chat failures to keep the events endpoint stable.
    }
  }

  const dedup = new Map();
  historyEvents.forEach(event => {
    if (!dedup.has(event.id)) {
      dedup.set(event.id, event);
    }
  });

  const normalized = Array.from(dedup.values()).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  historyCache.fetchedAt = now;
  historyCache.events = normalized;

  return normalized.slice(0, limit);
}
