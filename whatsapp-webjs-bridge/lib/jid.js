/**
 * JID-related functions that depend on the WhatsApp client.
 * Call init(client) once the client object is available.
 */

import { normalizeJid, normalizePhone, isSamePhoneJid } from './utils.js';

let _client = null;

export function init(client) {
  _client = client;
}

export function getOwnJid() {
  return normalizeJid(_client?.info?.wid?._serialized || '');
}

export function getSerializedMessageId(message) {
  const rawId = message?.id;
  if (!rawId) {
    return '';
  }

  if (typeof rawId === 'string') {
    return rawId;
  }

  if (typeof rawId?._serialized === 'string') {
    return rawId._serialized;
  }

  return '';
}

export function resolveIsFromMe(message) {
  if (!message) {
    return false;
  }

  if (typeof message?.id?.fromMe === 'boolean') {
    return message.id.fromMe;
  }

  const serializedId = getSerializedMessageId(message);
  if (serializedId.startsWith('true_')) {
    return true;
  }
  if (serializedId.startsWith('false_')) {
    return false;
  }

  if (typeof message?.fromMe === 'boolean') {
    return message.fromMe;
  }

  if (typeof message?.fromMe === 'number') {
    return message.fromMe === 1;
  }

  if (typeof message?.fromMe === 'string') {
    const normalized = message.fromMe.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') {
      return true;
    }
    if (normalized === 'false' || normalized === '0') {
      return false;
    }
  }

  const ownJid = getOwnJid();
  if (!ownJid) {
    return false;
  }

  const from = typeof message?.from === 'string' ? message.from : '';
  const author = typeof message?.author === 'string' ? message.author : '';
  return isSamePhoneJid(from, ownJid) || isSamePhoneJid(author, ownJid);
}

export function isSelfJid(jid) {
  const ownJid = getOwnJid();
  if (!ownJid || !jid) {
    return false;
  }

  return isSamePhoneJid(ownJid, jid);
}
