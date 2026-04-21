import { normalizePhone } from './phone.js';

export function normalizeJid(input: unknown): string {
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

export function isSamePhoneJid(a: unknown, b: unknown): boolean {
  const aPhone = normalizePhone(a);
  const bPhone = normalizePhone(b);
  return Boolean(aPhone) && Boolean(bPhone) && aPhone === bPhone;
}

export function isPersonalJid(jid: unknown): jid is string {
  return typeof jid === 'string' && jid.endsWith('@c.us');
}

export function isGroupJid(jid: unknown): jid is string {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

export function isLinkedId(jid: unknown): jid is string {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

export function isBroadcastJid(jid: unknown): jid is string {
  return typeof jid === 'string' && jid.endsWith('@broadcast');
}

export function isStatusBroadcastJid(jid: unknown): jid is string {
  return jid === 'status@broadcast';
}

export function isPersonalOrLinkedJid(jid: unknown): jid is string {
  return isPersonalJid(jid) || isLinkedId(jid);
}

export function isSameConversationJid(a: string | null | undefined, b: string | null | undefined): boolean {
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

export function normalizeRequestedChatJid(raw: unknown): string {
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

export function isValidPersonalJid(jid: unknown): jid is string {
  if (!isPersonalJid(jid)) {
    return false;
  }

  const phone = normalizePhone(jid);
  return phone.length >= 8;
}
