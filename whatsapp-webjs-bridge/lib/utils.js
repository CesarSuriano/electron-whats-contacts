/**
 * Pure utility/helper functions — no `client` reference, no side effects.
 */

export function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') {
    return '';
  }

  const userPart = raw.split('@')[0]?.split(':')[0] || raw;
  return userPart.replace(/\D/g, '');
}

// Retorna o JID alternativo para números brasileiros (9° dígito).
// Ex: "5511987654321@c.us" ↔ "551187654321@c.us"
export function brazilianAlternativeJid(jid) {
  const phone = normalizePhone(jid);
  if (!phone.startsWith('55') || phone.length < 12 || phone.length > 13) {
    return null;
  }
  const ddd = phone.slice(2, 4);
  const local = phone.slice(4);
  if (phone.length === 13 && local[0] === '9') {
    // 13 dígitos → remover o 9
    return `55${ddd}${local.slice(1)}@c.us`;
  }
  if (phone.length === 12) {
    // 12 dígitos → adicionar 9
    return `55${ddd}9${local}@c.us`;
  }
  return null;
}

export function isBlankMessage(message) {
  const body = typeof message?.body === 'string' ? message.body.trim() : '';
  const hasMedia = Boolean(message?.hasMedia);
  return !body && !hasMedia;
}

// Retorna texto de prévia para um evento/mensagem — igual ao extractLastMessagePreview,
// mas recebe um objeto de mensagem individual (não o chat).
export function resolveMessagePreviewText(message) {
  const body = typeof message?.body === 'string' ? message.body.trim() : '';
  if (body) return body;

  const type = typeof message?.type === 'string' ? message.type : '';
  switch (type) {
    case 'image':    return 'Foto';
    case 'video':    return 'Vídeo';
    case 'audio':
    case 'ptt':      return 'Áudio';
    case 'document': return 'Documento';
    case 'sticker':  return 'Figurinha';
    case 'revoked':  return 'Mensagem apagada';
    default:         return message?.hasMedia ? '[mídia]' : '';
  }
}

export function normalizeJid(input) {
  if (!input || typeof input !== 'string') {
    return '';
  }

  if (input.includes('@')) {
    return input;
  }

  const number = normalizePhone(input);
  if (!number) {
    return '';
  }

  return `${number}@c.us`;
}

export function isSamePhoneJid(a, b) {
  const aPhone = normalizePhone(a);
  const bPhone = normalizePhone(b);
  return Boolean(aPhone) && Boolean(bPhone) && aPhone === bPhone;
}

export function isPersonalJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@c.us');
}

export function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

export function isLinkedId(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

export function isPersonalOrLinkedJid(jid) {
  return isPersonalJid(jid) || isLinkedId(jid);
}

export function isSameConversationJid(a, b) {
  if (!a || !b) {
    return false;
  }

  if (a === b) {
    return true;
  }

  if (isPersonalOrLinkedJid(a) && isPersonalOrLinkedJid(b)) {
    return normalizePhone(a) === normalizePhone(b);
  }

  return false;
}

export function normalizeRequestedChatJid(raw) {
  if (!raw || typeof raw !== 'string') {
    return '';
  }

  const value = raw.trim();
  if (!value) {
    return '';
  }

  if (value.includes('@')) {
    return value;
  }

  return normalizeJid(value);
}

export function readMessageTimestampSeconds(message) {
  const candidates = [
    message?.timestamp,
    message?.t,
    message?._data?.t,
    message?.msgTimestamp
  ];

  for (const raw of candidates) {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return 0;
}

export function readMessageText(message) {
  if (typeof message?.body === 'string') {
    return message.body;
  }
  if (typeof message?.caption === 'string') {
    return message.caption;
  }
  return '';
}

export function isValidPersonalJid(jid) {
  if (!isPersonalJid(jid)) {
    return false;
  }

  const phone = normalizePhone(jid);
  return phone.length >= 8;
}

export function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout while ${label}`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

export function toIsoFromUnixTimestamp(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return new Date().toISOString();
  }

  return new Date(seconds * 1000).toISOString();
}

export function getContactName(contactData) {
  const candidate = [
    contactData?.name,
    contactData?.pushname,
    contactData?.shortName,
    normalizePhone(contactData?.id?._serialized || '')
  ].find(value => typeof value === 'string' && value.trim().length > 0);

  return candidate || '';
}

export function extractLastMessagePreview(chat) {
  const lastMessage = chat?.lastMessage;
  if (!lastMessage) {
    return '';
  }

  const body = typeof lastMessage.body === 'string' ? lastMessage.body.trim() : '';
  if (body) {
    return body;
  }

  const type = typeof lastMessage.type === 'string' ? lastMessage.type : '';
  if (lastMessage.isNotification || type === 'e2e_notification' || type === 'notification_template' || type === 'call_log') {
    return '';
  }
  switch (type) {
    case 'image':
      return 'Foto';
    case 'video':
      return 'Video';
    case 'audio':
    case 'ptt':
      return 'Audio';
    case 'document':
      return 'Documento';
    case 'sticker':
      return 'Figurinha';
    case 'revoked':
      return 'Mensagem apagada';
    default:
      return lastMessage.hasMedia ? '[mídia]' : '';
  }
}
