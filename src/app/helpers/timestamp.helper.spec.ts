import { formatTimestamp } from './timestamp.helper';

describe('formatTimestamp', () => {
  it('formats today\'s date', () => {
    const result = formatTimestamp(new Date());
    expect(typeof result).toBe('string');
    expect(result).toContain('Hoje');
  });

  it('formats a past date as locale string', () => {
    const result = formatTimestamp(new Date('2020-01-15T10:30:00.000Z'));
    expect(typeof result).toBe('string');
    expect(result).toBeTruthy();
  });

  it('formats a Date object', () => {
    const result = formatTimestamp(new Date('2024-06-15'));
    expect(typeof result).toBe('string');
    expect(result).toBeTruthy();
  });
});
