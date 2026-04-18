/**
 * JID-related functions that depend on the WhatsApp client.
 * Call init(client) once the client object is available.
 */

import { normalizeJid, normalizePhone, isSamePhoneJid, isValidPersonalJid } from './utils.js';

let _client = null;
const knownSelfJids = new Set();

function serializeWidLike(value) {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return normalizeJid(value);
  }

  if (typeof value?._serialized === 'string') {
    return normalizeJid(value._serialized);
  }

  const user = typeof value?.user === 'string' ? value.user.trim() : '';
  const server = typeof value?.server === 'string' ? value.server.trim() : '';
  if (user && server) {
    return normalizeJid(`${user}@${server}`);
  }

  return '';
}

function listOwnJids(client = _client) {
  const candidates = [
    serializeWidLike(client?.info?.wid),
    serializeWidLike(client?.info?.me),
    serializeWidLike(client?.info?.user)
  ];

  for (const jid of knownSelfJids) {
    candidates.push(serializeWidLike(jid));
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

export function init(client) {
  _client = client;
  knownSelfJids.clear();
}

export function getOwnJid() {
  const ownJids = listOwnJids();
  return ownJids.find(isValidPersonalJid) || ownJids[0] || '';
}

export function registerSelfJid(jid) {
  const normalized = serializeWidLike(jid);
  if (normalized) {
    knownSelfJids.add(normalized);
  }
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

  const ownJids = listOwnJids();
  if (!ownJids.length) {
    return false;
  }

  const from = typeof message?.from === 'string' ? message.from : '';
  const author = typeof message?.author === 'string' ? message.author : '';
  return ownJids.some(ownJid => isSamePhoneJid(from, ownJid) || isSamePhoneJid(author, ownJid));
}

export function isSelfJid(jid) {
  const ownJids = listOwnJids();
  if (!ownJids.length || !jid) {
    return false;
  }

  return ownJids.some(ownJid => isSamePhoneJid(ownJid, jid));
}
