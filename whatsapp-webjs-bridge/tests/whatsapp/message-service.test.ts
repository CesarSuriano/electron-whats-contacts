import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Client as WebJsClient, Message } from 'whatsapp-web.js';
import { MessageService } from '../../src/whatsapp/MessageService.js';
import { SelfJidResolver } from '../../src/whatsapp/SelfJidResolver.js';
import { SessionState } from '../../src/state/SessionState.js';
import { EventStore } from '../../src/state/EventStore.js';
import { ContactStore } from '../../src/state/ContactStore.js';
import { LidMap } from '../../src/state/LidMap.js';

interface FakeSend {
  lastArgs?: { chatId: string; content: unknown; options?: unknown };
  response: {
    id?: { _serialized?: string; remote?: { _serialized?: string } | string };
    timestamp?: number;
    to?: string;
    ack?: number;
  };
}

function buildService(
  fakeSend: FakeSend,
  options: {
    ready?: boolean;
    getChatById?: (id: string) => Promise<{ sendSeen?: () => Promise<unknown> } | null | undefined>;
    clientOverride?: Partial<WebJsClient>;
  } = {}
): {
  service: MessageService;
  eventStore: EventStore;
  contactStore: ContactStore;
  lidMap: LidMap;
} {
  const client = {
    info: { wid: { _serialized: '5511000000000@c.us' } },
    sendMessage: async (chatId: string, content: unknown, opts?: unknown) => {
      fakeSend.lastArgs = { chatId, content, options: opts };
      return fakeSend.response;
    },
    getMessageById: async () => null,
    getChatById: options.getChatById || (async () => ({ sendSeen: async () => true })),
    ...options.clientOverride
  } as unknown as WebJsClient;

  const selfJidResolver = new SelfJidResolver(client);
  const sessionState = new SessionState('test', () => selfJidResolver.getOwnJid());
  sessionState.status = options.ready === false ? 'initializing' : 'ready';
  const eventStore = new EventStore();
  const contactStore = new ContactStore();
  const lidMap = new LidMap();
  const service = new MessageService(client, sessionState, eventStore, contactStore, lidMap, selfJidResolver);
  return { service, eventStore, contactStore, lidMap };
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

  it('accepts a linked-id destination', () => {
    const { service } = buildService({ response: {} });
    const v = service.validateDestination('120363999999999999@lid');
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.chatId, '120363999999999999@lid');
    }
  });

  it('accepts group JIDs', () => {
    const { service } = buildService({ response: {} });
    const v = service.validateDestination('120363000000000000@g.us');
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.chatId, '120363000000000000@g.us');
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

  it('prefers a known Brazilian 8-digit conversation over the 9th-digit alias', () => {
    const { service, contactStore } = buildService({ response: {} });
    contactStore.set('554399528824@c.us', contactStore.createDefault('554399528824@c.us', {
      found: true,
      fromGetChats: true,
      getChatsTimestampMs: 1700001000000
    }));

    const v = service.validateDestination('5543999528824@c.us');

    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.chatId, '554399528824@c.us');
    }
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

  it('records a linked-id mapping only when the sent metadata itself carries the linked destination', async () => {
    const fakeSend: FakeSend = {
      response: {
        id: {
          _serialized: 'true_152896658239610@lid_msg-1',
          remote: '152896658239610@lid'
        },
        timestamp: 1700001001,
        to: '152896658239610@lid',
        ack: 0
      }
    };
    const { service, lidMap } = buildService(fakeSend);

    await service.sendText('554498143537@c.us', 'Olá');

    assert.equal(lidMap.getLid('554498143537@c.us'), '152896658239610@lid');
  });

  it('does not run speculative linked-id discovery after send when metadata has no linked destination', async () => {
    let evaluateCalls = 0;
    const fakeSend: FakeSend = {
      response: { id: { _serialized: 'sent-plain' }, timestamp: 1700001002, to: '554498143537@c.us', ack: 0 }
    };
    const { service, lidMap } = buildService(fakeSend, {
      clientOverride: {
        pupPage: {
          evaluate: async () => {
            evaluateCalls += 1;
            return { lid: '152896658239610@lid', phone: '554498143537@c.us' };
          }
        }
      } as unknown as Partial<WebJsClient>
    });

    await service.sendText('554498143537@c.us', 'Olá');

    assert.equal(evaluateCalls, 0);
    assert.equal(lidMap.getLid('554498143537@c.us') || '', '');
  });

  it('sends text to groups and preserves the contact as a group conversation', async () => {
    const fakeSend: FakeSend = {
      response: { id: { _serialized: 'sent-group' }, timestamp: 1700001003, to: '120363000000000000@g.us', ack: 0 }
    };
    const { service, contactStore } = buildService(fakeSend);

    const result = await service.sendText('120363000000000000@g.us', 'Olá grupo');

    assert.equal(result.to, '120363000000000000@g.us');
    assert.equal(fakeSend.lastArgs?.chatId, '120363000000000000@g.us');
    assert.equal(contactStore.get('120363000000000000@g.us')?.isGroup, true);
  });

  it('retries text send with the Brazilian 8-digit alias when the 9th-digit destination fails', async () => {
    const attempts: string[] = [];
    const fakeSend: FakeSend = { response: {} };
    const { service, eventStore, contactStore } = buildService(fakeSend, {
      clientOverride: {
        sendMessage: async (chatId: string, content: string) => {
          attempts.push(chatId);
          if (chatId === '5543999528824@c.us') {
            throw new Error('number not registered');
          }

          return {
            id: { _serialized: 'sent-br-alt' },
            timestamp: 1700001300,
            to: chatId,
            ack: 0
          } as unknown as Message;
        }
      } as Partial<WebJsClient>
    });

    const result = await service.sendText('5543999528824@c.us', 'Olá');

    assert.deepEqual(attempts, ['5543999528824@c.us', '554399528824@c.us']);
    assert.equal(result.to, '554399528824@c.us');
    assert.equal(eventStore.events[0]?.chatJid, '554399528824@c.us');
    assert.ok(contactStore.get('554399528824@c.us'));
  });

  // Bug A regression: quando o variante 12-dígito está no contactStore (caso
  // típico — recebemos mensagem dele antes), resolvePreferredPersonalDestination
  // o escolhe como preferido. Se ELE falhar, antes não tentávamos o 13-dígito
  // de volta. Agora deve.
  it('falls back to the 13-digit variant when the preferred 12-digit alias fails', async () => {
    const attempts: string[] = [];
    const fakeSend: FakeSend = { response: {} };
    const { service, contactStore } = buildService(fakeSend, {
      clientOverride: {
        sendMessage: async (chatId: string) => {
          attempts.push(chatId);
          if (chatId === '554399528824@c.us') {
            throw new Error('number not registered');
          }

          return {
            id: { _serialized: 'sent-13' },
            timestamp: 1700001400,
            to: chatId,
            ack: 0
          } as unknown as Message;
        }
      } as Partial<WebJsClient>
    });

    // Pre-popula o contactStore com a variante 12-dígito para forçar o
    // resolvePreferredPersonalDestination a escolhê-la como preferida.
    contactStore.set('554399528824@c.us', contactStore.createDefault('554399528824@c.us', {
      found: true,
      fromGetChats: true,
      getChatsTimestampMs: 1700000000000
    }));

    const result = await service.sendText('5543999528824@c.us', 'Olá');

    assert.deepEqual(attempts, ['554399528824@c.us', '5543999528824@c.us']);
    assert.equal(result.to, '5543999528824@c.us');
  });

  // Bug A regression: quando ambos os variantes falham, deve consultar
  // getNumberId como última tentativa para descobrir o JID canônico.
  it('uses getNumberId lookup as a last resort when both BR variants fail', async () => {
    const attempts: string[] = [];
    let lookupCalls = 0;
    const fakeSend: FakeSend = { response: {} };
    const { service } = buildService(fakeSend, {
      clientOverride: {
        sendMessage: async (chatId: string) => {
          attempts.push(chatId);
          if (chatId === '5544984559728@c.us' || chatId === '554484559728@c.us') {
            throw new Error('number not registered');
          }
          return {
            id: { _serialized: 'sent-canonical' },
            timestamp: 1700001500,
            to: chatId,
            ack: 0
          } as unknown as Message;
        },
        getNumberId: async (phone: string) => {
          lookupCalls += 1;
          // Simula WhatsApp confirmando que o número canônico é uma terceira
          // forma (caso real: número portado / número novo na rede).
          return { _serialized: '5544988887777@c.us' };
        }
      } as unknown as Partial<WebJsClient>
    });

    const result = await service.sendText('5544984559728@c.us', 'Oi');

    assert.equal(lookupCalls, 1);
    assert.deepEqual(attempts, ['5544984559728@c.us', '554484559728@c.us', '5544988887777@c.us']);
    assert.equal(result.to, '5544988887777@c.us');
  });

  // Bug A regression: se BR variants falharem E getNumberId não estiver
  // disponível ou retornar null, o erro original deve subir limpo.
  it('throws original error when no candidate succeeds and getNumberId lookup yields nothing', async () => {
    const attempts: string[] = [];
    const fakeSend: FakeSend = { response: {} };
    const { service } = buildService(fakeSend, {
      clientOverride: {
        sendMessage: async (chatId: string) => {
          attempts.push(chatId);
          throw new Error('all attempts fail');
        },
        getNumberId: async () => null
      } as unknown as Partial<WebJsClient>
    });

    await assert.rejects(
      service.sendText('5544984559728@c.us', 'Oi'),
      /all attempts fail/
    );
    assert.deepEqual(attempts, ['5544984559728@c.us', '554484559728@c.us']);
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

describe('MessageService.markAsSeen', () => {
  it('falls back to the known linked-id when the canonical jid sendSeen fails', async () => {
    const attemptedJids: string[] = [];
    const { service, contactStore, lidMap } = buildService(
      { response: {} },
      {
        getChatById: async (id: string) => {
          attemptedJids.push(id);
          if (id === '5511987654321@c.us') {
            throw new Error('No LID for user');
          }

          return {
            sendSeen: async () => true
          };
        }
      }
    );

    lidMap.set('5511987654321@c.us', '120363999999999999@lid');
    contactStore.set('5511987654321@c.us', contactStore.createDefault('5511987654321@c.us', {
      unreadCount: 3
    }));

    await service.markAsSeen('5511987654321@c.us');

    assert.deepEqual(attemptedJids, ['5511987654321@c.us', '120363999999999999@lid']);
    assert.equal(contactStore.get('5511987654321@c.us')?.unreadCount, 0);
  });

  it('keeps the previous best-effort behavior when no linked-id fallback exists', async () => {
    const attemptedJids: string[] = [];
    const { service } = buildService(
      { response: {} },
      {
        getChatById: async (id: string) => {
          attemptedJids.push(id);
          throw new Error('No LID for user');
        }
      }
    );

    await service.markAsSeen('5511987654321@c.us');

    assert.deepEqual(attemptedJids, ['5511987654321@c.us']);
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
