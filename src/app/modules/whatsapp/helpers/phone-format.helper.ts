export function extractDigits(raw: string | null | undefined): string {
  if (!raw || typeof raw !== 'string') {
    return '';
  }

  const userPart = raw.split('@')[0]?.split(':')[0] || raw;
  return userPart.replace(/\D/g, '');
}

export function formatBrazilianPhone(raw: string | null | undefined): string {
  const digits = extractDigits(raw);
  if (!digits) {
    return '';
  }

  const withoutCountry = digits.startsWith('55') && digits.length > 11
    ? digits.slice(2)
    : digits;

  if (withoutCountry.length === 11) {
    const ddd = withoutCountry.slice(0, 2);
    const first = withoutCountry.slice(2, 7);
    const last = withoutCountry.slice(7);
    return `+55 (${ddd}) ${first}-${last}`;
  }

  if (withoutCountry.length === 10) {
    const ddd = withoutCountry.slice(0, 2);
    const first = withoutCountry.slice(2, 6);
    const last = withoutCountry.slice(6);
    return `+55 (${ddd}) ${first}-${last}`;
  }

  if (digits.length > 11) {
    return `+${digits}`;
  }

  return digits;
}

function isLikelyPublicPhone(value: string): boolean {
  return value.length >= 10 && value.length <= 15;
}

function looksLikeLinkedId(value: string): boolean {
  return value.length > 15;
}

function areBrazilianVariants(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    const withoutCountry = value.startsWith('55') ? value.slice(2) : value;
    if (withoutCountry.length !== 10 && withoutCountry.length !== 11) {
      return '';
    }

    const ddd = withoutCountry.slice(0, 2);
    const local = withoutCountry.slice(2);
    const withoutNinth = local.length === 9 && local.startsWith('9')
      ? local.slice(1)
      : local;

    return `${ddd}:${withoutNinth}`;
  };

  const normalizedA = normalize(a);
  const normalizedB = normalize(b);
  return Boolean(normalizedA && normalizedB && normalizedA === normalizedB);
}

export function resolveDisplayedPhoneSource(contact: { jid?: string | null; phone?: string | null }): string {
  const jid = typeof contact.jid === 'string' ? contact.jid.trim() : '';
  const phoneDigits = extractDigits(contact.phone || '');
  const jidDigits = extractDigits(jid);

  if (jid.endsWith('@g.us')) {
    return '';
  }

  if (jid.endsWith('@lid')) {
    return isLikelyPublicPhone(phoneDigits) ? phoneDigits : '';
  }

  if (jid.endsWith('@c.us')) {
    if (!phoneDigits) {
      return jidDigits;
    }

    if (!jidDigits) {
      return isLikelyPublicPhone(phoneDigits) ? phoneDigits : '';
    }

    if (areBrazilianVariants(phoneDigits, jidDigits)) {
      return phoneDigits.length >= jidDigits.length ? phoneDigits : jidDigits;
    }

    if (looksLikeLinkedId(phoneDigits) && isLikelyPublicPhone(jidDigits)) {
      return jidDigits;
    }

    if (isLikelyPublicPhone(phoneDigits) && isLikelyPublicPhone(jidDigits) && phoneDigits !== jidDigits) {
      return jidDigits;
    }

    return isLikelyPublicPhone(phoneDigits) ? phoneDigits : jidDigits;
  }

  if (isLikelyPublicPhone(phoneDigits)) {
    return phoneDigits;
  }

  return jidDigits;
}

export function getInitials(name: string | null | undefined, fallback = '?'): string {
  if (!name || typeof name !== 'string') {
    return fallback;
  }

  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return fallback;
  }

  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
