import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Client as WebJsClient } from 'whatsapp-web.js';
import { IngestionService } from '../../src/whatsapp/IngestionService.js';
import { SelfJidResolver } from '../../src/whatsapp/SelfJidResolver.js';
import { SessionState } from '../../src/state/SessionState.js';
import { EventStore } from '../../src/state/EventStore.js';
import { ContactStore } from '../../src/state/ContactStore.js';
import { LidMap } from '../../src/state/LidMap.js';

function makeService(clientOverride?: Partial<WebJsClient>): {
  service: IngestionService;
  eventStore: EventStore;
  contactStore: ContactStore;
  lidMap: LidMap;
  selfJidResolver: SelfJidResolver;
} {
  const client = {
    info: { wid: { _serialized: '5511000000000@c.us' } },
    ...clientOverride
  } as unknown as WebJsClient;
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

  it('keeps the raw @lid conversation when getContact only echoes the linked-id digits', async () => {
    const { service, eventStore, contactStore, lidMap } = makeService();
    await service.ingestInboundMessage(
      {
        id: { _serialized: 'msg-lid-raw', fromMe: false },
        from: '278649089585374@lid',
        to: '5511000000000@c.us',
        body: '?',
        timestamp: 1700000101,
        getContact: async () => ({
          number: '278649089585374',
          id: { _serialized: '278649089585374@lid', user: '278649089585374' }
        })
      },
      'webjs-inbound'
    );

    assert.equal(eventStore.events.length, 1);
    assert.equal(eventStore.events[0]?.chatJid, '278649089585374@lid');
    assert.equal(contactStore.has('278649089585374@lid'), true);
    assert.equal(contactStore.get('278649089585374@lid')?.phone, '');
    assert.equal(contactStore.has('278649089585374@c.us'), false);
    assert.equal(lidMap.findCanonical('278649089585374@lid'), '');
  });

  it('keeps the raw @lid conversation when getContact returns a mirrored @c.us alias for the same linked-id digits', async () => {
    const { service, eventStore, contactStore, lidMap } = makeService();
    await service.ingestInboundMessage(
      {
        id: { _serialized: 'msg-lid-mirrored-personal', fromMe: false },
        from: '152896658239610@lid',
        to: '5511000000000@c.us',
        body: 'Foi',
        timestamp: 1700000103,
        getContact: async () => ({
          number: '152896658239610',
          id: { _serialized: '152896658239610@c.us', user: '152896658239610' }
        })
      },
      'webjs-inbound'
    );

    assert.equal(eventStore.events.length, 1);
    assert.equal(eventStore.events[0]?.chatJid, '152896658239610@lid');
    assert.equal(contactStore.has('152896658239610@c.us'), false);
    assert.equal(contactStore.has('152896658239610@lid'), true);
    assert.equal(lidMap.findCanonical('152896658239610@lid'), '');
  });

  it('does not promote a synthetic canonical jid when the linked-id lookup only mirrors the lid digits', async () => {
    let evaluateCalls = 0;
    const { service, eventStore, contactStore, lidMap } = makeService({
      pupPage: {
        evaluate: async () => {
          evaluateCalls += 1;
          return { lid: '278649089585374@lid', phone: '278649089585374@c.us' };
        }
      }
    } as unknown as Partial<WebJsClient>);

    await service.ingestInboundMessage(
      {
        id: { _serialized: 'msg-lid-no-history-promote', fromMe: false },
        from: '278649089585374@lid',
        to: '5511000000000@c.us',
        body: '?',
        timestamp: 1700000104,
        getContact: async () => ({
          number: '278649089585374',
          id: { _serialized: '278649089585374@lid', user: '278649089585374' }
        })
      },
      'webjs-inbound'
    );

    assert.equal(evaluateCalls, 1);
    assert.equal(eventStore.events[0]?.chatJid, '278649089585374@lid');
    assert.equal(contactStore.has('278649089585374@c.us'), false);
    assert.equal(contactStore.has('278649089585374@lid'), true);
    assert.equal(lidMap.findCanonical('278649089585374@lid'), '');
  });

  it('reuses a known canonical jid when the linked-id lookup only returns a synthetic canonical alias', async () => {
    const { service, eventStore, contactStore, lidMap } = makeService({
      pupPage: {
        evaluate: async () => ({ lid: '278649089585374@lid', phone: '278649089585374@c.us' })
      }
    } as unknown as Partial<WebJsClient>);
    lidMap.set('5511987654321@c.us', '278649089585374@lid');
    contactStore.set('5511987654321@c.us', contactStore.createDefault('5511987654321@c.us', {
      phone: '5511987654321',
      name: 'Noiva do Miro',
      found: true
    }));

    await service.ingestInboundMessage(
      {
        id: { _serialized: 'msg-lid-known', fromMe: false },
        from: '278649089585374@lid',
        to: '5511000000000@c.us',
        body: 'Oi',
        timestamp: 1700000102,
        getContact: async () => ({
          number: '278649089585374',
          id: { _serialized: '278649089585374@lid', user: '278649089585374' }
        })
      },
      'webjs-inbound'
    );

    assert.equal(eventStore.events.length, 1);
    assert.equal(eventStore.events[0]?.chatJid, '5511987654321@c.us');
    assert.equal(contactStore.has('5511987654321@c.us'), true);
    assert.equal(contactStore.has('278649089585374@c.us'), false);
  });

  it('replaces a stale fake canonical when the same linked-id resolves to the real number later', async () => {
    const { service, eventStore, contactStore, lidMap } = makeService();
    lidMap.set('278649089585374@c.us', '278649089585374@lid');
    contactStore.set('278649089585374@c.us', contactStore.createDefault('278649089585374@c.us', {
      phone: '278649089585374',
      name: 'Noiva Do Miro',
      found: true,
      unreadCount: 1,
      lastMessagePreview: '?'
    }));
    eventStore.pushEvent({
      id: 'evt-stale-canonical',
      source: 'webjs-inbound',
      isFromMe: false,
      chatJid: '278649089585374@c.us',
      text: '?',
      receivedAt: '2024-01-01T00:00:00.000Z',
      payload: { id: 'evt-stale-canonical', timestamp: 1704067200 }
    });

    await service.ingestInboundMessage(
      {
        id: { _serialized: 'msg-lid-remap', fromMe: false },
        from: '278649089585374@lid',
        to: '5511000000000@c.us',
        body: 'Oi',
        timestamp: 1700000103,
        getContact: async () => ({
          number: '554499104514',
          id: { _serialized: '278649089585374@lid', user: '278649089585374' }
        })
      },
      'webjs-inbound'
    );

    assert.equal(lidMap.findCanonical('278649089585374@lid'), '554499104514@c.us');
    assert.equal(contactStore.has('278649089585374@c.us'), false);
    assert.equal(contactStore.has('554499104514@c.us'), true);
    assert.equal(eventStore.events.find(event => event.id === 'evt-stale-canonical')?.chatJid, '554499104514@c.us');
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

// Bug C regression: quando aprendemos um mapeamento LID, qualquer entry
// stale do LID no contactStore deve ser absorvida no canonical. Antes a
// merge só rodava se o registerCanonicalLid "deslocava" um canonical
// anterior, deixando entries LID órfãs (causa raiz da duplicação Vanessa).
describe('IngestionService LID dedup', () => {
  it('merges stale LID contact into canonical when inbound resolves the LID', async () => {
    let getContactCalls = 0;
    const { service, contactStore } = makeService();

    // Pre-popula um contato LID stale (cenário: chegou via getChats refresh
    // antes de aprendermos o mapeamento da Vanessa).
    contactStore.set('19975478492855@lid', contactStore.createDefault('19975478492855@lid', {
      name: '19975478492855@lid',
      lastMessageAt: '2026-04-30T12:00:00.000Z',
      lastMessagePreview: 'mensagem antiga',
      unreadCount: 1
    }));

    // Pre-popula o canonical (vanessa via getChats com o nome correto).
    contactStore.set('554499113703@c.us', contactStore.createDefault('554499113703@c.us', {
      name: 'Vanessa Lima',
      phone: '554499113703',
      lastMessageAt: '2026-04-30T11:00:00.000Z'
    }));

    await service.ingestInboundMessage(
      {
        id: { _serialized: 'msg-vanessa', fromMe: false, remote: '19975478492855@lid' },
        from: '19975478492855@lid',
        to: '5511000000000@c.us',
        body: 'oi',
        timestamp: 1700002000,
        getContact: async () => {
          getContactCalls += 1;
          return {
            id: { _serialized: '19975478492855@lid', user: '19975478492855' },
            number: '554499113703'
          };
        }
      },
      'webjs-inbound'
    );

    // O contato LID deve ter desaparecido (mesclado no canonical).
    assert.equal(contactStore.has('19975478492855@lid'), false, 'LID stale deve ter sido mesclado');

    // O canonical deve ter mantido nome correto e absorvido o unreadCount.
    const canonical = contactStore.get('554499113703@c.us');
    assert.ok(canonical);
    assert.equal(canonical.name, 'Vanessa Lima');
    assert.ok((canonical.unreadCount ?? 0) >= 2, 'unreadCount deve incluir o stale + o novo inbound');
  });

  it('does not throw when LID has no stale entry to merge', async () => {
    const { service, contactStore } = makeService();

    await service.ingestInboundMessage(
      {
        id: { _serialized: 'msg-novo', fromMe: false, remote: '19975478492855@lid' },
        from: '19975478492855@lid',
        to: '5511000000000@c.us',
        body: 'primeira',
        timestamp: 1700002001,
        getContact: async () => ({
          id: { _serialized: '19975478492855@lid', user: '19975478492855' },
          number: '554499113703'
        })
      },
      'webjs-inbound'
    );

    // Sem dup: contact criado direto no canonical.
    assert.equal(contactStore.has('19975478492855@lid'), false);
    assert.ok(contactStore.get('554499113703@c.us'));
  });
});
