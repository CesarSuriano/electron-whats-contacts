import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, brazilianAlternativeJid } from '../../src/utils/phone.js';

describe('normalizePhone', () => {
  it('strips @c.us suffix', () => {
    assert.equal(normalizePhone('5511987654321@c.us'), '5511987654321');
  });

  it('strips @lid suffix', () => {
    assert.equal(normalizePhone('55119876@lid'), '55119876');
  });

  it('returns empty for empty string', () => {
    assert.equal(normalizePhone(''), '');
  });

  it('returns empty for null', () => {
    assert.equal(normalizePhone(null), '');
  });

  it('returns empty for undefined', () => {
    assert.equal(normalizePhone(undefined), '');
  });

  it('returns empty for non-string', () => {
    assert.equal(normalizePhone(123), '');
  });

  it('strips non-digits', () => {
    assert.equal(normalizePhone('5511 98765-4321'), '5511987654321');
  });

  it('handles colon separator', () => {
    assert.equal(normalizePhone('55:0@c.us'), '55');
  });

  it('handles unicode whitespace and punctuation', () => {
    assert.equal(normalizePhone('+55 (11) 9\u00a07654-3210'), '5511976543210');
  });
});

describe('brazilianAlternativeJid', () => {
  it('removes 9 from 13-digit number', () => {
    assert.equal(brazilianAlternativeJid('5511987654321@c.us'), '551187654321@c.us');
  });

  it('adds 9 to 12-digit number', () => {
    assert.equal(brazilianAlternativeJid('551187654321@c.us'), '5511987654321@c.us');
  });

  it('returns null for short number', () => {
    assert.equal(brazilianAlternativeJid('5511111@c.us'), null);
  });

  it('returns null for non-BR number', () => {
    assert.equal(brazilianAlternativeJid('441234567890@c.us'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(brazilianAlternativeJid(''), null);
  });

  it('returns null for too-long number', () => {
    assert.equal(brazilianAlternativeJid('5511912345678901@c.us'), null);
  });

  it('returns null for 13-digit BR number without leading 9 in local', () => {
    assert.equal(brazilianAlternativeJid('5511876543210x@c.us'), null);
  });
});
