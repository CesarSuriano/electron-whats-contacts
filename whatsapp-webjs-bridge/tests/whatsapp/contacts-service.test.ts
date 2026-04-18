import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Client as WebJsClient } from 'whatsapp-web.js';
import { ContactsService } from '../../src/whatsapp/ContactsService.js';
import { SelfJidResolver } from '../../src/whatsapp/SelfJidResolver.js';
import { SessionState } from '../../src/state/SessionState.js';
import { ContactStore } from '../../src/state/ContactStore.js';
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
  const lidMap = new LidMap();
  const service = new ContactsService(client, sessionState, contactStore, lidMap, selfJidResolver, options);
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
});
