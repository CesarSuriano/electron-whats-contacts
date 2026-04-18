export function normalizePhone(raw: unknown): string {
  if (!raw || typeof raw !== 'string') {
    return '';
  }

  const userPart = raw.split('@')[0]?.split(':')[0] || raw;
  return userPart.replace(/\D/g, '');
}

export function brazilianAlternativeJid(jid: string): string | null {
  const phone = normalizePhone(jid);
  if (!phone.startsWith('55') || phone.length < 12 || phone.length > 13) {
    return null;
  }
  const ddd = phone.slice(2, 4);
  const local = phone.slice(4);
  if (phone.length === 13 && local[0] === '9') {
    return `55${ddd}${local.slice(1)}@c.us`;
  }
  if (phone.length === 12) {
    return `55${ddd}9${local}@c.us`;
  }
  return null;
}
