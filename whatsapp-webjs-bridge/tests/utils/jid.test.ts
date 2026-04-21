import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeJid,
  isSamePhoneJid,
  isPersonalJid,
  isGroupJid,
  isLinkedId,
  isBroadcastJid,
  isStatusBroadcastJid,
  isPersonalOrLinkedJid,
  isSameConversationJid,
  normalizeRequestedChatJid,
  isValidPersonalJid
} from '../../src/utils/jid.js';

describe('normalizeJid', () => {
  it('passes through existing @c.us JID', () => {
    assert.equal(normalizeJid('5511987654321@c.us'), '5511987654321@c.us');
  });

  it('passes through @g.us JID', () => {
    assert.equal(normalizeJid('5511987654321@g.us'), '5511987654321@g.us');
  });

  it('adds @c.us to bare number', () => {
    assert.equal(normalizeJid('5511987654321'), '5511987654321@c.us');
  });

  it('returns empty for empty string', () => {
    assert.equal(normalizeJid(''), '');
  });

  it('returns empty for null', () => {
    assert.equal(normalizeJid(null), '');
  });

  it('returns empty for non-numeric bare input', () => {
    assert.equal(normalizeJid('abc'), '');
  });
});

describe('isSamePhoneJid', () => {
  it('matches identical JIDs', () => {
    assert.equal(isSamePhoneJid('5511987654321@c.us', '5511987654321@c.us'), true);
  });

  it('matches JID with bare number', () => {
    assert.equal(isSamePhoneJid('5511987654321@c.us', '5511987654321'), true);
  });

  it('does not match different numbers', () => {
    assert.equal(isSamePhoneJid('5511987654321@c.us', '5511000000000@c.us'), false);
  });

  it('does not match empty string', () => {
    assert.equal(isSamePhoneJid('', '5511987654321@c.us'), false);
  });

  it('does not match null', () => {
    assert.equal(isSamePhoneJid(null, '5511987654321@c.us'), false);
  });
});

describe('isPersonalJid', () => {
  it('accepts @c.us', () => {
    assert.equal(isPersonalJid('5511987654321@c.us'), true);
  });

  it('rejects @g.us', () => {
    assert.equal(isPersonalJid('group@g.us'), false);
  });

  it('rejects @lid', () => {
    assert.equal(isPersonalJid('123@lid'), false);
  });

  it('rejects empty string', () => {
    assert.equal(isPersonalJid(''), false);
  });

  it('rejects null', () => {
    assert.equal(isPersonalJid(null), false);
  });
});

describe('isGroupJid', () => {
  it('accepts @g.us', () => {
    assert.equal(isGroupJid('group123@g.us'), true);
  });

  it('rejects @c.us', () => {
    assert.equal(isGroupJid('5511@c.us'), false);
  });

  it('rejects @lid', () => {
    assert.equal(isGroupJid('123@lid'), false);
  });
});

describe('isLinkedId', () => {
  it('recognizes @lid JID', () => {
    assert.equal(isLinkedId('123456789012@lid'), true);
  });

  it('rejects @c.us JID', () => {
    assert.equal(isLinkedId('5511987654321@c.us'), false);
  });

  it('rejects group JID', () => {
    assert.equal(isLinkedId('group@g.us'), false);
  });

  it('rejects null', () => {
    assert.equal(isLinkedId(null), false);
  });
});

describe('isBroadcastJid', () => {
  it('accepts @broadcast', () => {
    assert.equal(isBroadcastJid('status@broadcast'), true);
  });

  it('rejects personal jid', () => {
    assert.equal(isBroadcastJid('5511@c.us'), false);
  });
});

describe('isStatusBroadcastJid', () => {
  it('accepts the WhatsApp status broadcast jid', () => {
    assert.equal(isStatusBroadcastJid('status@broadcast'), true);
  });

  it('rejects other broadcast jids', () => {
    assert.equal(isStatusBroadcastJid('list@broadcast'), false);
  });
});

describe('isPersonalOrLinkedJid', () => {
  it('accepts @c.us', () => {
    assert.equal(isPersonalOrLinkedJid('5511@c.us'), true);
  });

  it('accepts @lid', () => {
    assert.equal(isPersonalOrLinkedJid('123@lid'), true);
  });

  it('rejects @g.us', () => {
    assert.equal(isPersonalOrLinkedJid('group@g.us'), false);
  });
});

describe('isSameConversationJid', () => {
  it('matches identical @c.us JIDs', () => {
    assert.equal(isSameConversationJid('5511987654321@c.us', '5511987654321@c.us'), true);
  });

  it('matches same phone across @c.us and @lid', () => {
    assert.equal(isSameConversationJid('5511987654321@c.us', '5511987654321@lid'), true);
    assert.equal(isSameConversationJid('5511987654321@lid', '5511987654321@c.us'), true);
  });

  it('does not match different numbers', () => {
    assert.equal(isSameConversationJid('5511@c.us', '5512@c.us'), false);
  });

  it('does not match null or empty input', () => {
    assert.equal(isSameConversationJid('', '5511@c.us'), false);
    assert.equal(isSameConversationJid(null, '5511@c.us'), false);
  });
});

describe('normalizeRequestedChatJid', () => {
  it('passes through @c.us JID', () => {
    assert.equal(normalizeRequestedChatJid('5511987654321@c.us'), '5511987654321@c.us');
  });

  it('appends @c.us to bare number', () => {
    assert.equal(normalizeRequestedChatJid('5511987654321'), '5511987654321@c.us');
  });

  it('trims whitespace on bare number', () => {
    assert.equal(normalizeRequestedChatJid('  5511987654321  '), '5511987654321@c.us');
  });

  it('returns empty for empty input', () => {
    assert.equal(normalizeRequestedChatJid(''), '');
    assert.equal(normalizeRequestedChatJid(null), '');
  });
});

describe('isValidPersonalJid', () => {
  it('valid 13-digit BR number', () => {
    assert.equal(isValidPersonalJid('5511987654321@c.us'), true);
  });

  it('valid 8-digit number', () => {
    assert.equal(isValidPersonalJid('12345678@c.us'), true);
  });

  it('7-digit too short', () => {
    assert.equal(isValidPersonalJid('1234567@c.us'), false);
  });

  it('group JID is not personal', () => {
    assert.equal(isValidPersonalJid('group@g.us'), false);
  });

  it('empty is not valid', () => {
    assert.equal(isValidPersonalJid(''), false);
  });
});
