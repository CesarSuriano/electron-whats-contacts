import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getContactName, extractLastMessagePreview } from '../../src/utils/contact.js';

const RAW_JPEG_BASE64 = '/9j/' + 'A'.repeat(320);

describe('getContactName', () => {
  it('returns name', () => {
    assert.equal(getContactName({ name: 'Ana Silva' }), 'Ana Silva');
  });

  it('falls back to pushname', () => {
    assert.equal(getContactName({ pushname: 'Ana' }), 'Ana');
  });

  it('falls back to shortName', () => {
    assert.equal(getContactName({ shortName: 'A' }), 'A');
  });

  it('falls back to normalized phone from id', () => {
    assert.equal(getContactName({ id: { _serialized: '5511@c.us' } }), '5511');
  });

  it('returns empty for empty object', () => {
    assert.equal(getContactName({}), '');
  });

  it('returns empty for null', () => {
    assert.equal(getContactName(null), '');
  });

  it('skips blank name and uses pushname', () => {
    assert.equal(getContactName({ name: '  ', pushname: 'João' }), 'João');
  });
});

describe('extractLastMessagePreview', () => {
  it('returns message body', () => {
    assert.equal(extractLastMessagePreview({ lastMessage: { body: 'Oi' } }), 'Oi');
  });

  it('uses media placeholder when lastMessage body is data URL image', () => {
    assert.equal(
      extractLastMessagePreview({ lastMessage: { body: 'data:image/jpeg;base64,abc', hasMedia: true } }),
      'Foto'
    );
  });

  it('prefers caption when lastMessage body is data URL image', () => {
    assert.equal(
      extractLastMessagePreview({ lastMessage: { body: 'data:image/jpeg;base64,abc', hasMedia: true, caption: 'Legenda' } }),
      'Legenda'
    );
  });

  it('uses image placeholder when lastMessage body is raw JPEG base64', () => {
    assert.equal(
      extractLastMessagePreview({ lastMessage: { body: RAW_JPEG_BASE64, hasMedia: true, type: 'image' } }),
      'Foto'
    );
  });

  it('maps type → preview labels', () => {
    assert.equal(extractLastMessagePreview({ lastMessage: { type: 'image' } }), 'Foto');
    assert.equal(extractLastMessagePreview({ lastMessage: { type: 'video' } }), 'Video');
    assert.equal(extractLastMessagePreview({ lastMessage: { type: 'audio' } }), 'Audio');
    assert.equal(extractLastMessagePreview({ lastMessage: { type: 'ptt' } }), 'Audio');
    assert.equal(extractLastMessagePreview({ lastMessage: { type: 'document' } }), 'Documento');
    assert.equal(extractLastMessagePreview({ lastMessage: { type: 'sticker' } }), 'Figurinha');
    assert.equal(extractLastMessagePreview({ lastMessage: { type: 'revoked' } }), 'Mensagem apagada');
  });

  it('returns empty for notification-like messages', () => {
    assert.equal(extractLastMessagePreview({ lastMessage: { type: 'e2e_notification' } }), '');
    assert.equal(extractLastMessagePreview({ lastMessage: { type: 'call_log' } }), '');
    assert.equal(extractLastMessagePreview({ lastMessage: { isNotification: true } }), '');
  });

  it('unknown type with media → [mídia]', () => {
    assert.equal(extractLastMessagePreview({ lastMessage: { hasMedia: true } }), '[mídia]');
  });

  it('returns empty when there is no lastMessage', () => {
    assert.equal(extractLastMessagePreview({}), '');
    assert.equal(extractLastMessagePreview(null), '');
  });
});
