import type { RawMessage } from '../domain/types.js';

const DATA_URL_PATTERN = /^data:[^,]+,/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const RAW_IMAGE_BASE64_SIGNATURE_PATTERN = /^(\/9j\/|iVBORw0KGgo|R0lGOD|UklGR)/;

export function isDataUrl(value: unknown): boolean {
  return typeof value === 'string' && DATA_URL_PATTERN.test(value.trim());
}

export function normalizeBase64Candidate(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, '') : '';
}

export function isLikelyRawImageBase64(value: unknown): boolean {
  const normalized = normalizeBase64Candidate(value);
  if (normalized.length < 256) {
    return false;
  }

  if (normalized.length % 4 === 1) {
    return false;
  }

  if (!BASE64_PATTERN.test(normalized)) {
    return false;
  }

  return RAW_IMAGE_BASE64_SIGNATURE_PATTERN.test(normalized);
}

export function readExplicitMessageMediaMimetype(message: RawMessage | null | undefined): string {
  const fromData = typeof message?._data?.mimetype === 'string' ? message._data.mimetype.trim() : '';
  if (fromData) {
    return fromData;
  }

  const direct = typeof message?.mimetype === 'string' ? message.mimetype.trim() : '';
  if (direct) {
    return direct;
  }

  return '';
}

export function isLikelyInlineMediaBody(value: unknown, message: RawMessage | null | undefined): boolean {
  if (!value) {
    return false;
  }

  if (isDataUrl(value)) {
    return true;
  }

  const mediaMimetype = readExplicitMessageMediaMimetype(message).toLowerCase();
  const type = typeof message?.type === 'string' ? message.type : '';
  const imageHint = mediaMimetype.startsWith('image/') || type === 'image' || Boolean(message?.hasMedia);

  return imageHint && isLikelyRawImageBase64(value);
}

export function readMessageInlineImageDataUrl(message: RawMessage | null | undefined): string | null {
  if (!message) {
    return null;
  }

  const explicitMimetype = readExplicitMessageMediaMimetype(message).toLowerCase();
  const type = typeof message.type === 'string' ? message.type : '';
  const imageHint = explicitMimetype.startsWith('image/') || type === 'image' || Boolean(message.hasMedia);

  const candidates = [
    typeof message.body === 'string' ? message.body.trim() : '',
    typeof message.mediaDataUrl === 'string' ? message.mediaDataUrl.trim() : '',
    typeof message._data?.body === 'string' ? message._data.body.trim() : ''
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (isDataUrl(candidate)) {
      if (candidate.toLowerCase().startsWith('data:image/')) {
        return candidate;
      }
      continue;
    }

    if (imageHint && isLikelyRawImageBase64(candidate)) {
      const mimetype = explicitMimetype.startsWith('image/') ? explicitMimetype : 'image/jpeg';
      return `data:${mimetype};base64,${normalizeBase64Candidate(candidate)}`;
    }
  }

  return null;
}

export function readMessageMediaMimetype(message: RawMessage | null | undefined): string {
  const explicit = readExplicitMessageMediaMimetype(message);
  if (explicit) {
    return explicit;
  }

  const inlineImageDataUrl = readMessageInlineImageDataUrl(message);
  if (inlineImageDataUrl) {
    const match = inlineImageDataUrl.match(/^data:([^;,]+)/i);
    return match && typeof match[1] === 'string' ? match[1].toLowerCase() : '';
  }

  return '';
}

export function isLikelyMediaMessage(message: RawMessage | null | undefined): boolean {
  const type = typeof message?.type === 'string' ? message.type : '';
  const mediaMimetype = readMessageMediaMimetype(message);
  return Boolean(message?.hasMedia)
    || Boolean(mediaMimetype)
    || type === 'image'
    || type === 'video'
    || type === 'audio'
    || type === 'ptt'
    || type === 'document'
    || type === 'sticker';
}
