import type { RawChat, RawContact } from '../domain/types.js';
import { normalizePhone } from './phone.js';
import { readMessageMediaMimetype, isLikelyInlineMediaBody, isLikelyMediaMessage } from './media.js';

export function getContactName(contactData: RawContact | null | undefined): string {
  if (!contactData) {
    return '';
  }

  const candidate = [
    contactData.name,
    contactData.pushname,
    contactData.shortName,
    normalizePhone(contactData.id?._serialized || '')
  ].find(value => typeof value === 'string' && value.trim().length > 0);

  return candidate || '';
}

export function extractLastMessagePreview(chat: RawChat | null | undefined): string {
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
