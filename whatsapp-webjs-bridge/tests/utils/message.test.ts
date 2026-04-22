import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBlankMessage,
  readMessageTimestampSeconds,
  readMessageText,
  resolveMessagePreviewText
} from '../../src/utils/message.js';

const RAW_JPEG_BASE64 = '/9j/' + 'A'.repeat(320);

describe('isBlankMessage', () => {
  it('blank body and no media is blank', () => {
    assert.equal(isBlankMessage({ body: '', hasMedia: false }), true);
  });

  it('whitespace-only body is blank', () => {
    assert.equal(isBlankMessage({ body: '   ', hasMedia: false }), true);
  });

  it('non-empty body is not blank', () => {
    assert.equal(isBlankMessage({ body: 'hello', hasMedia: false }), false);
  });

  it('media message is not blank', () => {
    assert.equal(isBlankMessage({ body: '', hasMedia: true }), false);
  });

  it('body + media is not blank', () => {
    assert.equal(isBlankMessage({ body: 'hi', hasMedia: true }), false);
  });

  it('null message is blank', () => {
    assert.equal(isBlankMessage(null), true);
  });

  it('missing fields treated as blank', () => {
    assert.equal(isBlankMessage({}), true);
  });
});

describe('readMessageTimestampSeconds', () => {
  it('reads timestamp field', () => {
    assert.equal(readMessageTimestampSeconds({ timestamp: 1700000000 }), 1700000000);
  });

  it('reads t field', () => {
    assert.equal(readMessageTimestampSeconds({ t: 1700000001 }), 1700000001);
  });

  it('reads _data.t field', () => {
    assert.equal(readMessageTimestampSeconds({ _data: { t: 1700000002 } }), 1700000002);
  });

  it('reads msgTimestamp field', () => {
    assert.equal(readMessageTimestampSeconds({ msgTimestamp: 1700000003 }), 1700000003);
  });

  it('returns 0 for missing fields', () => {
    assert.equal(readMessageTimestampSeconds({}), 0);
  });

  it('returns 0 for null', () => {
    assert.equal(readMessageTimestampSeconds(null), 0);
  });

  it('returns 0 for non-numeric timestamp', () => {
    assert.equal(readMessageTimestampSeconds({ timestamp: Number('NaN') }), 0);
  });

  it('returns 0 for negative timestamp', () => {
    assert.equal(readMessageTimestampSeconds({ timestamp: -1 }), 0);
  });
});

describe('readMessageText', () => {
  it('reads body', () => {
    assert.equal(readMessageText({ body: 'Olá' }), 'Olá');
  });

  it('reads caption when no body', () => {
    assert.equal(readMessageText({ caption: 'Caption' }), 'Caption');
  });

  it('prefers body over caption', () => {
    assert.equal(readMessageText({ body: 'Body', caption: 'Caption' }), 'Body');
  });

  it('ignores media data URL body and falls back to caption', () => {
    assert.equal(
      readMessageText({ body: 'data:image/png;base64,abc', hasMedia: true, caption: 'Imagem com legenda' }),
      'Imagem com legenda'
    );
  });

  it('ignores media data URL body when no caption is available', () => {
    assert.equal(readMessageText({ body: 'data:image/png;base64,abc', hasMedia: true }), '');
  });

  it('ignores raw JPEG base64 body when no caption is available', () => {
    assert.equal(
      readMessageText({ body: RAW_JPEG_BASE64, hasMedia: true, type: 'image' }),
      ''
    );
  });

  it('returns empty when no text fields', () => {
    assert.equal(readMessageText({}), '');
  });

  it('returns empty for null', () => {
    assert.equal(readMessageText(null), '');
  });
});

describe('resolveMessagePreviewText', () => {
  it('returns body when present', () => {
    assert.equal(resolveMessagePreviewText({ body: 'Olá!' }), 'Olá!');
  });

  it('trims whitespace', () => {
    assert.equal(resolveMessagePreviewText({ body: '  trimmed  ' }), 'trimmed');
  });

  it('treats image data URL body as media preview', () => {
    assert.equal(
      resolveMessagePreviewText({ body: 'data:image/jpeg;base64,abc', hasMedia: true }),
      'Foto'
    );
  });

  it('prefers caption when body is data URL media', () => {
    assert.equal(
      resolveMessagePreviewText({ body: 'data:image/jpeg;base64,abc', hasMedia: true, caption: 'Legenda' }),
      'Legenda'
    );
  });

  it('treats raw JPEG base64 body as image media preview', () => {
    assert.equal(
      resolveMessagePreviewText({ body: RAW_JPEG_BASE64, hasMedia: true, type: 'image' }),
      'Foto'
    );
  });

  it('maps type → preview labels', () => {
    assert.equal(resolveMessagePreviewText({ type: 'image' }), 'Foto');
    assert.equal(resolveMessagePreviewText({ type: 'video' }), 'Vídeo');
    assert.equal(resolveMessagePreviewText({ type: 'audio' }), 'Áudio');
    assert.equal(resolveMessagePreviewText({ type: 'ptt' }), 'Áudio');
    assert.equal(resolveMessagePreviewText({ type: 'document' }), 'Documento');
    assert.equal(resolveMessagePreviewText({ type: 'sticker' }), 'Figurinha');
    assert.equal(resolveMessagePreviewText({ type: 'revoked' }), 'Mensagem apagada');
    assert.equal(resolveMessagePreviewText({ type: 'location' }), 'Localização');
    assert.equal(resolveMessagePreviewText({ type: 'poll_creation' }), 'Enquete');
  });

  it('unknown type with media → [mídia]', () => {
    assert.equal(resolveMessagePreviewText({ type: 'unknown', hasMedia: true }), '[mídia]');
  });

  it('unknown type without media → empty', () => {
    assert.equal(resolveMessagePreviewText({ type: 'unknown', hasMedia: false }), 'Mensagem');
  });

  it('null → empty', () => {
    assert.equal(resolveMessagePreviewText(null), '');
  });
});
