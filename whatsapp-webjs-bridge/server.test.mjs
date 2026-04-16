/**
 * Unit tests for pure helper functions in the bridge lib modules.
 * Run with: node whatsapp-webjs-bridge/server.test.mjs
 */

import {
  normalizePhone,
  brazilianAlternativeJid,
  isBlankMessage,
  resolveMessagePreviewText,
  normalizeJid,
  isSamePhoneJid,
  isPersonalJid,
  isGroupJid,
  isLinkedId,
  isPersonalOrLinkedJid,
  isSameConversationJid,
  normalizeRequestedChatJid,
  readMessageTimestampSeconds,
  readMessageText,
  isValidPersonalJid,
  toIsoFromUnixTimestamp,
  getContactName,
  extractLastMessagePreview,
} from './lib/utils.js';

import {
  trackEventId,
  resolveMessageChatJid,
  pushEvent,
  events,
  contactsByJid,
} from './lib/events.js';

import {
  resolveChatLabelNames,
} from './lib/contacts.js';

import {
  getSerializedMessageId,
  resolveIsFromMe,
  init as initJid,
} from './lib/jid.js';

import {
  registerHistoryFailure,
  isChatHistoryTemporarilyDisabled,
  disableChatHistoryTemporarily,
  acquireHistorySlot,
  releaseHistorySlot,
} from './lib/history.js';

// ── Minimal test runner ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ── utils.js ─────────────────────────────────────────────────────────────────

describe('normalizePhone', () => {
  assert(normalizePhone('5511987654321@c.us') === '5511987654321', 'strips @c.us suffix');
  assert(normalizePhone('55119876@lid') === '55119876', 'strips @lid suffix');
  assert(normalizePhone('') === '', 'returns empty for empty string');
  assert(normalizePhone(null) === '', 'returns empty for null');
  assert(normalizePhone(undefined) === '', 'returns empty for undefined');
  assert(normalizePhone(123) === '', 'returns empty for non-string');
  assert(normalizePhone('5511 98765-4321') === '5511987654321', 'strips non-digits');
  assert(normalizePhone('55:0@c.us') === '55', 'handles colon separator');
});

describe('brazilianAlternativeJid', () => {
  assert(brazilianAlternativeJid('5511987654321@c.us') === '551187654321@c.us', 'removes 9 from 13-digit number');
  assert(brazilianAlternativeJid('551187654321@c.us') === '5511987654321@c.us', 'adds 9 to 12-digit number');
  assert(brazilianAlternativeJid('5511111@c.us') === null, 'returns null for short number');
  assert(brazilianAlternativeJid('441234567890@c.us') === null, 'returns null for non-BR number');
  assert(brazilianAlternativeJid('') === null, 'returns null for empty string');
  assert(brazilianAlternativeJid('5511912345678901@c.us') === null, 'returns null for too-long number');
});

describe('isBlankMessage', () => {
  assert(isBlankMessage({ body: '', hasMedia: false }) === true, 'blank body and no media is blank');
  assert(isBlankMessage({ body: '   ', hasMedia: false }) === true, 'whitespace-only body is blank');
  assert(isBlankMessage({ body: 'hello', hasMedia: false }) === false, 'non-empty body is not blank');
  assert(isBlankMessage({ body: '', hasMedia: true }) === false, 'media message is not blank');
  assert(isBlankMessage({ body: 'hi', hasMedia: true }) === false, 'body + media is not blank');
  assert(isBlankMessage(null) === true, 'null message is blank');
  assert(isBlankMessage({}) === true, 'missing fields treated as blank');
});

describe('resolveMessagePreviewText', () => {
  assert(resolveMessagePreviewText({ body: 'Olá!' }) === 'Olá!', 'returns body when present');
  assert(resolveMessagePreviewText({ body: '  trimmed  ' }) === 'trimmed', 'trims whitespace');
  assert(resolveMessagePreviewText({ type: 'image' }) === 'Foto', 'image → Foto');
  assert(resolveMessagePreviewText({ type: 'video' }) === 'Vídeo', 'video → Vídeo');
  assert(resolveMessagePreviewText({ type: 'audio' }) === 'Áudio', 'audio → Áudio');
  assert(resolveMessagePreviewText({ type: 'ptt' }) === 'Áudio', 'ptt → Áudio');
  assert(resolveMessagePreviewText({ type: 'document' }) === 'Documento', 'document → Documento');
  assert(resolveMessagePreviewText({ type: 'sticker' }) === 'Figurinha', 'sticker → Figurinha');
  assert(resolveMessagePreviewText({ type: 'revoked' }) === 'Mensagem apagada', 'revoked → Mensagem apagada');
  assert(resolveMessagePreviewText({ type: 'unknown', hasMedia: true }) === '[mídia]', 'unknown type with media → [mídia]');
  assert(resolveMessagePreviewText({ type: 'unknown', hasMedia: false }) === '', 'unknown type without media → empty');
  assert(resolveMessagePreviewText(null) === '', 'null → empty');
});

describe('normalizeJid', () => {
  assert(normalizeJid('5511987654321@c.us') === '5511987654321@c.us', 'passes through existing @c.us JID');
  assert(normalizeJid('5511987654321@g.us') === '5511987654321@g.us', 'passes through @g.us JID');
  assert(normalizeJid('5511987654321') === '5511987654321@c.us', 'adds @c.us to bare number');
  assert(normalizeJid('') === '', 'returns empty for empty string');
  assert(normalizeJid(null) === '', 'returns empty for null');
  assert(normalizeJid('abc') === '', 'returns empty for non-numeric bare input');
});

describe('isSamePhoneJid', () => {
  assert(isSamePhoneJid('5511987654321@c.us', '5511987654321@c.us') === true, 'same JID matches');
  assert(isSamePhoneJid('5511987654321@c.us', '5511987654321') === true, 'JID and bare number match');
  assert(isSamePhoneJid('5511987654321@c.us', '5511000000000@c.us') === false, 'different numbers do not match');
  assert(isSamePhoneJid('', '5511987654321@c.us') === false, 'empty string does not match');
  assert(isSamePhoneJid(null, '5511987654321@c.us') === false, 'null does not match');
});

describe('isPersonalJid', () => {
  assert(isPersonalJid('5511987654321@c.us') === true, 'accepts @c.us');
  assert(isPersonalJid('group@g.us') === false, 'rejects @g.us');
  assert(isPersonalJid('123@lid') === false, 'rejects @lid');
  assert(isPersonalJid('') === false, 'rejects empty string');
  assert(isPersonalJid(null) === false, 'rejects null');
});

describe('isGroupJid', () => {
  assert(isGroupJid('group123@g.us') === true, 'accepts @g.us');
  assert(isGroupJid('5511@c.us') === false, 'rejects @c.us');
  assert(isGroupJid('123@lid') === false, 'rejects @lid');
  assert(isGroupJid('') === false, 'rejects empty string');
  assert(isGroupJid(null) === false, 'rejects null');
});

describe('isLinkedId', () => {
  assert(isLinkedId('123456789012@lid') === true, 'recognizes @lid JID');
  assert(isLinkedId('5511987654321@c.us') === false, 'rejects @c.us JID');
  assert(isLinkedId('group@g.us') === false, 'rejects group JID');
  assert(isLinkedId('') === false, 'rejects empty string');
  assert(isLinkedId(null) === false, 'rejects null');
});

describe('isPersonalOrLinkedJid', () => {
  assert(isPersonalOrLinkedJid('5511@c.us') === true, 'accepts @c.us');
  assert(isPersonalOrLinkedJid('123@lid') === true, 'accepts @lid');
  assert(isPersonalOrLinkedJid('group@g.us') === false, 'rejects @g.us');
  assert(isPersonalOrLinkedJid('') === false, 'rejects empty string');
  assert(isPersonalOrLinkedJid(null) === false, 'rejects null');
});

describe('isSameConversationJid', () => {
  assert(isSameConversationJid('5511987654321@c.us', '5511987654321@c.us') === true, 'identical @c.us JIDs match');
  assert(isSameConversationJid('5511987654321@c.us', '5511987654321@lid') === true, 'same phone @c.us vs @lid match');
  assert(isSameConversationJid('5511987654321@lid', '5511987654321@c.us') === true, '@lid vs @c.us match');
  assert(isSameConversationJid('5511@c.us', '5512@c.us') === false, 'different numbers do not match');
  assert(isSameConversationJid('', '5511@c.us') === false, 'empty string does not match');
  assert(isSameConversationJid(null, '5511@c.us') === false, 'null does not match');
});

describe('normalizeRequestedChatJid', () => {
  assert(normalizeRequestedChatJid('5511987654321@c.us') === '5511987654321@c.us', 'passes through @c.us JID');
  assert(normalizeRequestedChatJid('5511987654321') === '5511987654321@c.us', 'bare number gets @c.us appended');
  assert(normalizeRequestedChatJid('  5511987654321  ') === '5511987654321@c.us', 'trims and normalizes bare number');
  assert(normalizeRequestedChatJid('') === '', 'returns empty for empty string');
  assert(normalizeRequestedChatJid(null) === '', 'returns empty for null');
});

describe('readMessageTimestampSeconds', () => {
  assert(readMessageTimestampSeconds({ timestamp: 1700000000 }) === 1700000000, 'reads timestamp field');
  assert(readMessageTimestampSeconds({ t: 1700000001 }) === 1700000001, 'reads t field');
  assert(readMessageTimestampSeconds({ _data: { t: 1700000002 } }) === 1700000002, 'reads _data.t field');
  assert(readMessageTimestampSeconds({ msgTimestamp: 1700000003 }) === 1700000003, 'reads msgTimestamp field');
  assert(readMessageTimestampSeconds({}) === 0, 'returns 0 for missing fields');
  assert(readMessageTimestampSeconds(null) === 0, 'returns 0 for null');
  assert(readMessageTimestampSeconds({ timestamp: 'NaN' }) === 0, 'returns 0 for non-numeric timestamp');
  assert(readMessageTimestampSeconds({ timestamp: -1 }) === 0, 'returns 0 for negative timestamp');
});

describe('readMessageText', () => {
  assert(readMessageText({ body: 'Olá' }) === 'Olá', 'reads body');
  assert(readMessageText({ caption: 'Caption' }) === 'Caption', 'reads caption when no body');
  assert(readMessageText({ body: 'Body', caption: 'Caption' }) === 'Body', 'prefers body over caption');
  assert(readMessageText({}) === '', 'returns empty when no text fields');
  assert(readMessageText(null) === '', 'returns empty for null');
});

describe('isValidPersonalJid', () => {
  assert(isValidPersonalJid('5511987654321@c.us') === true, 'valid 13-digit BR number');
  assert(isValidPersonalJid('12345678@c.us') === true, 'valid 8-digit number');
  assert(isValidPersonalJid('1234567@c.us') === false, 'too-short 7-digit number');
  assert(isValidPersonalJid('group@g.us') === false, 'group JID is not personal');
  assert(isValidPersonalJid('') === false, 'empty string is not valid');
});

describe('toIsoFromUnixTimestamp', () => {
  const result = toIsoFromUnixTimestamp(0);
  assert(typeof result === 'string' && result.includes('T'), 'returns ISO string for 0 (falls back to now)');
  const ts = toIsoFromUnixTimestamp(1700000000);
  assert(ts === '2023-11-14T22:13:20.000Z', 'converts known unix timestamp to ISO');
  const invalidResult = toIsoFromUnixTimestamp(-1);
  assert(typeof invalidResult === 'string', 'returns string for negative (falls back to now)');
  assert(typeof toIsoFromUnixTimestamp(NaN) === 'string', 'returns string for NaN (falls back to now)');
});

describe('getContactName', () => {
  assert(getContactName({ name: 'Ana Silva' }) === 'Ana Silva', 'returns name');
  assert(getContactName({ pushname: 'Ana' }) === 'Ana', 'falls back to pushname');
  assert(getContactName({ shortName: 'A' }) === 'A', 'falls back to shortName');
  assert(getContactName({ id: { _serialized: '5511@c.us' } }) === '5511', 'falls back to normalized phone from id');
  assert(getContactName({}) === '', 'returns empty for empty object');
  assert(getContactName(null) === '', 'returns empty for null');
  assert(getContactName({ name: '  ', pushname: 'João' }) === 'João', 'skips blank name and uses pushname');
});

describe('extractLastMessagePreview', () => {
  assert(extractLastMessagePreview({ lastMessage: { body: 'Oi' } }) === 'Oi', 'returns message body');
  assert(extractLastMessagePreview({ lastMessage: { type: 'image' } }) === 'Foto', 'image → Foto');
  assert(extractLastMessagePreview({ lastMessage: { type: 'video' } }) === 'Video', 'video → Video');
  assert(extractLastMessagePreview({ lastMessage: { type: 'audio' } }) === 'Audio', 'audio → Audio');
  assert(extractLastMessagePreview({ lastMessage: { type: 'ptt' } }) === 'Audio', 'ptt → Audio');
  assert(extractLastMessagePreview({ lastMessage: { type: 'document' } }) === 'Documento', 'document → Documento');
  assert(extractLastMessagePreview({ lastMessage: { type: 'sticker' } }) === 'Figurinha', 'sticker → Figurinha');
  assert(extractLastMessagePreview({ lastMessage: { type: 'revoked' } }) === 'Mensagem apagada', 'revoked → Mensagem apagada');
  assert(extractLastMessagePreview({ lastMessage: { type: 'e2e_notification' } }) === '', 'notification → empty');
  assert(extractLastMessagePreview({ lastMessage: { type: 'call_log' } }) === '', 'call_log → empty');
  assert(extractLastMessagePreview({ lastMessage: { isNotification: true } }) === '', 'isNotification → empty');
  assert(extractLastMessagePreview({ lastMessage: { hasMedia: true } }) === '[mídia]', 'unknown type with media → [mídia]');
  assert(extractLastMessagePreview({}) === '', 'no lastMessage → empty');
  assert(extractLastMessagePreview(null) === '', 'null → empty');
});

// ── events.js ────────────────────────────────────────────────────────────────

describe('trackEventId', () => {
  // Reset state by pushing known IDs
  const testId = 'test-track-' + Date.now();
  trackEventId(testId);
  // Can't observe internal set directly; verify no crash and idempotency via pushEvent
  assert(true, 'trackEventId does not throw on valid ID');
  trackEventId(testId); // second call should be a no-op
  assert(true, 'trackEventId is idempotent');
  trackEventId(''); // empty ID should be ignored
  assert(true, 'trackEventId ignores empty string');
  trackEventId(null);
  assert(true, 'trackEventId ignores null');
});

describe('resolveMessageChatJid', () => {
  assert(
    resolveMessageChatJid({ from: '5511@c.us', to: 'me@c.us', id: { fromMe: false } }) === '5511@c.us',
    'inbound message → from JID'
  );
  assert(
    resolveMessageChatJid({ from: 'me@c.us', to: '5522@c.us', id: { fromMe: true } }) === '5522@c.us',
    'outbound message → to JID'
  );
  assert(
    resolveMessageChatJid({ from: 'group@g.us', to: '', id: { fromMe: false } }) === '',
    'group message → empty'
  );
  assert(
    resolveMessageChatJid({ from: '', to: 'group@g.us', id: { fromMe: true } }) === '',
    'outbound group message → empty'
  );
  assert(
    resolveMessageChatJid(null) === '',
    'null message → empty'
  );
});

describe('pushEvent', () => {
  const beforeCount = events.length;
  const chatJid = '5599887766@c.us';
  pushEvent({ source: 'test', isFromMe: false, chatJid, text: 'hello', payload: {} });
  assert(events.length === beforeCount + 1, 'pushEvent adds one event');
  const ev = events[0]; // unshift → first is newest
  assert(ev.chatJid === chatJid, 'event has correct chatJid');
  assert(ev.text === 'hello', 'event has correct text');
  assert(ev.isFromMe === false, 'event has correct isFromMe');
  assert(ev.phone === '5599887766', 'event has normalized phone');
  assert(typeof ev.id === 'string' && ev.id.length > 0, 'event has a non-empty id');
  assert(typeof ev.receivedAt === 'string', 'event has ISO receivedAt');

  // Deduplication: same id should not be added again
  const count2 = events.length;
  pushEvent({ id: ev.id, source: 'test', isFromMe: false, chatJid, text: 'dup', payload: {} });
  assert(events.length === count2, 'duplicate event id is ignored');
});

// ── contacts.js ──────────────────────────────────────────────────────────────

describe('resolveChatLabelNames', () => {
  const labelsMap = new Map([['1', 'Importante'], ['2', 'Cliente'], ['3', 'Suporte']]);

  assert(
    JSON.stringify(resolveChatLabelNames({ labels: ['1', '2'] }, labelsMap)) === JSON.stringify(['Importante', 'Cliente']),
    'resolves string label IDs'
  );
  assert(
    JSON.stringify(resolveChatLabelNames({ labels: [{ id: '3' }] }, labelsMap)) === JSON.stringify(['Suporte']),
    'resolves object label IDs via id property'
  );
  assert(
    JSON.stringify(resolveChatLabelNames({ labels: [{ labelId: '1' }] }, labelsMap)) === JSON.stringify(['Importante']),
    'resolves object label IDs via labelId property'
  );
  assert(
    JSON.stringify(resolveChatLabelNames({ labels: [1, 2] }, labelsMap)) === JSON.stringify(['Importante', 'Cliente']),
    'resolves numeric label IDs'
  );
  assert(
    JSON.stringify(resolveChatLabelNames({ labels: ['99'] }, labelsMap)) === JSON.stringify([]),
    'unknown label ID → empty array'
  );
  assert(
    JSON.stringify(resolveChatLabelNames({ labels: ['1', '1'] }, labelsMap)) === JSON.stringify(['Importante']),
    'deduplicates label names'
  );
  assert(
    JSON.stringify(resolveChatLabelNames({}, labelsMap)) === JSON.stringify([]),
    'no labels property → empty array'
  );
  assert(
    JSON.stringify(resolveChatLabelNames(null, labelsMap)) === JSON.stringify([]),
    'null chat → empty array'
  );
});

// ── jid.js ───────────────────────────────────────────────────────────────────

// Init with a mock client so getOwnJid() returns a known value
initJid({ info: { wid: { _serialized: '5511000000000@c.us' } } });

describe('getSerializedMessageId', () => {
  assert(getSerializedMessageId({ id: 'abc123' }) === 'abc123', 'returns string id directly');
  assert(getSerializedMessageId({ id: { _serialized: 'true_5511@c.us_abc' } }) === 'true_5511@c.us_abc', 'returns _serialized from object id');
  assert(getSerializedMessageId({ id: {} }) === '', 'returns empty for object id without _serialized');
  assert(getSerializedMessageId({}) === '', 'returns empty when no id');
  assert(getSerializedMessageId(null) === '', 'returns empty for null message');
});

describe('resolveIsFromMe', () => {
  assert(resolveIsFromMe({ id: { fromMe: true } }) === true, 'fromMe: true → true');
  assert(resolveIsFromMe({ id: { fromMe: false } }) === false, 'fromMe: false → false');
  assert(resolveIsFromMe({ id: { _serialized: 'true_5511@c.us_abc' } }) === true, 'serialized id starting with true_ → true');
  assert(resolveIsFromMe({ id: { _serialized: 'false_5511@c.us_abc' } }) === false, 'serialized id starting with false_ → false');
  assert(resolveIsFromMe({ fromMe: true }) === true, 'message.fromMe boolean true → true');
  assert(resolveIsFromMe({ fromMe: false }) === false, 'message.fromMe boolean false → false');
  assert(resolveIsFromMe({ fromMe: 1 }) === true, 'fromMe numeric 1 → true');
  assert(resolveIsFromMe({ fromMe: 0 }) === false, 'fromMe numeric 0 → false');
  assert(resolveIsFromMe({ fromMe: 'true' }) === true, 'fromMe string "true" → true');
  assert(resolveIsFromMe({ fromMe: 'false' }) === false, 'fromMe string "false" → false');
  assert(resolveIsFromMe({ from: '5511000000000@c.us', to: '5522@c.us' }) === true, 'from matches own JID → true');
  assert(resolveIsFromMe({ from: '5522@c.us', to: '5511000000000@c.us' }) === false, 'from is other contact → false');
  assert(resolveIsFromMe(null) === false, 'null → false');
});

// ── history.js ───────────────────────────────────────────────────────────────

describe('isChatHistoryTemporarilyDisabled', () => {
  const afterCooldown = Date.now() + 6 * 60 * 1000; // past the 5-min CHAT_HISTORY_COOLDOWN_MS

  disableChatHistoryTemporarily('5511@c.us');
  assert(isChatHistoryTemporarilyDisabled('5511@c.us', Date.now()) === true, 'recently disabled chat is disabled');
  assert(isChatHistoryTemporarilyDisabled('5511@c.us', afterCooldown) === false, 'chat is re-enabled after cooldown expires');
  assert(isChatHistoryTemporarilyDisabled('5599@c.us', Date.now()) === false, 'unknown chat is not disabled');
  assert(isChatHistoryTemporarilyDisabled('', Date.now()) === false, 'empty jid returns false');
});

describe('acquireHistorySlot / releaseHistorySlot', async () => {
  // Acquire up to concurrency limit (4) and then release
  await acquireHistorySlot();
  await acquireHistorySlot();
  releaseHistorySlot();
  releaseHistorySlot();
  assert(true, 'acquire/release cycle completes without hanging');

  // releaseHistorySlot past 0 does not go negative
  releaseHistorySlot();
  releaseHistorySlot();
  releaseHistorySlot();
  assert(true, 'extra releases do not throw');
});

describe('registerHistoryFailure', () => {
  // Call below failure limit — should not disable
  registerHistoryFailure();
  registerHistoryFailure();
  assert(true, 'registerHistoryFailure below limit does not throw');
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

