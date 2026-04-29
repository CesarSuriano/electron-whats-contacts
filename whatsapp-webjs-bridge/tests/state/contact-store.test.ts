import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ContactStore } from '../../src/state/ContactStore.js';

describe('ContactStore.createDefault', () => {
  it('returns a ContactEntry with all expected fields populated', () => {
    const store = new ContactStore();
    const entry = store.createDefault('5511987654321@c.us');
    assert.deepEqual(entry, {
      jid: '5511987654321@c.us',
      phone: '5511987654321',
      name: '5511987654321',
      found: true,
      lastMessageAt: null,
      lastMessagePreview: '',
      lastMessageFromMe: false,
      lastMessageType: '',
      lastMessageHasMedia: false,
      lastMessageMediaMimetype: '',
      lastMessageAck: null,
      unreadCount: 0,
      labels: [],
      isGroup: false,
      fromGetChats: false,
      getChatsTimestampMs: 0
    });
  });

  it('applies overrides on top of defaults', () => {
    const store = new ContactStore();
    const entry = store.createDefault('5511@c.us', {
      name: 'Maria',
      labels: ['Cliente'],
      isGroup: false
    });
    assert.equal(entry.name, 'Maria');
    assert.deepEqual(entry.labels, ['Cliente']);
    assert.equal(entry.jid, '5511@c.us');
  });

  it('marks @g.us entries as group conversations by default', () => {
    const store = new ContactStore();
    const entry = store.createDefault('120363000000000000@g.us');
    assert.equal(entry.isGroup, true);
    assert.equal(entry.phone, '120363000000000000');
  });
});

describe('ContactStore.upsertOnOutbound', () => {
  it('creates a new contact with all default fields when none exists', () => {
    const store = new ContactStore();
    const jid = '5511987654321@c.us';
    const receivedAt = new Date().toISOString();
    const entry = store.upsertOnOutbound({
      jid,
      preview: 'Olá',
      receivedAt,
      type: 'chat'
    });
    assert.equal(entry.jid, jid);
    assert.equal(entry.phone, '5511987654321');
    assert.equal(entry.lastMessagePreview, 'Olá');
    assert.equal(entry.lastMessageFromMe, true);
    assert.equal(entry.lastMessageAck, 0);
    assert.equal(entry.lastMessageType, 'chat');
    assert.equal(entry.lastMessageHasMedia, false);
    assert.deepEqual(entry.labels, []);
    assert.equal(entry.isGroup, false);
    assert.equal(entry.fromGetChats, true);
  });

  it('preserves existing name and labels when contact already exists', () => {
    const store = new ContactStore();
    const jid = '5511@c.us';
    store.set(jid, store.createDefault(jid, { name: 'Alice', labels: ['Cliente'] }));
    const entry = store.upsertOnOutbound({
      jid,
      preview: 'Nova mensagem',
      receivedAt: new Date().toISOString()
    });
    assert.equal(entry.name, 'Alice');
    assert.deepEqual(entry.labels, ['Cliente']);
    assert.equal(entry.lastMessagePreview, 'Nova mensagem');
  });

  it('sets media fields on media send', () => {
    const store = new ContactStore();
    const entry = store.upsertOnOutbound({
      jid: '5511@c.us',
      preview: 'Foto',
      receivedAt: new Date().toISOString(),
      type: 'image',
      hasMedia: true,
      mediaMimetype: 'image/jpeg'
    });
    assert.equal(entry.lastMessageType, 'image');
    assert.equal(entry.lastMessageHasMedia, true);
    assert.equal(entry.lastMessageMediaMimetype, 'image/jpeg');
  });

  it('creates new group contacts with isGroup=true on outbound send', () => {
    const store = new ContactStore();
    const entry = store.upsertOnOutbound({
      jid: '120363000000000000@g.us',
      preview: 'Olá grupo',
      receivedAt: new Date().toISOString(),
      type: 'chat'
    });
    assert.equal(entry.isGroup, true);
    assert.equal(entry.jid, '120363000000000000@g.us');
  });
});

describe('ContactStore.resetUnreadCount', () => {
  it('zeros unreadCount on existing contact', () => {
    const store = new ContactStore();
    store.set('5511@c.us', store.createDefault('5511@c.us', { unreadCount: 5 }));
    store.resetUnreadCount('5511@c.us');
    assert.equal(store.get('5511@c.us')?.unreadCount, 0);
  });

  it('is a no-op for unknown contact', () => {
    const store = new ContactStore();
    assert.doesNotThrow(() => store.resetUnreadCount('5522@c.us'));
  });
});

describe('ContactStore.updateLastMessageAck', () => {
  it('updates ack for outbound messages', () => {
    const store = new ContactStore();
    store.set(
      '5511@c.us',
      store.createDefault('5511@c.us', { lastMessageFromMe: true, lastMessageAck: 0 })
    );
    store.updateLastMessageAck('5511@c.us', 2);
    assert.equal(store.get('5511@c.us')?.lastMessageAck, 2);
  });

  it('does not update ack for inbound messages', () => {
    const store = new ContactStore();
    store.set(
      '5511@c.us',
      store.createDefault('5511@c.us', { lastMessageFromMe: false, lastMessageAck: null })
    );
    store.updateLastMessageAck('5511@c.us', 3);
    assert.equal(store.get('5511@c.us')?.lastMessageAck, null);
  });
});
