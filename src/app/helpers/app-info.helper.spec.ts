import { APP_VERSION, APP_WHATS_NEW } from './app-info.helper';

describe('APP_VERSION', () => {
  it('is a non-empty string', () => {
    expect(typeof APP_VERSION).toBe('string');
    expect(APP_VERSION.length).toBeGreaterThan(0);
  });
});

describe('APP_WHATS_NEW', () => {
  it('is an array', () => {
    expect(Array.isArray(APP_WHATS_NEW)).toBe(true);
  });

  it('has at least one entry', () => {
    expect(APP_WHATS_NEW.length).toBeGreaterThan(0);
  });

  it('all entries are non-empty strings', () => {
    APP_WHATS_NEW.forEach(entry => {
      expect(typeof entry).toBe('string');
      expect(entry.length).toBeGreaterThan(0);
    });
  });
});
