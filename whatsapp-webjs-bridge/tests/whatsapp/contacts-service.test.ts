import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Client as WebJsClient } from 'whatsapp-web.js';
import { ContactsService } from '../../src/whatsapp/ContactsService.js';
import { SelfJidResolver } from '../../src/whatsapp/SelfJidResolver.js';
import { SessionState } from '../../src/state/SessionState.js';
import { ContactStore } from '../../src/state/ContactStore.js';
import { EventStore } from '../../src/state/EventStore.js';
import { LidMap } from '../../src/state/LidMap.js';

type FakeClient = Partial<{
  info: { wid: { _serialized: string } };
  getChats: () => Promise<unknown[]>;
  getContacts: () => Promise<unknown[]>;
  getContactById: (id: string) => Promise<unknown>;
  getProfilePicUrl: (id: string) => Promise<string | undefined>;
  getLabels: () => Promise<unknown[]>;
  pupPage: { evaluate: (fn: unknown, ...args: unknown[]) => Promise<unknown> };
}> & { _type: 'FakeClient' };

function createService(clientOverride: Partial<FakeClient>, options?: { enableProfilePhotoFetch?: boolean }): {
  service: ContactsService;
  client: FakeClient;
  contactStore: ContactStore;
  lidMap: LidMap;
  selfJidResolver: SelfJidResolver;
} {
  const fake: FakeClient = {
    _type: 'FakeClient',
    info: { wid: { _serialized: '554498958521@c.us' } },
    getChats: async () => [],
    getContacts: async () => [],
    getContactById: async () => ({}),
    getProfilePicUrl: async () => undefined,
    getLabels: async () => [],
    ...clientOverride
  };
  const client = fake as unknown as WebJsClient;
  const selfJidResolver = new SelfJidResolver(client);
  const sessionState = new SessionState('test', () => selfJidResolver.getOwnJid());
  sessionState.status = 'ready';
  const contactStore = new ContactStore();
  const eventStore = new EventStore();
  const lidMap = new LidMap();
  const service = new ContactsService(client, sessionState, contactStore, eventStore, lidMap, selfJidResolver, options);
  return { service, client: fake, contactStore, lidMap, selfJidResolver };
}

describe('ContactsService.resolveChatLabelNames', () => {
  it('resolves string, numeric and object label ids', () => {
    const { service } = createService({});
    const labelsMap = new Map([['1', 'Importante'], ['2', 'Cliente'], ['3', 'Suporte']]);
    assert.deepEqual(service.resolveChatLabelNames({ labels: ['1', '2'] }, labelsMap), ['Importante', 'Cliente']);
    assert.deepEqual(service.resolveChatLabelNames({ labels: [{ id: '3' }] }, labelsMap), ['Suporte']);
    assert.deepEqual(service.resolveChatLabelNames({ labels: [{ labelId: '1' }] }, labelsMap), ['Importante']);
    assert.deepEqual(service.resolveChatLabelNames({ labels: [1, 2] }, labelsMap), ['Importante', 'Cliente']);
  });

  it('returns empty for unknown labels and deduplicates', () => {
    const { service } = createService({});
    const labelsMap = new Map([['1', 'Importante']]);
    assert.deepEqual(service.resolveChatLabelNames({ labels: ['99'] }, labelsMap), []);
    assert.deepEqual(service.resolveChatLabelNames({ labels: ['1', '1'] }, labelsMap), ['Importante']);
  });

  it('returns empty when chat has no labels', () => {
    const { service } = createService({});
    assert.deepEqual(service.resolveChatLabelNames({}, new Map()), []);
    assert.deepEqual(service.resolveChatLabelNames(null, new Map()), []);
  });
});

describe('ContactsService.fetchProfilePhotoUrl', () => {
  it('returns null when profile photo fetch is disabled', async () => {
    const { service } = createService({}, { enableProfilePhotoFetch: false });
    const result = await service.fetchProfilePhotoUrl('5511999999999@c.us');
    assert.equal(result, null);
  });

  it('falls back to in-page Store when external URLs are unavailable', async () => {
    const fakeDataUrl = 'data:image/png;base64,ZmFrZQ==';
    const { service } = createService({
      getProfilePicUrl: async () => undefined,
      getContactById: async () => ({ getProfilePicUrl: async () => undefined }),
      getContacts: async () => [],
      pupPage: { evaluate: async () => fakeDataUrl }
    }, { enableProfilePhotoFetch: true });
    const result = await service.fetchProfilePhotoUrl('5511999999999@c.us');
    assert.equal(result, fakeDataUrl);
  });

  it('accepts @lid JIDs and uses same fallback path', async () => {
    const fakeDataUrl = 'data:image/png;base64,ZmFrZQ==';
    const linkedJid = '12345678901234@lid';
    const { service } = createService({
      getProfilePicUrl: async () => undefined,
      getContactById: async () => ({
        number: '5511999999999',
        id: { _serialized: linkedJid, user: '12345678901234' },
        getProfilePicUrl: async () => undefined
      }),
      getContacts: async () => [],
      pupPage: { evaluate: async () => fakeDataUrl }
    }, { enableProfilePhotoFetch: true });
    const result = await service.fetchProfilePhotoUrl(linkedJid);
    assert.equal(result, fakeDataUrl);
  });

  it('accepts @g.us JIDs and uses the same fallback path', async () => {
    const fakeDataUrl = 'data:image/png;base64,ZmFrZQ==';
    const groupJid = '120363000000000000@g.us';
    const { service } = createService({
      getProfilePicUrl: async () => undefined,
      getContactById: async () => ({}),
      getContacts: async () => [],
      pupPage: { evaluate: async () => fakeDataUrl }
    }, { enableProfilePhotoFetch: true });
    const result = await service.fetchProfilePhotoUrl(groupJid);
    assert.equal(result, fakeDataUrl);
  });
});

describe('ContactsService.refreshContactsFromChats', () => {
  it('drops self linked-id chats from contacts refresh', async () => {
    const { service, contactStore } = createService({
      getChats: async () => [
        {
          id: { _serialized: '144873692885172@lid' },
          isGroup: false,
          name: 'Eu',
          timestamp: 1713295905,
          unreadCount: 0,
          lastMessage: { body: '123', fromMe: true }
        }
      ],
      getContacts: async () => [
        {
          id: { _serialized: '144873692885172@lid', user: '144873692885172' },
          isMe: true,
          isMyContact: false,
          number: '144873692885172'
        }
      ]
    });

    await service.refreshContactsFromChats();
    assert.equal(contactStore.has('144873692885172@lid'), false);
  });

  it('upserts 1:1 chats with labels and preview', async () => {
    const { service, contactStore } = createService({
      getChats: async () => [
        {
          id: { _serialized: '5511987654321@c.us' },
          isGroup: false,
          name: 'Cliente A',
          timestamp: 1713000000,
          unreadCount: 2,
          labels: ['1'],
          lastMessage: { body: 'Mensagem', fromMe: false, type: 'chat' }
        }
      ],
      getContacts: async () => [],
      getLabels: async () => [{ id: '1', name: 'Importante' }]
    });

    await service.refreshContactsFromChats();
    const entry = contactStore.get('5511987654321@c.us');
    assert.ok(entry);
    assert.equal(entry.name, 'Cliente A');
    assert.equal(entry.lastMessagePreview, 'Mensagem');
    assert.equal(entry.lastMessageFromMe, false);
    assert.equal(entry.unreadCount, 2);
    assert.deepEqual(entry.labels, ['Importante']);
    assert.equal(entry.isGroup, false);
    assert.equal(entry.fromGetChats, true);
  });

  it('preserves @g.us group chats', async () => {
    const { service, contactStore } = createService({
      getChats: async () => [
        {
          id: { _serialized: '120363000000000000@g.us' },
          isGroup: true,
          name: 'Grupo de trabalho',
          timestamp: 1713000000,
          lastMessage: { body: 'olá', fromMe: false, type: 'chat' }
        }
      ],
      getContacts: async () => []
    });

    await service.refreshContactsFromChats();
    const entry = contactStore.get('120363000000000000@g.us');
    assert.ok(entry);
    assert.equal(entry.isGroup, true);
    assert.equal(entry.name, 'Grupo de trabalho');
  });

  it('collapses a stale fake canonical contact when the real canonical is resolved for the same linked-id', async () => {
    const { service, contactStore, lidMap } = createService({
      getChats: async () => [
        {
          id: { _serialized: '278649089585374@lid' },
          isGroup: false,
          name: 'Noiva Do Miro',
          timestamp: 1713000000,
          unreadCount: 1,
          lastMessage: { body: 'Oi', fromMe: false, type: 'chat' }
        }
      ],
      getContacts: async () => [
        {
          id: { _serialized: '278649089585374@lid', user: '278649089585374' },
          isMyContact: true,
          isMe: false,
          number: '554499104514'
        }
      ]
    });

    lidMap.set('278649089585374@c.us', '278649089585374@lid');
    contactStore.set('278649089585374@c.us', contactStore.createDefault('278649089585374@c.us', {
      phone: '278649089585374',
      name: 'Noiva Do Miro',
      found: true,
      unreadCount: 2,
      lastMessagePreview: '?'
    }));

    await service.refreshContactsFromChats();

    assert.equal(contactStore.has('278649089585374@c.us'), false);
    assert.equal(lidMap.findCanonical('278649089585374@lid'), '554499104514@c.us');
    assert.ok(contactStore.get('554499104514@c.us'));
  });

  it('keeps a linked chat as raw @lid when the linked-id lookup only mirrors the lid digits', async () => {
    let evaluateCalls = 0;
    const { service, contactStore, lidMap } = createService({
      getChats: async () => [
        {
          id: { _serialized: '278649089585374@lid' },
          isGroup: false,
          name: 'Noiva Do Miro',
          timestamp: 1713000000,
          unreadCount: 1,
          lastMessage: { body: '?', fromMe: false, type: 'chat' }
        }
      ],
      getContacts: async () => [],
      getContactById: async () => ({}),
      pupPage: {
        evaluate: async () => {
          evaluateCalls += 1;
          return { lid: '278649089585374@lid', phone: '278649089585374@c.us' };
        }
      }
    });

    await service.refreshContactsFromChats();

    assert.equal(evaluateCalls > 0, true);
    assert.equal(contactStore.has('278649089585374@c.us'), false);
    assert.equal(contactStore.has('278649089585374@lid'), true);
    assert.equal(lidMap.findCanonical('278649089585374@lid'), '');
  });

  it('keeps a linked chat as raw @lid when getContactById returns a mirrored personal alias', async () => {
    const { service, contactStore, lidMap } = createService({
      getChats: async () => [
        {
          id: { _serialized: '152896658239610@lid' },
          isGroup: false,
          name: 'Contato Espelhado',
          timestamp: 1713000000,
          unreadCount: 1,
          lastMessage: { body: 'Foi', fromMe: false, type: 'chat' }
        }
      ],
      getContacts: async () => [],
      getContactById: async () => ({
        id: { _serialized: '152896658239610@c.us', user: '152896658239610' },
        isMyContact: false,
        isMe: false,
        number: '152896658239610'
      })
    });

    await service.refreshContactsFromChats();

    assert.equal(contactStore.has('152896658239610@c.us'), false);
    assert.equal(contactStore.has('152896658239610@lid'), true);
    assert.equal(lidMap.findCanonical('152896658239610@lid'), '');
  });
});

describe('ContactsService.loadLabels', () => {
  it('includes chat jids assigned to each label', async () => {
    const { service } = createService({
      getLabels: async () => [
        {
          id: '1',
          name: 'Importante',
          hexColor: '#25D366',
          getChats: async () => [
            { id: { _serialized: '5511987654321@c.us' } },
            { id: { _serialized: '5511977778888@c.us' } }
          ]
        }
      ]
    });

    const labels = await service.loadLabels();

    assert.deepEqual(labels, [{
      id: '1',
      name: 'Importante',
      hexColor: '#25D366',
      chatJids: ['5511987654321@c.us', '5511977778888@c.us']
    }]);
  });
});

describe('ContactsService.waitForContactsWarmup', () => {
  it('retries a refresh immediately when the cache is still empty after a recent ready warmup', async () => {
    let getChatsCalls = 0;
    const { service } = createService({
      getChats: async () => {
        getChatsCalls += 1;
        return [];
      },
      getContacts: async () => []
    });

    (service as unknown as { lastContactsRefreshAt: number }).lastContactsRefreshAt = Date.now();

    await service.waitForContactsWarmup(true);

    assert.equal(getChatsCalls, 1);
  });
});
