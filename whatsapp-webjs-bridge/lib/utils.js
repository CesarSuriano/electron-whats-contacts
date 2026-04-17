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

const DATA_URL_PATTERN = /^data:[^,]+,/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const RAW_IMAGE_BASE64_SIGNATURE_PATTERN = /^(\/9j\/|iVBORw0KGgo|R0lGOD|UklGR)/;

function isDataUrl(value) {
  return typeof value === 'string' && DATA_URL_PATTERN.test(value.trim());
}

function normalizeBase64Candidate(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, '') : '';
}

function isLikelyRawImageBase64(value) {
  const normalized = normalizeBase64Candidate(value);
  if (normalized.length < 256) {
    return false;
  }

  // Base64 payloads cannot have remainder 1 when divided by 4.
  if (normalized.length % 4 === 1) {
    return false;
  }

  if (!BASE64_PATTERN.test(normalized)) {
    return false;
  }

  return RAW_IMAGE_BASE64_SIGNATURE_PATTERN.test(normalized);
}

function readExplicitMessageMediaMimetype(message) {
  const fromData = typeof message?._data?.mimetype === 'string' ? message._data.mimetype.trim() : '';
  if (fromData) {
    return fromData;
  }

  const direct = typeof message?.mimetype === 'string' ? message.mimetype.trim() : '';
  if (direct) {
    return direct;
  }

  return '';
}

function isLikelyInlineMediaBody(value, message) {
  if (!value) {
    return false;
  }

  if (isDataUrl(value)) {
    return true;
  }

  const mediaMimetype = readExplicitMessageMediaMimetype(message).toLowerCase();
  const type = typeof message?.type === 'string' ? message.type : '';
  const imageHint = mediaMimetype.startsWith('image/') || type === 'image' || Boolean(message?.hasMedia);

  return imageHint && isLikelyRawImageBase64(value);
}

function readMessageMediaMimetype(message) {
  const explicit = readExplicitMessageMediaMimetype(message);
  if (explicit) {
    return explicit;
  }

  const inlineImageDataUrl = readMessageInlineImageDataUrl(message);
  if (inlineImageDataUrl) {
    const match = inlineImageDataUrl.match(/^data:([^;,]+)/i);
    return match && typeof match[1] === 'string' ? match[1].toLowerCase() : '';
  }

  return '';
}

function isLikelyMediaMessage(message) {
  const type = typeof message?.type === 'string' ? message.type : '';
  const mediaMimetype = readMessageMediaMimetype(message);
  return Boolean(message?.hasMedia)
    || Boolean(mediaMimetype)
    || type === 'image'
    || type === 'video'
    || type === 'audio'
    || type === 'ptt'
    || type === 'document'
    || type === 'sticker';
}

export function readMessageInlineImageDataUrl(message) {
  const explicitMimetype = readExplicitMessageMediaMimetype(message).toLowerCase();
  const type = typeof message?.type === 'string' ? message.type : '';
  const imageHint = explicitMimetype.startsWith('image/') || type === 'image' || Boolean(message?.hasMedia);

  const candidates = [
    typeof message?.body === 'string' ? message.body.trim() : '',
    typeof message?.mediaDataUrl === 'string' ? message.mediaDataUrl.trim() : '',
    typeof message?._data?.body === 'string' ? message._data.body.trim() : ''
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (isDataUrl(candidate)) {
      if (candidate.toLowerCase().startsWith('data:image/')) {
        return candidate;
      }
      continue;
    }

    if (imageHint && isLikelyRawImageBase64(candidate)) {
      const mimetype = explicitMimetype.startsWith('image/') ? explicitMimetype : 'image/jpeg';
      return `data:${mimetype};base64,${normalizeBase64Candidate(candidate)}`;
    }
  }

  return null;
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
  const mediaMimetype = readMessageMediaMimetype(message);
  const hasMedia = isLikelyMediaMessage(message);

  if (body && !(hasMedia && isLikelyInlineMediaBody(body, message))) {
    return body;
  }

  const caption = typeof message?.caption === 'string' ? message.caption.trim() : '';
  if (caption) {
    return caption;
  }

  const type = typeof message?.type === 'string' ? message.type : '';
  if (type === 'image' || mediaMimetype.startsWith('image/')) {
    return 'Foto';
  }
  if (type === 'video' || mediaMimetype.startsWith('video/')) {
    return 'Vídeo';
  }
  if (type === 'audio' || type === 'ptt' || mediaMimetype.startsWith('audio/')) {
    return 'Áudio';
  }

  switch (type) {
    case 'document':
      return 'Documento';
    case 'sticker':
      return 'Figurinha';
    case 'revoked':
      return 'Mensagem apagada';
    default:
      return hasMedia ? '[mídia]' : '';
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
  const body = typeof message?.body === 'string' ? message.body : '';
  if (body.trim()) {
    if (!(isLikelyMediaMessage(message) && isLikelyInlineMediaBody(body, message))) {
      return body;
    }
  }

  const caption = typeof message?.caption === 'string' ? message.caption : '';
  if (caption.trim()) {
    return caption;
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
  const mediaMimetype = readMessageMediaMimetype(lastMessage);
  const hasMedia = isLikelyMediaMessage(lastMessage);

  if (body && !(hasMedia && isLikelyInlineMediaBody(body, lastMessage))) {
    return body;
  }

  const caption = typeof lastMessage.caption === 'string' ? lastMessage.caption.trim() : '';
  if (caption) {
    return caption;
  }

  const type = typeof lastMessage.type === 'string' ? lastMessage.type : '';
  if (lastMessage.isNotification || type === 'e2e_notification' || type === 'notification_template' || type === 'call_log') {
    return '';
  }

  if (type === 'image' || mediaMimetype.startsWith('image/')) {
    return 'Foto';
  }
  if (type === 'video' || mediaMimetype.startsWith('video/')) {
    return 'Video';
  }
  if (type === 'audio' || type === 'ptt' || mediaMimetype.startsWith('audio/')) {
    return 'Audio';
  }

  switch (type) {
    case 'document':
      return 'Documento';
    case 'sticker':
      return 'Figurinha';
    case 'revoked':
      return 'Mensagem apagada';
    default:
      return hasMedia ? '[mídia]' : '';
  }
}
