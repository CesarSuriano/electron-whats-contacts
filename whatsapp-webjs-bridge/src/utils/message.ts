import type { RawMessage } from '../domain/types.js';
import {
  readMessageMediaMimetype,
  isLikelyMediaMessage,
  isLikelyInlineMediaBody
} from './media.js';

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
