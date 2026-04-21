import type { RawMessage } from '../domain/types.js';
import { isBroadcastJid, isStatusBroadcastJid } from './jid.js';
import {
  readMessageMediaMimetype,
  isLikelyMediaMessage,
  isLikelyInlineMediaBody
} from './media.js';

function readJidCandidate(candidate: unknown): string {
  if (typeof candidate === 'string') {
    return candidate.trim();
  }

  if (candidate && typeof candidate === 'object') {
    const record = candidate as { _serialized?: unknown };
    if (typeof record._serialized === 'string') {
      return record._serialized.trim();
    }
  }

  return '';
}

function collectMessageJids(message: RawMessage | null | undefined): string[] {
  if (!message) {
    return [];
  }

  return [
    readJidCandidate(message.from),
    readJidCandidate(message.to),
    readJidCandidate(message.author),
    readJidCandidate(message.chatId),
    readJidCandidate(message.chat?.id),
    readJidCandidate(typeof message.id === 'object' ? message.id?.remote : undefined),
    readJidCandidate(message._data?.from),
    readJidCandidate(message._data?.to)
  ].filter(Boolean);
}

export function isIgnoredWhatsappMessage(message: RawMessage | null | undefined): boolean {
  if (!message) {
    return true;
  }

  const type = typeof message.type === 'string' ? message.type.trim().toLowerCase() : '';
  if (
    message.isNotification
    || type === 'e2e_notification'
    || type === 'notification_template'
    || type === 'call_log'
    || type === 'protocol'
    || type === 'status'
    || type === 'status_notification'
  ) {
    return true;
  }

  return collectMessageJids(message).some(jid => isStatusBroadcastJid(jid) || isBroadcastJid(jid));
}

export function isBlankMessage(message: RawMessage | null | undefined): boolean {
  const body = typeof message?.body === 'string' ? message.body.trim() : '';
  const hasMedia = Boolean(message?.hasMedia);
  return !body && !hasMedia;
}

export function readMessageTimestampSeconds(message: RawMessage | null | undefined): number {
  if (!message) {
    return 0;
  }
  const candidates = [
    message.timestamp,
    message.t,
    message._data?.t,
    message.msgTimestamp
  ];

  for (const raw of candidates) {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return 0;
}

export function readMessageText(message: RawMessage | null | undefined): string {
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

export function resolveMessagePreviewText(message: RawMessage | null | undefined): string {
  if (isIgnoredWhatsappMessage(message)) {
    return '';
  }

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
