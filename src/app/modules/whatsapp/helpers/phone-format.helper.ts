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
