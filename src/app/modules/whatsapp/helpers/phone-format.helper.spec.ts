import { extractDigits, formatBrazilianPhone, getInitials, resolveDisplayedPhoneSource } from './phone-format.helper';

describe('extractDigits', () => {
  it('returns empty string for null', () => {
    expect(extractDigits(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(extractDigits(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(extractDigits('')).toBe('');
  });

  it('strips @c.us suffix and keeps only digits', () => {
    expect(extractDigits('5511987654321@c.us')).toBe('5511987654321');
  });

  it('strips @lid suffix and keeps only digits', () => {
    expect(extractDigits('55119876@lid')).toBe('55119876');
  });

  it('strips colon separator (takes part before colon)', () => {
    expect(extractDigits('55:0@c.us')).toBe('55');
  });

  it('removes non-digit characters from plain string', () => {
    expect(extractDigits('+55 (11) 98765-4321')).toBe('5511987654321');
  });

  it('returns digits from numeric-only string', () => {
    expect(extractDigits('5511999887766')).toBe('5511999887766');
  });
});

describe('formatBrazilianPhone', () => {
  it('returns empty string for null', () => {
    expect(formatBrazilianPhone(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(formatBrazilianPhone(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(formatBrazilianPhone('')).toBe('');
  });

  it('formats 13-digit number with country code (11-digit local)', () => {
    // 5511987654321 -> local = 11987654321 (11 digits)
    expect(formatBrazilianPhone('5511987654321')).toBe('+55 (11) 98765-4321');
  });

  it('formats 12-digit number with country code (10-digit local)', () => {
    // 551187654321 -> local = 1187654321 (10 digits)
    expect(formatBrazilianPhone('551187654321')).toBe('+55 (11) 8765-4321');
  });

  it('formats JID with @c.us suffix', () => {
    expect(formatBrazilianPhone('5511987654321@c.us')).toBe('+55 (11) 98765-4321');
  });

  it('returns +digits for numbers longer than 11 digits without BR prefix', () => {
    // e.g. 14 digits not starting with 55
    const result = formatBrazilianPhone('44123456789012');
    expect(result).toBe('+44123456789012');
  });

  it('returns raw digits for short numbers', () => {
    expect(formatBrazilianPhone('12345')).toBe('12345');
  });
});

describe('resolveDisplayedPhoneSource', () => {
  it('does not expose @lid digits as a public phone', () => {
    expect(resolveDisplayedPhoneSource({
      jid: '120363999999999999@lid',
      phone: '120363999999999999'
    })).toBe('');
  });

  it('prefers jid digits when the phone field looks like a linked-id', () => {
    expect(resolveDisplayedPhoneSource({
      jid: '5511987654321@c.us',
      phone: '120363999999999999'
    })).toBe('5511987654321');
  });

  it('keeps the richer Brazilian mobile variant when phone and jid differ only by ninth digit', () => {
    expect(resolveDisplayedPhoneSource({
      jid: '551187654321@c.us',
      phone: '5511987654321'
    })).toBe('5511987654321');
  });

  it('prefers jid digits when phone and conversation jid conflict', () => {
    expect(resolveDisplayedPhoneSource({
      jid: '5511987654321@c.us',
      phone: '5511912345678'
    })).toBe('5511987654321');
  });
});

describe('getInitials', () => {
  it('returns fallback for null', () => {
    expect(getInitials(null)).toBe('?');
  });

  it('returns fallback for undefined', () => {
    expect(getInitials(undefined)).toBe('?');
  });

  it('returns fallback for empty string', () => {
    expect(getInitials('')).toBe('?');
  });

  it('returns fallback for whitespace-only string', () => {
    expect(getInitials('   ')).toBe('?');
  });

  it('returns custom fallback when provided', () => {
    expect(getInitials(null, 'N/A')).toBe('N/A');
  });

  it('returns first two chars uppercased for single word', () => {
    expect(getInitials('carlos')).toBe('CA');
  });

  it('returns first char of first and last word for multiple words', () => {
    expect(getInitials('Maria Oliveira')).toBe('MO');
  });

  it('uses first and last word when three or more words', () => {
    expect(getInitials('Ana Clara Silva')).toBe('AS');
  });

  it('uppercases the initials', () => {
    expect(getInitials('ana bia')).toBe('AB');
  });
});
