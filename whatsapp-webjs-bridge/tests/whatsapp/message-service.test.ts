import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Client as WebJsClient } from 'whatsapp-web.js';
import { MessageService } from '../../src/whatsapp/MessageService.js';
import { SelfJidResolver } from '../../src/whatsapp/SelfJidResolver.js';
import { SessionState } from '../../src/state/SessionState.js';
import { EventStore } from '../../src/state/EventStore.js';
import { ContactStore } from '../../src/state/ContactStore.js';

interface FakeSend {
  lastArgs?: { chatId: string; content: unknown; options?: unknown };
  response: {
    id?: { _serialized?: string };
    timestamp?: number;
    to?: string;
    ack?: number;
  };
}

function buildService(fakeSend: FakeSend, options: { ready?: boolean } = {}): {
  service: MessageService;
  eventStore: EventStore;
  contactStore: ContactStore;
} {
  const client = {
    info: { wid: { _serialized: '5511000000000@c.us' } },
    sendMessage: async (chatId: string, content: unknown, opts?: unknown) => {
      fakeSend.lastArgs = { chatId, content, options: opts };
      return fakeSend.response;
    },
    getMessageById: async () => null,
    getChatById: async () => ({ sendSeen: async () => true })
  } as unknown as WebJsClient;

  const selfJidResolver = new SelfJidResolver(client);
  const sessionState = new SessionState('test', () => selfJidResolver.getOwnJid());
  sessionState.status = options.ready === false ? 'initializing' : 'ready';
  const eventStore = new EventStore();
  const contactStore = new ContactStore();
  const service = new MessageService(client, sessionState, eventStore, contactStore, selfJidResolver);
  return { service, eventStore, contactStore };
}

describe('MessageService.validateDestination', () => {
  it('accepts a valid personal JID', () => {
    const { service } = buildService({ response: {} });
    const v = service.validateDestination('5511987654321');
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.chatId, '5511987654321@c.us');
    }
  });

  it('rejects group JIDs with explicit error', () => {
    const { service } = buildService({ response: {} });
    const v = service.validateDestination('120363000000000000@g.us');
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.match(v.error, /Group/);
    }
  });

  it('rejects too-short numbers', () => {
    const { service } = buildService({ response: {} });
    const v = service.validateDestination('12345');
    assert.equal(v.ok, false);
  });

  it('rejects the own number', () => {
    const { service } = buildService({ response: {} });
    const v = service.validateDestination('5511000000000');
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.match(v.error, /current WhatsApp account/);
    }
  });

  it('rejects empty input', () => {
    const { service } = buildService({ response: {} });
    const v = service.validateDestination('');
    assert.equal(v.ok, false);
  });
});

describe('MessageService.requireReady', () => {
  it('returns null when session is ready', () => {
    const { service } = buildService({ response: {} });
    assert.equal(service.requireReady(), null);
  });

  it('returns error object when session is not ready', () => {
    const { service } = buildService({ response: {} }, { ready: false });
    const notReady = service.requireReady();
    assert.ok(notReady);
    assert.equal(notReady.ok, false);
  });
});

describe('MessageService.sendText', () => {
  it('pushes an event and creates a contact with full default shape', async () => {
    const fakeSend: FakeSend = {
      response: { id: { _serialized: 'sent-1' }, timestamp: 1700001000, to: '5511987654321@c.us', ack: 0 }
    };
    const { service, eventStore, contactStore } = buildService(fakeSend);
    const result = await service.sendText('5511987654321@c.us', 'Olá');

    assert.equal(result.id, 'sent-1');
    assert.equal(result.to, '5511987654321@c.us');
    assert.equal(fakeSend.lastArgs?.chatId, '5511987654321@c.us');
    assert.equal(fakeSend.lastArgs?.content, 'Olá');

    assert.equal(eventStore.events.length, 1);
    assert.equal(eventStore.events[0]?.isFromMe, true);
    assert.equal(eventStore.events[0]?.text, 'Olá');

    const contact = contactStore.get('5511987654321@c.us');
    assert.ok(contact);
    assert.deepEqual(contact.labels, []);
    assert.equal(contact.isGroup, false);
    assert.equal(contact.lastMessageType, 'chat');
    assert.equal(contact.lastMessageHasMedia, false);
    assert.equal(contact.lastMessageMediaMimetype, '');
    assert.equal(contact.lastMessageAck, 0);
    assert.equal(contact.lastMessageFromMe, true);
    assert.equal(contact.lastMessagePreview, 'Olá');
    assert.equal(contact.unreadCount, 0);
  });
});

describe('MessageService.sendMedia', () => {
  it('flags outbound contact with image metadata', async () => {
    const fakeSend: FakeSend = {
      response: { id: { _serialized: 'sent-media' }, timestamp: 1700001111, to: '5511987654321@c.us', ack: 0 }
    };
    const { service, contactStore } = buildService(fakeSend);
    const buffer = Buffer.from([0xff, 0xd8, 0xff]);
    const result = await service.sendMedia('5511987654321@c.us', buffer, 'image/jpeg', 'foto.jpg', 'Legenda');

    assert.equal(result.id, 'sent-media');
    const contact = contactStore.get('5511987654321@c.us');
    assert.ok(contact);
    assert.equal(contact.lastMessageType, 'image');
    assert.equal(contact.lastMessageHasMedia, true);
    assert.equal(contact.lastMessageMediaMimetype, 'image/jpeg');
    assert.equal(contact.lastMessagePreview, 'Legenda');
  });

  it('marks non-image media as document with sendMediaAsDocument option', async () => {
    const fakeSend: FakeSend = {
      response: { id: { _serialized: 'sent-doc' }, timestamp: 1700001222, to: '5511987654321@c.us' }
    };
    const { service, contactStore } = buildService(fakeSend);
    await service.sendMedia('5511987654321@c.us', Buffer.from('abc'), 'application/pdf', 'arquivo.pdf', '');

    const opts = fakeSend.lastArgs?.options as { sendMediaAsDocument: boolean };
    assert.equal(opts.sendMediaAsDocument, true);
    const contact = contactStore.get('5511987654321@c.us');
    assert.ok(contact);
    assert.equal(contact.lastMessageType, 'document');
    assert.equal(contact.lastMessageHasMedia, true);
  });
});

describe('MessageService.propagateAckToContact', () => {
  it('updates contact ack when event is known', () => {
    const fakeSend: FakeSend = { response: {} };
    const { service, eventStore, contactStore } = buildService(fakeSend);
    eventStore.pushEvent({
      id: 'msg-xyz',
      source: 'send-api',
      isFromMe: true,
      chatJid: '5511@c.us',
      payload: { id: 'msg-xyz', timestamp: 0 }
    });
    contactStore.set('5511@c.us', contactStore.createDefault('5511@c.us', { lastMessageFromMe: true, lastMessageAck: 0 }));
    service.propagateAckToContact('msg-xyz', 2);
    assert.equal(contactStore.get('5511@c.us')?.lastMessageAck, 2);
  });

  it('is a no-op when event is unknown', () => {
    const fakeSend: FakeSend = { response: {} };
    const { service, contactStore } = buildService(fakeSend);
    contactStore.set('5511@c.us', contactStore.createDefault('5511@c.us', { lastMessageFromMe: true, lastMessageAck: 0 }));
    service.propagateAckToContact('unknown-id', 3);
    assert.equal(contactStore.get('5511@c.us')?.lastMessageAck, 0);
  });
});

describe('MessageService.shouldIncludeHistoryMessage', () => {
  it('excludes notifications', () => {
    const fakeSend: FakeSend = { response: {} };
    const { service } = buildService(fakeSend);
    assert.equal(service.shouldIncludeHistoryMessage({ isNotification: true, body: 'x' }), false);
  });

  it('excludes status broadcast messages', () => {
    const fakeSend: FakeSend = { response: {} };
    const { service } = buildService(fakeSend);
    assert.equal(service.shouldIncludeHistoryMessage({ from: 'status@broadcast', body: 'status' }), false);
  });

  it('includes text messages', () => {
    const fakeSend: FakeSend = { response: {} };
    const { service } = buildService(fakeSend);
    assert.equal(service.shouldIncludeHistoryMessage({ body: 'oi' }), true);
  });

  it('includes media messages without body', () => {
    const fakeSend: FakeSend = { response: {} };
    const { service } = buildService(fakeSend);
    assert.equal(service.shouldIncludeHistoryMessage({ type: 'image', hasMedia: true }), true);
  });

  it('includes revoked message markers', () => {
    const fakeSend: FakeSend = { response: {} };
    const { service } = buildService(fakeSend);
    assert.equal(service.shouldIncludeHistoryMessage({ type: 'revoked' }), true);
  });

  it('excludes null or empty messages', () => {
    const fakeSend: FakeSend = { response: {} };
    const { service } = buildService(fakeSend);
    assert.equal(service.shouldIncludeHistoryMessage(null), false);
    assert.equal(service.shouldIncludeHistoryMessage({}), false);
  });
});
