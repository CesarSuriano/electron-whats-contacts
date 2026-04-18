/**
 * Contact loading, photo fetching, and event seeding from recent chats.
 * Call init(client, sessionState, options) once the client is available.
 */

import {
  withTimeout,
  normalizePhone,
  isPersonalJid,
  isValidPersonalJid,
  isPersonalOrLinkedJid,
  isGroupJid,
  isLinkedId,
  brazilianAlternativeJid,
  extractLastMessagePreview,
  toIsoFromUnixTimestamp,
  getContactName
} from './utils.js';
import { resolveIsFromMe, isSelfJid, registerSelfJid } from './jid.js';
import { events, contactsByJid, lidByPhoneJid, pushEvent } from './events.js';

const PHOTO_TTL_MS = 30 * 60 * 1000;
const EVENT_SEED_CHAT_LIMIT = 80;
const EVENT_SEED_COOLDOWN_MS = 60 * 1000;
const LINKED_CHAT_CANONICAL_RESOLVE_LIMIT = 25;
const LINKED_CHAT_CANONICAL_RESOLVE_TIMEOUT_MS = 2500;
const LINKED_CHAT_CANONICAL_RESOLVE_CONCURRENCY = 4;

let _client = null;
let _sessionState = null;
let _enableProfilePhotoFetch = false;

export function init(client, sessionState, { enableProfilePhotoFetch = false } = {}) {
  _client = client;
  _sessionState = sessionState;
  _enableProfilePhotoFetch = enableProfilePhotoFetch;
}

const photosByJid = new Map();
let lastContactsRefreshAt = 0;
let lastSeedEventsAt = 0;
let seedEventsPromise = null;

function resolveLastMessageMetadata(lastMessage, existing = {}) {
  const lastMessageType = typeof lastMessage?.type === 'string'
    ? lastMessage.type
    : (typeof existing.lastMessageType === 'string' ? existing.lastMessageType : '');
  const lastMessageMediaMimetype = typeof lastMessage?._data?.mimetype === 'string'
    ? lastMessage._data.mimetype
    : (typeof existing.lastMessageMediaMimetype === 'string' ? existing.lastMessageMediaMimetype : '');
  const lastMessageHasMedia = lastMessage
    ? Boolean(lastMessage?.hasMedia)
      || Boolean(lastMessageMediaMimetype)
      || lastMessageType === 'image'
      || lastMessageType === 'video'
      || lastMessageType === 'audio'
      || lastMessageType === 'ptt'
      || lastMessageType === 'document'
      || lastMessageType === 'sticker'
    : Boolean(existing.lastMessageHasMedia);

  return {
    lastMessageType,
    lastMessageHasMedia,
    lastMessageMediaMimetype
  };
}

export function getLastContactsRefreshAt() {
  return lastContactsRefreshAt;
}

export async function loadLabelsMap() {
  const map = new Map();
  if (typeof _client.getLabels !== 'function') {
    return map;
  }

  try {
    const labels = await _client.getLabels();
    (labels || []).forEach(label => {
      const id = String(label?.id ?? label?._data?.id ?? '').trim();
      const name = String(label?.name ?? label?._data?.name ?? '').trim();
      if (id && name) {
        map.set(id, name);
      }
    });
  } catch {
    // Ignore label loading errors.
  }

  return map;
}

export function resolveChatLabelNames(chat, labelsMap) {
  const rawLabels = Array.isArray(chat?.labels) ? chat.labels : [];
  const ids = rawLabels
    .map(item => {
      if (typeof item === 'string' || typeof item === 'number') {
        return String(item);
      }
      if (item && typeof item === 'object') {
        if (item.id !== undefined && item.id !== null) {
          return String(item.id);
        }
        if (item.labelId !== undefined && item.labelId !== null) {
          return String(item.labelId);
        }
      }
      return '';
    })
    .filter(Boolean);

  const names = ids
    .map(id => labelsMap.get(id) || '')
    .filter(Boolean);

  return Array.from(new Set(names));
}

function extractCanonicalJidFromContact(contact, fallbackJid = '') {
  if (!contact) {
    return '';
  }

  if (contact?.isMe === true) {
    return '';
  }

  const serialized = contact?.id?._serialized || '';
  if (isPersonalJid(serialized)) {
    return isSelfJid(serialized) ? '' : serialized;
  }

  const lidUser = typeof contact?.id?.user === 'string'
    ? contact.id.user
    : normalizePhone(fallbackJid);
  const number = typeof contact?.number === 'string' ? contact.number.trim() : '';
  if (number.length < 8 || number === lidUser) {
    return '';
  }

  const canonicalJid = `${number}@c.us`;
  return isSelfJid(canonicalJid) ? '' : canonicalJid;
}

function isSelfContactEntry(jid, contact = null) {
  if (isSelfJid(jid)) {
    return true;
  }

  const phone = typeof contact?.phone === 'string' && contact.phone.trim()
    ? contact.phone.trim()
    : normalizePhone(jid);

  return phone.length >= 8 && isSelfJid(`${phone}@c.us`);
}

function findCanonicalJidByLid(lidJid) {
  if (!lidJid || !isLinkedId(lidJid)) {
    return '';
  }

  for (const [canonicalJid, mappedLidJid] of lidByPhoneJid.entries()) {
    if (mappedLidJid === lidJid) {
      return canonicalJid;
    }
  }

  return '';
}

async function resolveCanonicalJidForLinkedChat(chat) {
  const lidJid = chat?.id?._serialized || '';
  if (!lidJid || !isLinkedId(lidJid)) {
    return '';
  }

  const knownCanonical = findCanonicalJidByLid(lidJid);
  if (knownCanonical) {
    return knownCanonical;
  }

  const resolvers = [];
  if (typeof chat?.getContact === 'function') {
    resolvers.push(() => chat.getContact());
  }
  if (typeof _client?.getContactById === 'function') {
    resolvers.push(() => _client.getContactById(lidJid));
  }

  for (const resolveContact of resolvers) {
    try {
      const contact = await withTimeout(
        resolveContact(),
        LINKED_CHAT_CANONICAL_RESOLVE_TIMEOUT_MS,
        `resolveCanonicalJidForLinkedChat(${lidJid})`
      );
      const canonicalJid = extractCanonicalJidFromContact(contact, lidJid);
      if (canonicalJid) {
        lidByPhoneJid.set(canonicalJid, lidJid);
        return canonicalJid;
      }
    } catch {
      // Fall through to the next resolution strategy.
    }
  }

  return '';
}

async function resolveRecentLinkedChatCanonicals(chats) {
  const candidates = (chats || [])
    .filter(chat => !chat?.isGroup && isLinkedId(chat?.id?._serialized || ''))
    .sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0))
    .slice(0, LINKED_CHAT_CANONICAL_RESOLVE_LIMIT);

  if (!candidates.length) {
    return new Map();
  }

  const resolved = new Map();
  let cursor = 0;

  const runWorker = async () => {
    while (cursor < candidates.length) {
      const currentIndex = cursor;
      cursor += 1;

      const chat = candidates[currentIndex];
      const lidJid = chat?.id?._serialized || '';
      if (!lidJid) {
        continue;
      }

      const canonicalJid = await resolveCanonicalJidForLinkedChat(chat);
      if (canonicalJid) {
        resolved.set(lidJid, canonicalJid);
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(LINKED_CHAT_CANONICAL_RESOLVE_CONCURRENCY, candidates.length) },
      () => runWorker()
    )
  );

  return resolved;
}

export async function refreshContactsFromChats(preloadedChats = null) {
  if (_sessionState.status !== 'ready') {
    return;
  }

  const chatsPromise = preloadedChats
    ? Promise.resolve(preloadedChats)
    : _client.getChats();

  const [chats, contacts, labelsMap] = await Promise.all([
    chatsPromise,
    _client.getContacts(),
    loadLabelsMap()
  ]);
  const resolvedCanonicalByLid = await resolveRecentLinkedChatCanonicals(chats);
  lastContactsRefreshAt = Date.now();

  // Recompute this metadata on each refresh so only current getChats candidates stay marked.
  for (const [jid, existing] of contactsByJid.entries()) {
    contactsByJid.set(jid, {
      ...existing,
      fromGetChats: false,
      getChatsTimestampMs: 0
    });
  }

  contacts
    .filter(contact =>
      contact?.id?._serialized &&
      isPersonalOrLinkedJid(contact.id._serialized) &&
      contact.isMe === true
    )
    .forEach(contact => {
      const rawJid = contact.id._serialized;
      registerSelfJid(rawJid);

      if (isPersonalJid(rawJid)) {
        return;
      }

      const lidUser = typeof contact.id?.user === 'string' ? contact.id.user : normalizePhone(rawJid);
      const number = typeof contact.number === 'string' ? contact.number.trim() : '';
      if (number.length >= 8 && number !== lidUser) {
        registerSelfJid(`${number}@c.us`);
      }
    });

  contacts
    .filter(contact =>
      contact?.id?._serialized &&
      isPersonalOrLinkedJid(contact.id._serialized) &&
      contact.isMyContact === true &&
      contact.isMe !== true
    )
    .forEach(contact => {
      const rawJid = contact.id._serialized;

      // Para @lid: contact.id.user é a parte numérica do LID (ex: '152896658239610').
      // contact.number deveria ser o telefone real, MAS às vezes retorna o próprio LID.
      // Se number === lidUser, é dado falso — pular.
      const lidUser = typeof contact.id?.user === 'string' ? contact.id.user : normalizePhone(rawJid);

      let phone;
      if (isPersonalJid(rawJid)) {
        // @c.us: o telefone está no próprio JID.
        phone = normalizePhone(rawJid);
      } else {
        // @lid: usar contact.number apenas se for diferente do LID user e tiver >= 8 dígitos.
        const num = typeof contact.number === 'string' ? contact.number.trim() : '';
        phone = (num.length >= 8 && num !== lidUser) ? num : null;
      }

      if (!phone) {
        return;
      }

      const canonicalJid = `${phone}@c.us`;
      if (!isValidPersonalJid(canonicalJid)) {
        return;
      }

      if (isSelfJid(canonicalJid)) {
        return;
      }

      const existing = contactsByJid.get(canonicalJid) || {};
      const displayName = getContactName(contact);

      contactsByJid.set(canonicalJid, {
        jid: canonicalJid,
        phone,
        name: displayName || existing.name || phone,
        found: true,
        lastMessageAt: existing.lastMessageAt || null,
        lastMessagePreview: existing.lastMessagePreview || '',
        lastMessageFromMe: Boolean(existing.lastMessageFromMe),
        lastMessageType: typeof existing.lastMessageType === 'string' ? existing.lastMessageType : '',
        lastMessageHasMedia: Boolean(existing.lastMessageHasMedia),
        lastMessageMediaMimetype: typeof existing.lastMessageMediaMimetype === 'string' ? existing.lastMessageMediaMimetype : '',
        unreadCount: typeof existing.unreadCount === 'number' ? existing.unreadCount : 0,
        labels: Array.isArray(existing.labels) ? existing.labels : [],
        isGroup: false,
        fromGetChats: false,
        getChatsTimestampMs: 0
      });

      // Se este contato é @lid, guarde o mapeamento para uso em fotos.
      if (isLinkedId(rawJid)) {
        lidByPhoneJid.set(canonicalJid, rawJid);
      }
    });

  chats
    // Chats @lid são tratados via getContacts() acima com JID canônico @c.us.
    .filter(chat => !chat.isGroup && isValidPersonalJid(chat.id?._serialized) && !isSelfJid(chat.id?._serialized))
    .forEach(chat => {
      const serialized = chat.id?._serialized || '';
      if (!serialized) {
        return;
      }

      const phone = normalizePhone(serialized);

      // Procura a entrada existente pelo JID exato; se não achar, tenta o JID
      // alternativo (9° dígito brasileiro) para preservar o nome do contato.
      let existing = contactsByJid.get(serialized) || {};
      let canonicalKey = serialized;
      if (!existing.found) {
        const altJid = brazilianAlternativeJid(serialized);
        if (altJid) {
          const altExisting = contactsByJid.get(altJid);
          if (altExisting?.found) {
            existing = altExisting;
            canonicalKey = altJid;
            contactsByJid.delete(altJid);
          }
        }
      }

      const displayName = chat.name && chat.name.trim() ? chat.name.trim() : '';
      const getChatsTimestampMs = typeof chat.timestamp === 'number' && chat.timestamp > 0
        ? chat.timestamp * 1000
        : (typeof existing.getChatsTimestampMs === 'number' ? existing.getChatsTimestampMs : 0);
      const lastMessageAt = typeof chat.timestamp === 'number' && chat.timestamp > 0
        ? new Date(chat.timestamp * 1000).toISOString()
        : existing.lastMessageAt || null;
      const unreadCount = typeof chat.unreadCount === 'number'
        ? chat.unreadCount
        : (typeof existing.unreadCount === 'number' ? existing.unreadCount : 0);
      const labels = resolveChatLabelNames(chat, labelsMap);
      const lastMessagePreview = extractLastMessagePreview(chat) || existing.lastMessagePreview || '';
      const lastMessageFromMe = chat?.lastMessage
        ? resolveIsFromMe(chat.lastMessage)
        : Boolean(existing.lastMessageFromMe);
      const {
        lastMessageType,
        lastMessageHasMedia,
        lastMessageMediaMimetype
      } = resolveLastMessageMetadata(chat?.lastMessage, existing);

      contactsByJid.set(canonicalKey, {
        jid: canonicalKey,
        phone: normalizePhone(canonicalKey),
        name: existing.name || displayName || phone,
        found: true,
        lastMessageAt,
        lastMessagePreview,
        lastMessageFromMe,
        lastMessageType,
        lastMessageHasMedia,
        lastMessageMediaMimetype,
        unreadCount,
        labels,
        isGroup: false,
        fromGetChats: true,
        getChatsTimestampMs
      });
    });

  chats
    .filter(chat => chat.isGroup && isGroupJid(chat.id?._serialized))
    .forEach(chat => {
      const serialized = chat.id?._serialized || '';
      if (!serialized) {
        return;
      }

      const existing = contactsByJid.get(serialized) || {};
      const getChatsTimestampMs = typeof chat.timestamp === 'number' && chat.timestamp > 0
        ? chat.timestamp * 1000
        : (typeof existing.getChatsTimestampMs === 'number' ? existing.getChatsTimestampMs : 0);
      const lastMessageAt = typeof chat.timestamp === 'number' && chat.timestamp > 0
        ? new Date(chat.timestamp * 1000).toISOString()
        : existing.lastMessageAt || null;
      const unreadCount = typeof chat.unreadCount === 'number'
        ? chat.unreadCount
        : (typeof existing.unreadCount === 'number' ? existing.unreadCount : 0);
      const labels = resolveChatLabelNames(chat, labelsMap);
      const lastMessagePreview = extractLastMessagePreview(chat) || existing.lastMessagePreview || '';
      const lastMessageFromMe = chat?.lastMessage
        ? resolveIsFromMe(chat.lastMessage)
        : Boolean(existing.lastMessageFromMe);
      const {
        lastMessageType,
        lastMessageHasMedia,
        lastMessageMediaMimetype
      } = resolveLastMessageMetadata(chat?.lastMessage, existing);

      contactsByJid.set(serialized, {
        jid: serialized,
        phone: normalizePhone(serialized),
        name: (chat.name && chat.name.trim()) || existing.name || 'Grupo',
        found: true,
        lastMessageAt,
        lastMessagePreview,
        lastMessageFromMe,
        lastMessageType,
        lastMessageHasMedia,
        lastMessageMediaMimetype,
        unreadCount,
        labels,
        isGroup: true,
        fromGetChats: true,
        getChatsTimestampMs
      });
    });

  // Quarto loop: chats @lid (multi-device). O loop de contatos registra esses
  // contatos como @c.us mas sem lastMessageAt, porque getChats() os lista com
  // JID @lid e o loop de chats pessoais só cobre @c.us.
  // Aqui mapeamos cada chat @lid para seu contato canônico @c.us e
  // propagamos o timestamp correto.
  const canonicalByLid = new Map();
  for (const [canonicalJid, lidJid] of lidByPhoneJid.entries()) {
    canonicalByLid.set(lidJid, canonicalJid);
  }
  for (const [lidJid, canonicalJid] of resolvedCanonicalByLid.entries()) {
    canonicalByLid.set(lidJid, canonicalJid);
  }

  chats
    .filter(chat => !chat.isGroup && isLinkedId(chat.id?._serialized))
    .forEach(chat => {
      const lidJid = chat.id?._serialized || '';
      if (!lidJid) {
        return;
      }

      const canonicalKey = canonicalByLid.get(lidJid) || lidJid;
      const existing = contactsByJid.get(canonicalKey) || contactsByJid.get(lidJid) || {};

      if (canonicalKey !== lidJid && contactsByJid.has(lidJid)) {
        contactsByJid.delete(lidJid);
      }

      const getChatsTimestampMs = typeof chat.timestamp === 'number' && chat.timestamp > 0
        ? chat.timestamp * 1000
        : (typeof existing.getChatsTimestampMs === 'number' ? existing.getChatsTimestampMs : 0);
      const lastMessageAt = typeof chat.timestamp === 'number' && chat.timestamp > 0
        ? new Date(chat.timestamp * 1000).toISOString()
        : existing.lastMessageAt || null;
      const unreadCount = typeof chat.unreadCount === 'number'
        ? chat.unreadCount
        : (typeof existing.unreadCount === 'number' ? existing.unreadCount : 0);
      const labels = resolveChatLabelNames(chat, labelsMap);
      const lastMessagePreview = extractLastMessagePreview(chat) || existing.lastMessagePreview || '';
      const lastMessageFromMe = chat?.lastMessage
        ? resolveIsFromMe(chat.lastMessage)
        : Boolean(existing.lastMessageFromMe);
      const {
        lastMessageType,
        lastMessageHasMedia,
        lastMessageMediaMimetype
      } = resolveLastMessageMetadata(chat?.lastMessage, existing);
      const displayName = chat.name && chat.name.trim() ? chat.name.trim() : '';
      const resolvedPhone = isLinkedId(canonicalKey)
        ? ''
        : normalizePhone(canonicalKey);

      if (!isLinkedId(canonicalKey) && !isValidPersonalJid(canonicalKey)) {
        contactsByJid.delete(lidJid);
        if (canonicalKey !== lidJid) {
          contactsByJid.delete(canonicalKey);
        }
        return;
      }

      if (isSelfContactEntry(canonicalKey, { phone: resolvedPhone })) {
        contactsByJid.delete(lidJid);
        if (canonicalKey !== lidJid) {
          contactsByJid.delete(canonicalKey);
        }
        return;
      }

      contactsByJid.set(canonicalKey, {
        jid: canonicalKey,
        phone: resolvedPhone,
        name: existing.name || displayName || resolvedPhone || normalizePhone(canonicalKey),
        found: true,
        lastMessageAt,
        lastMessagePreview,
        lastMessageFromMe,
        lastMessageType,
        lastMessageHasMedia,
        lastMessageMediaMimetype,
        unreadCount,
        labels,
        isGroup: false,
        fromGetChats: true,
        getChatsTimestampMs
      });
    });

  for (const [jid, existing] of contactsByJid.entries()) {
    if (isPersonalJid(jid) && !isValidPersonalJid(jid)) {
      contactsByJid.delete(jid);
      continue;
    }

    if (isSelfContactEntry(jid, existing)) {
      contactsByJid.delete(jid);
    }
  }

  for (const [canonicalJid] of lidByPhoneJid.entries()) {
    if (isSelfJid(canonicalJid)) {
      lidByPhoneJid.delete(canonicalJid);
    }
  }

  // Remove stale conversation metadata for contacts that are no longer present
  // in the current getChats snapshot. This prevents old contacts without active
  // chats from floating to the top with leftover unread counters.
  for (const [jid, existing] of contactsByJid.entries()) {
    if (existing?.fromGetChats) {
      continue;
    }

    contactsByJid.set(jid, {
      ...existing,
      lastMessageAt: null,
      lastMessagePreview: '',
      lastMessageFromMe: false,
      lastMessageAck: null,
      lastMessageType: '',
      lastMessageHasMedia: false,
      lastMessageMediaMimetype: '',
      unreadCount: 0,
      labels: []
    });
  }
}

export async function seedEventsFromRecentChats(preloadedChats = null) {
  if (_sessionState.status !== 'ready') {
    return;
  }

  const now = Date.now();
  if (now - lastSeedEventsAt < EVENT_SEED_COOLDOWN_MS && events.length > 0) {
    return;
  }

  if (seedEventsPromise) {
    return seedEventsPromise;
  }

  seedEventsPromise = (async () => {
    let chats = preloadedChats || [];
    if (!chats.length) {
      try {
        chats = await _client.getChats();
      } catch {
        return;
      }
    }

    const candidates = chats
      .filter(chat => {
        const jid = chat.id?._serialized || '';
        if (chat.isGroup) {
          return isGroupJid(jid);
        }
        return isValidPersonalJid(jid) && !isSelfJid(jid);
      })
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, EVENT_SEED_CHAT_LIMIT);

    candidates.forEach(chat => {
      const chatJid = chat.id?._serialized || '';
      if (!chatJid) {
        return;
      }

      const lastMessage = chat.lastMessage;
      const hasLastMessage = Boolean(lastMessage);
      const messageTimestamp = Number(lastMessage?.timestamp || chat.timestamp || Math.floor(Date.now() / 1000));
      const receivedAt = toIsoFromUnixTimestamp(messageTimestamp);
      const previewText = hasLastMessage
        ? extractLastMessagePreview(chat)
        : '';

      const eventId = lastMessage?.id?._serialized
        || `seed-${chatJid}-${messageTimestamp}`;

      pushEvent({
        id: eventId,
        source: hasLastMessage ? 'webjs-seed' : 'webjs-seed-chat',
        isFromMe: resolveIsFromMe(lastMessage),
        chatJid,
        text: previewText,
        receivedAt,
        payload: {
          id: lastMessage?.id?._serialized || '',
          timestamp: messageTimestamp,
          type: lastMessage?.type || '',
          hasMedia: Boolean(lastMessage?.hasMedia)
        }
      });
    });

    lastSeedEventsAt = Date.now();
  })().finally(() => {
    seedEventsPromise = null;
  });

  return seedEventsPromise;
}

export async function downloadAsDataUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'image/*,*/*;q=0.8'
      },
      signal: controller.signal
    });
    if (!response.ok) {
      console.log('[whatsapp-webjs-bridge] download não-OK:', response.status, response.statusText);
      return null;
    }
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = await response.arrayBuffer();
    if (!buffer || buffer.byteLength === 0) {
      return null;
    }
    const base64 = Buffer.from(buffer).toString('base64');
    return `data:${contentType};base64,${base64}`;
  } catch (err) {
    console.log('[whatsapp-webjs-bridge] erro no download:', err?.message || String(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function tryGetPhotoDataUrlFromPage(targetId) {
  if (!_client?.pupPage || !targetId) {
    return null;
  }

  try {
    return await withTimeout(
      _client.pupPage.evaluate(async candidateId => {
        const readAsDataUrl = blob => new Promise(resolve => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
          reader.readAsDataURL(blob);
        });

        try {
          const chatWid = window.Store?.WidFactory?.createWid
            ? window.Store.WidFactory.createWid(candidateId)
            : candidateId;

          let profilePic = null;
          if (window.Store?.ProfilePicThumb?.get) {
            profilePic = window.Store.ProfilePicThumb.get(chatWid) || null;
          }
          if (!profilePic && window.Store?.ProfilePicThumb?.find) {
            try {
              profilePic = await window.Store.ProfilePicThumb.find(chatWid);
            } catch {
              profilePic = null;
            }
          }

          if (!profilePic && window.Store?.ProfilePic) {
            try {
              profilePic = typeof window.Store.ProfilePic.requestProfilePicFromServer === 'function'
                ? await window.Store.ProfilePic.requestProfilePicFromServer(chatWid)
                : (typeof window.Store.ProfilePic.profilePicFind === 'function'
                  ? await window.Store.ProfilePic.profilePicFind(chatWid)
                  : null);
            } catch {
              profilePic = null;
            }
          }

          const imageUrl = profilePic?.img || profilePic?.eurl || null;
          if (imageUrl) {
            try {
              const response = await fetch(imageUrl);
              if (response.ok) {
                const blob = await response.blob();
                if (blob && blob.size > 0) {
                  return await readAsDataUrl(blob);
                }
              }
            } catch {
              // fall through to helper fallback
            }
          }

          if (window.WWebJS?.getProfilePicThumbToBase64) {
            const base64 = await window.WWebJS.getProfilePicThumbToBase64(chatWid);
            if (typeof base64 === 'string' && base64.length > 0) {
              return `data:image/jpeg;base64,${base64}`;
            }
          }

          return null;
        } catch {
          return null;
        }
      }, targetId),
      12000,
      `getProfilePicThumbToBase64(${targetId})`
    );
  } catch (err) {
    console.log('[whatsapp-webjs-bridge] fallback no navegador falhou para', targetId, '-', err?.message || String(err));
    return null;
  }
}

export async function tryGetPhotoUrlForId(targetId) {
  if (!targetId) {
    return null;
  }

  // Estratégia 1: client.getProfilePicUrl direto.
  try {
    const url = await withTimeout(
      _client.getProfilePicUrl(targetId),
      8000,
      `getProfilePicUrl(${targetId})`
    );
    if (typeof url === 'string' && url.length > 0) {
      return url;
    }
  } catch (err) {
    console.log('[whatsapp-webjs-bridge] client.getProfilePicUrl falhou para', targetId, '-', err?.message || String(err));
  }

  // Estratégia 2: getContactById + contact.getProfilePicUrl.
  try {
    const contact = await withTimeout(
      _client.getContactById(targetId),
      8000,
      `getContactById(${targetId})`
    );
    if (contact && typeof contact.getProfilePicUrl === 'function') {
      const url = await withTimeout(
        contact.getProfilePicUrl(),
        8000,
        `contact.getProfilePicUrl(${targetId})`
      );
      if (typeof url === 'string' && url.length > 0) {
        return url;
      }
    }
  } catch (err) {
    console.log('[whatsapp-webjs-bridge] getContactById fallback falhou para', targetId, '-', err?.message || String(err));
  }

  return null;
}

export async function findLidByPhoneLookup(phoneJid) {
  if (!isPersonalJid(phoneJid)) {
    return null;
  }
  const targetPhone = normalizePhone(phoneJid);
  if (!targetPhone) {
    return null;
  }
  try {
    const contacts = await _client.getContacts();
    for (const contact of contacts) {
      const rawJid = contact?.id?._serialized;
      if (!isLinkedId(rawJid)) continue;
      const num = typeof contact.number === 'string' ? contact.number.trim() : '';
      const lidUser = typeof contact.id?.user === 'string' ? contact.id.user : '';
      if (num && num === targetPhone && num !== lidUser) {
        lidByPhoneJid.set(phoneJid, rawJid);
        return rawJid;
      }
    }
  } catch (err) {
    console.log('[whatsapp-webjs-bridge] falha ao varrer contatos para LID:', err?.message || String(err));
  }
  return null;
}

export async function fetchProfilePhotoUrl(jid) {
  if (_sessionState.status !== 'ready' || !isPersonalOrLinkedJid(jid)) {
    return null;
  }

  const cached = photosByJid.get(jid);
  if (cached && Date.now() - cached.fetchedAt < PHOTO_TTL_MS) {
    return cached.url;
  }

  if (!_enableProfilePhotoFetch) {
    photosByJid.set(jid, { url: null, fetchedAt: Date.now() });
    return null;
  }

  // Candidatos em ordem: canônico conhecido, JID pedido e alias LID conhecido.
  const candidates = [];
  const knownCanonical = isLinkedId(jid) ? findCanonicalJidByLid(jid) : '';
  if (knownCanonical) {
    candidates.push(knownCanonical);
  }

  if (!candidates.includes(jid)) {
    candidates.push(jid);
  }

  const knownLid = isPersonalJid(jid) ? lidByPhoneJid.get(jid) : '';
  if (knownLid && !candidates.includes(knownLid)) {
    candidates.push(knownLid);
  }

  let externalUrl = null;
  let usedCandidate = null;

  for (const candidate of candidates) {
    externalUrl = await tryGetPhotoUrlForId(candidate);
    if (externalUrl) {
      usedCandidate = candidate;
      break;
    }
  }

  // Último recurso: se ainda não achamos, varrer getContacts() para descobrir o LID.
  if (!externalUrl && isPersonalJid(jid) && !knownLid) {
    const discoveredLid = await findLidByPhoneLookup(jid);
    if (discoveredLid) {
      candidates.push(discoveredLid);
      externalUrl = await tryGetPhotoUrlForId(discoveredLid);
      if (externalUrl) {
        usedCandidate = discoveredLid;
      }
    }
  }

  let dataUrl = null;
  if (externalUrl) {
    console.log('[whatsapp-webjs-bridge] foto obtida para', jid, 'via', usedCandidate, '— baixando...');
    dataUrl = await downloadAsDataUrl(externalUrl);
    if (!dataUrl) {
      console.log('[whatsapp-webjs-bridge] falha ao baixar foto de', jid, externalUrl.slice(0, 100));
    }
  }

  if (!dataUrl) {
    const pageCandidates = usedCandidate
      ? [usedCandidate, ...candidates.filter(candidate => candidate !== usedCandidate)]
      : candidates;

    for (const candidate of pageCandidates) {
      dataUrl = await tryGetPhotoDataUrlFromPage(candidate);
      if (dataUrl) {
        usedCandidate = candidate;
        console.log('[whatsapp-webjs-bridge] foto obtida no navegador para', jid, 'via', usedCandidate);
        break;
      }
    }
  }

  if (!dataUrl) {
    console.log('[whatsapp-webjs-bridge] fallback de navegador sem foto para', jid, '(candidatos:', candidates.join(', ') + ')');
    photosByJid.set(jid, { url: null, fetchedAt: Date.now() });
    return null;
  }

  photosByJid.set(jid, { url: dataUrl, fetchedAt: Date.now() });
  return dataUrl;
}
