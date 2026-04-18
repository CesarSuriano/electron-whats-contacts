import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  readMessageInlineImageDataUrl,
  readMessageMediaMimetype,
  isLikelyMediaMessage,
  isDataUrl,
  isLikelyRawImageBase64
} from '../../src/utils/media.js';

const RAW_JPEG_BASE64 = '/9j/' + 'A'.repeat(320);
const RAW_PNG_BASE64 = 'iVBORw0KGgo' + 'A'.repeat(321);
const RAW_GIF_BASE64 = 'R0lGOD' + 'A'.repeat(322);
const RAW_WEBP_BASE64 = 'UklGR' + 'A'.repeat(323);

describe('isDataUrl', () => {
  it('recognizes image data URLs', () => {
    assert.equal(isDataUrl('data:image/png;base64,abc'), true);
    assert.equal(isDataUrl('data:application/pdf;base64,abc'), true);
  });

  it('rejects non data URLs', () => {
    assert.equal(isDataUrl('https://example.com/x.png'), false);
    assert.equal(isDataUrl('abc'), false);
    assert.equal(isDataUrl(null), false);
  });
});

describe('isLikelyRawImageBase64', () => {
  it('accepts JPEG/PNG/GIF/WEBP magic prefixes at sufficient length', () => {
    assert.equal(isLikelyRawImageBase64(RAW_JPEG_BASE64), true);
    assert.equal(isLikelyRawImageBase64(RAW_PNG_BASE64), true);
    assert.equal(isLikelyRawImageBase64(RAW_GIF_BASE64), true);
    assert.equal(isLikelyRawImageBase64(RAW_WEBP_BASE64), true);
  });

  it('rejects short strings', () => {
    assert.equal(isLikelyRawImageBase64('/9j/abc'), false);
  });

  it('rejects strings with invalid base64 chars', () => {
    assert.equal(isLikelyRawImageBase64('/9j/' + '!'.repeat(320)), false);
  });
});

describe('readMessageInlineImageDataUrl', () => {
  it('reads inline image data URL from body', () => {
    assert.equal(
      readMessageInlineImageDataUrl({ body: 'data:image/png;base64,abc' }),
      'data:image/png;base64,abc'
    );
  });

  it('ignores non-image data URL', () => {
    assert.equal(
      readMessageInlineImageDataUrl({ body: 'data:application/pdf;base64,abc' }),
      null
    );
  });

  it('reads inline image data URL from mediaDataUrl field', () => {
    assert.equal(
      readMessageInlineImageDataUrl({ mediaDataUrl: 'data:image/jpeg;base64,def' }),
      'data:image/jpeg;base64,def'
    );
  });

  it('converts raw JPEG base64 body into image data URL', () => {
    assert.equal(
      readMessageInlineImageDataUrl({ body: RAW_JPEG_BASE64, hasMedia: true, type: 'image' }),
      `data:image/jpeg;base64,${RAW_JPEG_BASE64}`
    );
  });

  it('converts raw PNG base64 body into image data URL', () => {
    assert.equal(
      readMessageInlineImageDataUrl({ body: RAW_PNG_BASE64, hasMedia: true, type: 'image' }),
      `data:image/jpeg;base64,${RAW_PNG_BASE64}`
    );
  });

  it('uses explicit mimetype when converting raw base64 body', () => {
    assert.equal(
      readMessageInlineImageDataUrl({
        body: RAW_WEBP_BASE64,
        hasMedia: true,
        type: 'image',
        _data: { mimetype: 'image/webp' }
      }),
      `data:image/webp;base64,${RAW_WEBP_BASE64}`
    );
  });

  it('returns null for null input', () => {
    assert.equal(readMessageInlineImageDataUrl(null), null);
  });

  it('reads data URL from _data.body fallback', () => {
    assert.equal(
      readMessageInlineImageDataUrl({ _data: { body: 'data:image/gif;base64,xyz' } }),
      'data:image/gif;base64,xyz'
    );
  });
});

describe('readMessageMediaMimetype', () => {
  it('reads explicit mimetype from _data', () => {
    assert.equal(
      readMessageMediaMimetype({ _data: { mimetype: 'audio/ogg' } }),
      'audio/ogg'
    );
  });

  it('reads direct mimetype field', () => {
    assert.equal(readMessageMediaMimetype({ mimetype: 'video/mp4' }), 'video/mp4');
  });

  it('derives mimetype from inline image data URL when explicit is missing', () => {
    assert.equal(
      readMessageMediaMimetype({ body: 'data:image/png;base64,abc' }),
      'image/png'
    );
  });

  it('returns empty for non-media message', () => {
    assert.equal(readMessageMediaMimetype({ body: 'hello' }), '');
  });
});

describe('isLikelyMediaMessage', () => {
  it('true for explicit hasMedia', () => {
    assert.equal(isLikelyMediaMessage({ hasMedia: true }), true);
  });

  it('true for known media types', () => {
    assert.equal(isLikelyMediaMessage({ type: 'image' }), true);
    assert.equal(isLikelyMediaMessage({ type: 'video' }), true);
    assert.equal(isLikelyMediaMessage({ type: 'audio' }), true);
    assert.equal(isLikelyMediaMessage({ type: 'ptt' }), true);
    assert.equal(isLikelyMediaMessage({ type: 'document' }), true);
    assert.equal(isLikelyMediaMessage({ type: 'sticker' }), true);
  });

  it('false for pure text', () => {
    assert.equal(isLikelyMediaMessage({ body: 'hello', type: 'chat' }), false);
  });

  it('false for null', () => {
    assert.equal(isLikelyMediaMessage(null), false);
  });
});
