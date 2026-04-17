/**
 * Contact loading, photo fetching, and event seeding from recent chats.
 * Call init(client, sessionState, options) once the client is available.
 */

import {
  withTimeout,
  normalizePhone,
  isPersonalJid,
  isPersonalOrLinkedJid,
  isGroupJid,
  isLinkedId,
  brazilianAlternativeJid,
  extractLastMessagePreview,
  toIsoFromUnixTimestamp,
  getContactName
} from './utils.js';
import { resolveIsFromMe, isSelfJid } from './jid.js';
import { events, contactsByJid, lidByPhoneJid, pushEvent } from './events.js';

const PHOTO_TTL_MS = 30 * 60 * 1000;
const EVENT_SEED_CHAT_LIMIT = 80;
const EVENT_SEED_COOLDOWN_MS = 60 * 1000;

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

export async function refreshContactsFromChats(preloadedChats = null) {
  if (_sessionState.status !== 'ready') {
    return;
  }

  const [chats, contacts, labelsMap] = await Promise.all([
    preloadedChats ? Promise.resolve(preloadedChats) : _client.getChats(),
    _client.getContacts(),
    loadLabelsMap()
  ]);
  lastContactsRefreshAt = Date.now();

  contacts
    .filter(contact =>
      contact?.id?._serialized &&
      isPersonalOrLinkedJid(contact.id._serialized) &&
      contact.isMyContact === true &&
      !contact.isMe
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
        unreadCount: typeof existing.unreadCount === 'number' ? existing.unreadCount : 0,
        labels: Array.isArray(existing.labels) ? existing.labels : [],
        isGroup: false
      });

      // Se este contato é @lid, guarde o mapeamento para uso em fotos.
      if (isLinkedId(rawJid)) {
        lidByPhoneJid.set(canonicalJid, rawJid);
      }
    });

  chats
    // Chats @lid são tratados via getContacts() acima com JID canônico @c.us.
    .filter(chat => !chat.isGroup && isPersonalJid(chat.id?._serialized) && !isSelfJid(chat.id?._serialized))
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

      contactsByJid.set(canonicalKey, {
        jid: canonicalKey,
        phone: normalizePhone(canonicalKey),
        name: existing.name || displayName || phone,
        found: true,
        lastMessageAt,
        lastMessagePreview,
        lastMessageFromMe,
        unreadCount,
        labels,
        isGroup: false
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

      contactsByJid.set(serialized, {
        jid: serialized,
        phone: normalizePhone(serialized),
        name: (chat.name && chat.name.trim()) || existing.name || 'Grupo',
        found: true,
        lastMessageAt,
        lastMessagePreview,
        lastMessageFromMe,
        unreadCount,
        labels,
        isGroup: true
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

  chats
    .filter(chat => !chat.isGroup && isLinkedId(chat.id?._serialized))
    .forEach(chat => {
      const lidJid = chat.id?._serialized || '';
      if (!lidJid) {
        return;
      }

      const canonicalKey = canonicalByLid.get(lidJid);
      if (!canonicalKey) {
        return;
      }

      const existing = contactsByJid.get(canonicalKey);
      if (!existing?.found) {
        return;
      }

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

      contactsByJid.set(canonicalKey, {
        ...existing,
        lastMessageAt,
        lastMessagePreview,
        lastMessageFromMe,
        unreadCount,
        labels
      });
    });
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
        return isPersonalJid(jid) && !isSelfJid(jid);
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
  if (_sessionState.status !== 'ready' || !isPersonalJid(jid)) {
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

  // Candidatos em ordem: @c.us, LID conhecido, e LID descoberto via varredura.
  const candidates = [jid];
  const knownLid = lidByPhoneJid.get(jid);
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
  if (!externalUrl && !knownLid) {
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
