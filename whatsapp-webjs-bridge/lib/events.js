/**
 * In-memory event state and ingestion logic.
 * No client reference — all client-dependent operations arrive via message objects.
 */

import { randomUUID } from 'crypto';
import {
  normalizePhone,
  isLinkedId,
  isPersonalJid,
  isPersonalOrLinkedJid,
  resolveMessagePreviewText,
  toIsoFromUnixTimestamp,
  getContactName
} from './utils.js';
import { resolveIsFromMe } from './jid.js';

const MAX_EVENTS = 200;
const MAX_RECENT_EVENT_IDS = 2000;

let _onEventPushed = null;

export function setOnEventPushed(callback) {
  _onEventPushed = callback;
}

export const events = [];
export const contactsByJid = new Map();
export const lidByPhoneJid = new Map();
const recentEventIds = new Set();
const recentEventIdQueue = [];
const eventAckById = new Map();

export function trackEventId(eventId) {
  if (!eventId || recentEventIds.has(eventId)) {
    return;
  }

  recentEventIds.add(eventId);
  recentEventIdQueue.push(eventId);

  if (recentEventIdQueue.length > MAX_RECENT_EVENT_IDS) {
    const removed = recentEventIdQueue.shift();
    if (removed) {
      recentEventIds.delete(removed);
    }
  }
}

export function resolveMessageChatJid(message) {
  const from = typeof message?.from === 'string' ? message.from : '';
  const to = typeof message?.to === 'string' ? message.to : '';

  // Mensagens de grupo — descarta.
  if (from.endsWith('@g.us') || to.endsWith('@g.us')) {
    return '';
  }

  // Em conversas 1:1 (inclui @lid do multi-device):
  //   inbound  → chat = message.from (o contato)
  //   outbound → chat = message.to   (o contato)
  if (resolveIsFromMe(message)) {
    return isPersonalOrLinkedJid(to) ? to : '';
  }
  return isPersonalOrLinkedJid(from) ? from : '';
}

export function pushEvent({ id, source, isFromMe, chatJid, text, payload, receivedAt }) {
  const resolvedId = typeof id === 'string' && id.trim().length > 0 ? id.trim() : randomUUID();
  if (recentEventIds.has(resolvedId)) {
    return;
  }

  const ack = typeof payload?.ack === 'number' ? payload.ack : null;

  const event = {
    id: resolvedId,
    source,
    receivedAt: typeof receivedAt === 'string' && receivedAt ? receivedAt : new Date().toISOString(),
    isFromMe: Boolean(isFromMe),
    chatJid,
    phone: normalizePhone(chatJid),
    text: typeof text === 'string' ? text : '',
    ack,
    payload
  };

  events.unshift(event);
  trackEventId(event.id);
  if (ack !== null) {
    eventAckById.set(resolvedId, ack);
  }
  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }

  if (_onEventPushed) {
    try { _onEventPushed(event); } catch { /* silent */ }
  }
}

export function updateEventAck(messageId, ack) {
  if (!messageId) return;

  eventAckById.set(messageId, ack);

  const event = events.find(e => e.id === messageId);
  if (event) {
    event.ack = ack;
    if (event.payload && typeof event.payload === 'object') {
      event.payload.ack = ack;
    }
  }
}

export function getEventAck(messageId) {
  return eventAckById.get(messageId) ?? null;
}

export function resetUnreadCount(chatJid) {
  const existing = contactsByJid.get(chatJid);
  if (existing) {
    contactsByJid.set(chatJid, { ...existing, unreadCount: 0 });
  }
}

export async function resolveContactPhone(message) {
  // Tenta obter número de telefone real via getContact().
  // Necessário quando o JID vem como @lid (multi-device WhatsApp).
  try {
    const contact = await message.getContact();
    // contact.number já é só dígitos no whatsapp-web.js
    const num = typeof contact.number === 'string' && contact.number.length >= 8
      ? contact.number
      : normalizePhone(contact.id?._serialized || '');
    if (num) {
      return `${num}@c.us`;
    }
  } catch {
    // silencioso
  }
  return null;
}

export async function ingestInboundMessage(message, source) {
  if (!message || resolveIsFromMe(message)) {
    return;
  }

  let chatJid = resolveMessageChatJid(message);
  const originalLid = isLinkedId(chatJid) ? chatJid : null;

  // @lid é o novo formato multi-device do WhatsApp — converter para @c.us.
  if (isLinkedId(chatJid)) {
    const resolved = await resolveContactPhone(message);
    if (resolved) {
      console.log('[whatsapp-webjs-bridge] LID resolvido:', chatJid, '->', resolved);
      lidByPhoneJid.set(resolved, chatJid);
      chatJid = resolved;
    } else {
      console.log('[whatsapp-webjs-bridge] LID sem resolução, descartado:', chatJid);
      return;
    }
  }

  // Garante que o mapa esteja sincronizado caso o fluxo multi-device mude.
  if (originalLid) {
    lidByPhoneJid.set(chatJid, originalLid);
  }

  if (!isPersonalJid(chatJid)) {
    console.log('[whatsapp-webjs-bridge] mensagem descartada (sem chat 1:1):', {
      source,
      from: message.from,
      to: message.to,
      body: (typeof message.body === 'string' ? message.body.slice(0, 60) : '')
    });
    return;
  }

  console.log('[whatsapp-webjs-bridge] mensagem recebida:', {
    source,
    chatJid,
    body: (typeof message.body === 'string' ? message.body.slice(0, 60) : '')
  });

  const text = resolveMessagePreviewText(message);
  const mediaMimetype = typeof message?._data?.mimetype === 'string' ? message._data.mimetype : '';
  const mediaFilename = typeof message?._data?.filename === 'string' ? message._data.filename : '';
  const messageId = message.id?._serialized || '';
  const receivedAt = toIsoFromUnixTimestamp(message.timestamp);
  let mediaDataUrl = null;

  if (message.hasMedia && mediaMimetype.startsWith('image/')) {
    try {
      const media = await message.downloadMedia();
      if (media?.data && media?.mimetype) {
        mediaDataUrl = `data:${media.mimetype};base64,${media.data}`;
      }
    } catch {
      mediaDataUrl = null;
    }
  }

  pushEvent({
    id: messageId,
    source,
    isFromMe: false,
    chatJid,
    text,
    receivedAt,
    payload: {
      id: messageId,
      timestamp: message.timestamp || 0,
      type: message.type || '',
      hasMedia: Boolean(message.hasMedia),
      mediaMimetype,
      mediaFilename,
      mediaDataUrl
    }
  });

  if (!contactsByJid.has(chatJid)) {
    try {
      const contact = await message.getContact();
      const phone = normalizePhone(chatJid);
      contactsByJid.set(chatJid, {
        jid: chatJid,
        phone,
        name: getContactName(contact) || phone,
        found: true,
        lastMessageAt: receivedAt,
        lastMessagePreview: text,
        lastMessageFromMe: false,
        unreadCount: 1
      });
    } catch {
      const phone = normalizePhone(chatJid);
      contactsByJid.set(chatJid, {
        jid: chatJid,
        phone,
        name: phone,
        found: true,
        lastMessageAt: receivedAt,
        lastMessagePreview: text,
        lastMessageFromMe: false,
        unreadCount: 1
      });
    }
  } else {
    const existing = contactsByJid.get(chatJid);
    contactsByJid.set(chatJid, {
      ...existing,
      lastMessageAt: receivedAt,
      lastMessagePreview: text,
      lastMessageFromMe: false,
      unreadCount: (typeof existing.unreadCount === 'number' ? existing.unreadCount : 0) + 1
    });
  }
}
