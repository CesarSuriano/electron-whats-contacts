import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Client as WebJsClient } from 'whatsapp-web.js';
import { IngestionService } from '../../src/whatsapp/IngestionService.js';
import { SelfJidResolver } from '../../src/whatsapp/SelfJidResolver.js';
import { SessionState } from '../../src/state/SessionState.js';
import { EventStore } from '../../src/state/EventStore.js';
import { ContactStore } from '../../src/state/ContactStore.js';
import { LidMap } from '../../src/state/LidMap.js';

function makeService(): {
  service: IngestionService;
  eventStore: EventStore;
  contactStore: ContactStore;
  lidMap: LidMap;
  selfJidResolver: SelfJidResolver;
} {
  const client = { info: { wid: { _serialized: '5511000000000@c.us' } } } as unknown as WebJsClient;
  const selfJidResolver = new SelfJidResolver(client);
  const sessionState = new SessionState('test', () => selfJidResolver.getOwnJid());
  sessionState.status = 'ready';
  const eventStore = new EventStore();
  const contactStore = new ContactStore();
  const lidMap = new LidMap();
  const service = new IngestionService(client, sessionState, eventStore, contactStore, lidMap, selfJidResolver);
  return { service, eventStore, contactStore, lidMap, selfJidResolver };
}

describe('IngestionService.resolveMessageChatJid', () => {
  it('returns from-jid for inbound messages', () => {
    const { service } = makeService();
    assert.equal(
      service.resolveMessageChatJid({
        from: '5511999999999@c.us',
        to: '5511000000000@c.us',
        id: { fromMe: false }
      }),
      '5511999999999@c.us'
    );
  });

  it('returns to-jid for outbound messages', () => {
    const { service } = makeService();
    assert.equal(
      service.resolveMessageChatJid({
        from: '5511000000000@c.us',
        to: '5522999999999@c.us',
        id: { fromMe: true }
      }),
      '5522999999999@c.us'
    );
  });

  it('returns empty for group messages', () => {
    const { service } = makeService();
    assert.equal(
      service.resolveMessageChatJid({ from: 'group@g.us', to: '', id: { fromMe: false } }),
      ''
    );
  });

  it('prefers remote chat id over from/to when present', () => {
    const { service } = makeService();
    assert.equal(
      service.resolveMessageChatJid({
        id: { remote: { _serialized: '5522999999999@c.us' } },
        from: '12345678901234@lid',
        to: '5511000000000@c.us'
      }),
      '5522999999999@c.us'
    );
  });

  it('ignores self conversations', () => {
    const { service } = makeService();
    assert.equal(
      service.resolveMessageChatJid({
        id: { remote: { _serialized: '5511000000000@c.us' } },
        from: '5511000000000@c.us',
        to: '5511000000000@c.us'
      }),
      ''
    );
  });

  it('returns empty for null', () => {
    const { service } = makeService();
    assert.equal(service.resolveMessageChatJid(null), '');
  });
});

describe('IngestionService.ingestInboundMessage', () => {
  it('creates an event and a contact for a new inbound chat', async () => {
    const { service, eventStore, contactStore } = makeService();
    await service.ingestInboundMessage(
      {
        id: { _serialized: 'msg-1', fromMe: false },
        from: '5511987654321@c.us',
        to: '5511000000000@c.us',
        body: 'Olá',
        timestamp: 1700000000
      },
      'webjs-inbound'
    );

    assert.equal(eventStore.events.length, 1);
    assert.equal(eventStore.events[0]?.chatJid, '5511987654321@c.us');
    assert.equal(eventStore.events[0]?.text, 'Olá');
    assert.equal(eventStore.events[0]?.isFromMe, false);

    const contact = contactStore.get('5511987654321@c.us');
    assert.ok(contact);
    assert.equal(contact.lastMessagePreview, 'Olá');
    assert.equal(contact.lastMessageFromMe, false);
    assert.equal(contact.unreadCount, 1);
    assert.deepEqual(contact.labels, []);
    assert.equal(contact.isGroup, false);
  });

  it('resolves @lid jid to canonical phone via message.getContact and records lid mapping', async () => {
    const { service, eventStore, contactStore, lidMap } = makeService();
    await service.ingestInboundMessage(
      {
        id: { _serialized: 'msg-lid', fromMe: false },
        from: '12345678901234@lid',
        to: '5511000000000@c.us',
        body: 'Oi via lid',
        timestamp: 1700000100,
        getContact: async () => ({
          number: '5522999998888',
          id: { _serialized: '12345678901234@lid', user: '12345678901234' }
        })
      },
      'webjs-inbound'
    );

    assert.equal(eventStore.events.length, 1);
    assert.equal(eventStore.events[0]?.chatJid, '5522999998888@c.us');
    assert.equal(contactStore.has('5522999998888@c.us'), true);
    assert.equal(lidMap.getLid('5522999998888@c.us'), '12345678901234@lid');
  });

  it('discards messages from self', async () => {
    const { service, eventStore } = makeService();
    await service.ingestInboundMessage(
      {
        id: { _serialized: 'msg-self', fromMe: true },
        from: '5511000000000@c.us',
        to: '5511999999999@c.us',
        body: 'minha mensagem',
        timestamp: 1700000200
      },
      'webjs-inbound-create'
    );
    assert.equal(eventStore.events.length, 0);
  });

  it('discards messages without a 1:1 personal chat', async () => {
    const { service, eventStore } = makeService();
    await service.ingestInboundMessage(
      {
        id: { _serialized: 'msg-group', fromMe: false },
        from: 'group@g.us',
        to: '5511000000000@c.us',
        body: 'grupo',
        timestamp: 1700000300
      },
      'webjs-inbound'
    );
    assert.equal(eventStore.events.length, 0);
  });

  it('discards status broadcast messages', async () => {
    const { service, eventStore } = makeService();
    await service.ingestInboundMessage(
      {
        id: { _serialized: 'msg-status', fromMe: false },
        from: 'status@broadcast',
        to: '5511000000000@c.us',
        body: 'Status',
        timestamp: 1700000301,
        type: 'status'
      },
      'webjs-inbound'
    );
    assert.equal(eventStore.events.length, 0);
  });
});

describe('IngestionService.ingestOutboundFromCreate', () => {
  it('updates contact preview and timestamp for fromMe messages', async () => {
    const { service, contactStore } = makeService();
    await service.ingestOutboundFromCreate(
      {
        id: { _serialized: 'out-1', fromMe: true },
        from: '5511000000000@c.us',
        to: '5511987654321@c.us',
        body: 'Enviado do celular',
        timestamp: 1700001000,
        ack: 1
      },
      'webjs-outbound-create'
    );
    const contact = contactStore.get('5511987654321@c.us');
    assert.ok(contact);
    assert.equal(contact.lastMessagePreview, 'Enviado do celular');
    assert.equal(contact.lastMessageFromMe, true);
    assert.equal(contact.lastMessageAck, 1);
  });

  it('does not downgrade a more recent contact timestamp', async () => {
    const { service, contactStore } = makeService();
    const futureTsMs = Date.now() + 60_000;
    contactStore.set(
      '5511987654321@c.us',
      contactStore.createDefault('5511987654321@c.us', {
        lastMessagePreview: 'mais recente',
        lastMessageFromMe: true,
        fromGetChats: true,
        getChatsTimestampMs: futureTsMs
      })
    );
    await service.ingestOutboundFromCreate(
      {
        id: { _serialized: 'out-old', fromMe: true },
        from: '5511000000000@c.us',
        to: '5511987654321@c.us',
        body: 'antiga',
        timestamp: 1
      },
      'webjs-outbound-create'
    );
    assert.equal(contactStore.get('5511987654321@c.us')?.lastMessagePreview, 'mais recente');
  });

  it('ignores inbound messages', async () => {
    const { service, contactStore } = makeService();
    await service.ingestOutboundFromCreate(
      {
        id: { _serialized: 'in-1', fromMe: false },
        from: '5511987654321@c.us',
        to: '5511000000000@c.us',
        body: 'inbound',
        timestamp: 1700001000
      },
      'webjs-outbound-create'
    );
    assert.equal(contactStore.has('5511987654321@c.us'), false);
  });
});
