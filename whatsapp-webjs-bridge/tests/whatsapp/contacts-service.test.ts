import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Client as WebJsClient } from 'whatsapp-web.js';
import type { RawContact } from '../../src/domain/types.js';
import { ContactsService, type ContactsServiceOptions } from '../../src/whatsapp/ContactsService.js';
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

function createService(clientOverride: Partial<FakeClient>, options?: ContactsServiceOptions): {
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
  const service = new ContactsService(client, sessionState, contactStore, eventStore, lidMap, selfJidResolver, {
    readAgenda: () => fake.getContacts?.() as Promise<RawContact[]>,
    ...options
  });
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

  it('never reads the whole phone agenda while looking up a photo', async () => {
    let getContactsCalls = 0;
    const { service } = createService({
      getProfilePicUrl: async () => undefined,
      getContactById: async () => ({ getProfilePicUrl: async () => undefined }),
      getContacts: async () => {
        getContactsCalls += 1;
        return [];
      },
      pupPage: { evaluate: async () => null }
    }, { enableProfilePhotoFetch: true });

    const result = await service.fetchProfilePhotoUrl('5511999999999@c.us');

    assert.equal(result, null);
    assert.equal(getContactsCalls, 0);
  });

  it('finds the linked id of a photo in the agenda already loaded in memory', async () => {
    const linkedJid = '12345678901234@lid';
    const lookedUp: string[] = [];
    const { service, lidMap } = createService({
      getChats: async () => [],
      getContacts: async () => [
        { id: { _serialized: linkedJid, user: '12345678901234' }, number: '5511999999999', isMyContact: false }
      ],
      getProfilePicUrl: async (id: string) => {
        lookedUp.push(id);
        return undefined;
      },
      getContactById: async () => ({ getProfilePicUrl: async () => undefined }),
      pupPage: { evaluate: async () => null }
    }, { enableProfilePhotoFetch: true });

    await service.refreshContactsFromChats();
    await service.whenAgendaSettled();
    await service.fetchProfilePhotoUrl('5511999999999@c.us');

    assert.equal(lidMap.getLid('5511999999999@c.us'), linkedJid);
    assert.ok(lookedUp.includes(linkedJid));
  });

  it('still fetches a business contact photo after the lean agenda is applied', async () => {
    const businessJid = '5511999999999@c.us';
    const fakeDataUrl = 'data:image/png;base64,ZmFrZQ==';
    const { service, contactStore } = createService({
      getContacts: async () => [{
        id: { _serialized: businessJid, user: '5511999999999' },
        number: '5511999999999',
        name: 'Loja',
        isMyContact: true,
        isMe: false,
        isBusiness: true
      }],
      getProfilePicUrl: async () => undefined,
      getContactById: async () => ({ getProfilePicUrl: async () => undefined }),
      pupPage: { evaluate: async () => fakeDataUrl }
    }, { enableProfilePhotoFetch: true });

    await service.refreshContactsFromChats();
    await service.whenAgendaSettled();

    assert.equal(contactStore.get(businessJid)?.name, 'Loja');
    assert.equal(await service.fetchProfilePhotoUrl(businessJid), fakeDataUrl);
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
    await service.whenAgendaSettled();
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

  it('takes the last message ack from the chat list so the preview shows delivery ticks', async () => {
    const { service, contactStore } = createService({
      getChats: async () => [
        {
          id: { _serialized: '5511987654321@c.us' },
          isGroup: false,
          name: 'Cliente A',
          timestamp: 1713000000,
          lastMessage: { body: 'Parabéns!', fromMe: true, type: 'chat', ack: 3 }
        },
        {
          id: { _serialized: '5511912345678@c.us' },
          isGroup: false,
          name: 'Cliente B',
          timestamp: 1713000001,
          lastMessage: { body: 'Oi', fromMe: false, type: 'chat' }
        }
      ],
      getContacts: async () => [],
      getLabels: async () => []
    });

    await service.refreshContactsFromChats();

    assert.equal(contactStore.get('5511987654321@c.us')?.lastMessageAck, 3);
    assert.equal(contactStore.get('5511912345678@c.us')?.lastMessageAck, null);
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
    await service.whenAgendaSettled();

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

describe('ContactsService agenda em segundo plano', () => {
  const chat = {
    id: { _serialized: '5511987654321@c.us' },
    isGroup: false,
    name: 'Cliente com conversa',
    timestamp: 1713000000,
    lastMessage: { body: 'Oi', fromMe: false, type: 'chat' }
  };
  const agendaOnlyContact = {
    id: { _serialized: '5511912345678@c.us', user: '5511912345678' },
    isMyContact: true,
    isMe: false,
    number: '5511912345678',
    name: 'Cliente só na agenda'
  };

  it('does not wait for a slow agenda before finishing the contacts refresh', async () => {
    let releaseAgenda: (contacts: unknown[]) => void = () => undefined;
    const { service, contactStore } = createService({
      getChats: async () => [chat],
      getContacts: () => new Promise(resolve => {
        releaseAgenda = resolve;
      })
    });

    await service.refreshContactsFromChats();

    assert.ok(contactStore.get('5511987654321@c.us'));
    assert.equal(contactStore.has('5511912345678@c.us'), false);

    releaseAgenda([agendaOnlyContact]);
    await service.whenAgendaSettled();

    assert.equal(contactStore.get('5511912345678@c.us')?.name, 'Cliente só na agenda');
    assert.ok(contactStore.get('5511987654321@c.us'));
  });

  it('notifies the app when the agenda arrives with new contacts', async () => {
    const notifiedSizes: number[] = [];
    const { service } = createService({
      getChats: async () => [chat],
      getContacts: async () => [agendaOnlyContact]
    });
    service.setOnContactsUpdated(contacts => notifiedSizes.push(contacts.length));

    await service.triggerRefresh({ reason: 'test' });
    await service.whenAgendaSettled();

    assert.deepEqual(notifiedSizes, [1, 2]);
  });

  it('keeps the list with chat data only when the agenda fails', async () => {
    let getChatsCalls = 0;
    const { service, contactStore } = createService({
      getChats: async () => {
        getChatsCalls += 1;
        return [chat];
      },
      getContacts: async () => {
        throw new Error('Timeout while getContacts');
      }
    });

    await service.refreshContactsFromChats();
    await service.whenAgendaSettled();

    assert.equal(getChatsCalls, 1);
    assert.ok(contactStore.get('5511987654321@c.us'));
  });

  it('does not refresh again when the agenda did not change', async () => {
    let getChatsCalls = 0;
    const { service } = createService({
      getChats: async () => {
        getChatsCalls += 1;
        return [chat];
      },
      getContacts: async () => [agendaOnlyContact]
    });

    await service.refreshContactsFromChats();
    await service.whenAgendaSettled();
    assert.equal(getChatsCalls, 2, 'a primeira agenda aplica um refresh');

    service.requestAgendaReload();
    await service.whenAgendaSettled();

    assert.equal(getChatsCalls, 2, 'agenda igual não dispara outro refresh');
  });

  it('only starts reading the agenda after the contacts refresh finished', async () => {
    const order: string[] = [];
    let releaseChats: (chats: unknown[]) => void = () => undefined;
    const { service } = createService({
      getChats: () => new Promise(resolve => {
        order.push('getChats');
        releaseChats = resolve;
      }),
      getContacts: async () => {
        order.push('getContacts');
        return [];
      }
    });

    const refresh = service.refreshContactsFromChats();
    await Promise.resolve();
    assert.deepEqual(order, ['getChats']);

    releaseChats([chat]);
    await refresh;
    await service.whenAgendaSettled();
    assert.deepEqual(order, ['getChats', 'getContacts']);
  });

  it('still reads the agenda when the contacts refresh fails', async () => {
    let getContactsCalls = 0;
    const { service } = createService({
      getChats: async () => {
        throw new Error('getChats falhou');
      },
      getContacts: async () => {
        getContactsCalls += 1;
        return [];
      }
    });

    await service.triggerRefresh({ reason: 'test' });
    await service.whenAgendaSettled();

    assert.equal(getContactsCalls, 1);
  });

  it('ignores a cached agenda that belongs to another account', async () => {
    const { service, contactStore, client } = createService({
      getChats: async () => [],
      getContacts: async () => [agendaOnlyContact]
    });

    await service.refreshContactsFromChats();
    await service.whenAgendaSettled();
    assert.ok(contactStore.get('5511912345678@c.us'));

    contactStore.delete('5511912345678@c.us');
    client.info = { wid: { _serialized: '5521999999999@c.us' } };
    let releaseAgenda: (contacts: unknown[]) => void = () => undefined;
    client.getContacts = () => new Promise(resolve => {
      releaseAgenda = resolve;
    });
    (service as unknown as { lastAgendaAttemptAt: number }).lastAgendaAttemptAt = 1;
    await service.refreshContactsFromChats();

    assert.equal(contactStore.has('5511912345678@c.us'), false);
    releaseAgenda([]);
    await service.whenAgendaSettled();
  });
});

describe('ContactsService @lid órfãos', () => {
  function addOrphans(contactStore: ContactStore, count: number): string[] {
    const jids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const jid = `${200000000000000 + index}@lid`;
      contactStore.set(jid, contactStore.createDefault(jid, { phone: '', name: `Cliente ${index}`, found: true }));
      jids.push(jid);
    }
    return jids;
  }

  it('does not hold the contact list longer than the deadline while orphans are still resolving', async () => {
    const pending: Array<(value: unknown) => void> = [];
    const { service, contactStore } = createService({
      getChats: async () => [],
      pupPage: { evaluate: () => new Promise(resolve => pending.push(resolve)) }
    }, { orphanReconcileWaitMs: 20 });
    addOrphans(contactStore, 2);

    let settled = false;
    await service.refreshContactsFromChats();
    void service.whenOrphanReconcileSettled().then(() => {
      settled = true;
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(settled, false, 'a resolução continua em segundo plano');
    pending.forEach(resolve => resolve(null));
    await service.whenOrphanReconcileSettled();
    await service.whenAgendaSettled();
  });

  it('resolves at most 4 orphans at a time', async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const { service, contactStore } = createService({
      getChats: async () => [],
      pupPage: {
        evaluate: async () => {
          calls += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise(resolve => setTimeout(resolve, 5));
          active -= 1;
          return null;
        }
      }
    });
    addOrphans(contactStore, 10);

    await service.refreshContactsFromChats();
    await service.whenOrphanReconcileSettled();
    await service.whenAgendaSettled();

    assert.equal(calls, 10);
    assert.equal(maxActive, 4);
  });

  it('does not retry an orphan that could not be resolved on every refresh', async () => {
    let calls = 0;
    const { service, contactStore } = createService({
      getChats: async () => [],
      pupPage: {
        evaluate: async () => {
          calls += 1;
          return null;
        }
      }
    });
    addOrphans(contactStore, 3);

    await service.refreshContactsFromChats();
    await service.whenOrphanReconcileSettled();
    await service.refreshContactsFromChats();
    await service.whenOrphanReconcileSettled();
    await service.whenAgendaSettled();

    assert.equal(calls, 3);
  });

  it('updates the app when an orphan is resolved after the list was delivered', async () => {
    const pending: Array<(value: unknown) => void> = [];
    const notified: string[][] = [];
    const { service, contactStore, lidMap } = createService({
      getChats: async () => [],
      pupPage: { evaluate: () => new Promise(resolve => pending.push(resolve)) }
    }, { orphanReconcileWaitMs: 20 });
    service.setOnContactsUpdated(contacts => notified.push(contacts.map(contact => contact.jid)));
    const [lidJid] = addOrphans(contactStore, 1);

    await service.refreshContactsFromChats();
    assert.equal(notified.length, 0);

    pending.forEach(resolve => resolve({ lid: lidJid, phone: '5511987654321@c.us' }));
    await service.whenOrphanReconcileSettled();
    await service.whenAgendaSettled();

    assert.equal(lidMap.findCanonical(lidJid), '5511987654321@c.us');
    assert.equal(notified.length, 1);
    assert.ok(notified[0].includes('5511987654321@c.us'));
  });
});

describe('ContactsService agenda salva em disco', () => {
  const agendaContact = {
    id: { _serialized: '5511912345678@c.us', user: '5511912345678' },
    isMyContact: true,
    isMe: false,
    number: '5511912345678',
    name: 'Cliente só na agenda'
  };
  const notSavedContact = {
    id: { _serialized: '5511900000000@c.us', user: '5511900000000' },
    isMyContact: false,
    isMe: false,
    number: '5511900000000',
    name: 'Não salvo'
  };

  function tempAgendaFile(): string {
    return path.join(mkdtempSync(path.join(os.tmpdir(), 'uniq-agenda-')), 'agenda-cache.json');
  }

  async function waitForFile(file: string): Promise<void> {
    for (let attempt = 0; attempt < 50 && !existsSync(file); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  it('saves only the useful agenda fields and shows them right away on the next opening', async () => {
    const agendaCacheFile = tempAgendaFile();
    const first = createService({ getContacts: async () => [agendaContact, notSavedContact] }, { agendaCacheFile });
    await first.service.refreshContactsFromChats();
    await first.service.whenAgendaSettled();
    await waitForFile(agendaCacheFile);

    const saved = JSON.parse(readFileSync(agendaCacheFile, 'utf8'));
    assert.deepEqual(saved.contacts.map((contact: { number: string }) => contact.number), ['5511912345678']);

    let getContactsCalls = 0;
    const second = createService({
      getContacts: async () => {
        getContactsCalls += 1;
        return [];
      }
    }, { agendaCacheFile, agendaFirstLoadDelayMs: 60_000 });
    await second.service.refreshContactsFromChats();
    await second.service.whenAgendaSettled();

    assert.equal(getContactsCalls, 0, 'a leitura do celular fica para depois do atraso');
    assert.equal(second.contactStore.get('5511912345678@c.us')?.name, 'Cliente só na agenda');
  });

  it('reads the phone agenda again on every opening, even with a recent saved copy', async () => {
    const agendaCacheFile = tempAgendaFile();
    writeFileSync(agendaCacheFile, JSON.stringify({ ownerJid: '554498958521@c.us', savedAt: Date.now(), contacts: [agendaContact] }));
    let getContactsCalls = 0;
    const { service } = createService({
      getContacts: async () => {
        getContactsCalls += 1;
        return [agendaContact];
      }
    }, { agendaCacheFile });

    await service.refreshContactsFromChats();
    await service.whenAgendaSettled();
    await service.refreshContactsFromChats();
    await service.whenAgendaSettled();

    assert.equal(getContactsCalls, 1, 'uma leitura por abertura');
  });

  it('reads the agenda right away when the user asks to refresh', async () => {
    let getContactsCalls = 0;
    const { service } = createService({
      getContacts: async () => {
        getContactsCalls += 1;
        return [];
      }
    }, { agendaFirstLoadDelayMs: 60_000, isBusy: () => true });

    await service.refreshContactsFromChats();
    await service.whenAgendaSettled();
    assert.equal(getContactsCalls, 0);

    assert.equal(await service.requestAgendaReload(), true);
    assert.equal(getContactsCalls, 1);
  });

  it('preserves the saved contacts and reports a failed manual refresh', async () => {
    const agendaCacheFile = tempAgendaFile();
    writeFileSync(agendaCacheFile, JSON.stringify({
      ownerJid: '554498958521@c.us', savedAt: Date.now(), contacts: [agendaContact]
    }));
    const { service, contactStore } = createService({
      getContacts: async () => { throw new Error('WhatsApp Web helpers unavailable'); }
    }, { agendaCacheFile, agendaFirstLoadDelayMs: 60_000 });

    await service.refreshContactsFromChats();
    assert.equal(contactStore.get('5511912345678@c.us')?.name, agendaContact.name);

    assert.equal(await service.requestAgendaReload(), false);
    assert.equal(contactStore.get('5511912345678@c.us')?.name, agendaContact.name);
    assert.equal(JSON.parse(readFileSync(agendaCacheFile, 'utf8')).contacts.length, 1);
  });

  it('does not use a saved agenda when the account cannot be identified', async () => {
    const agendaCacheFile = tempAgendaFile();
    writeFileSync(agendaCacheFile, JSON.stringify({ ownerJid: '', savedAt: Date.now(), contacts: [agendaContact] }));
    const { service, contactStore } = createService({ getContacts: () => new Promise(() => undefined) }, {
      agendaCacheFile,
      agendaFirstLoadDelayMs: 60_000
    });

    await service.refreshContactsFromChats();

    assert.equal(contactStore.has('5511912345678@c.us'), false);
  });

  it('ignores a saved agenda that belongs to another account', async () => {
    const agendaCacheFile = tempAgendaFile();
    writeFileSync(agendaCacheFile, JSON.stringify({ ownerJid: '5521999999999@c.us', savedAt: Date.now(), contacts: [agendaContact] }));
    const { service, contactStore } = createService({ getContacts: () => new Promise(() => undefined) }, {
      agendaCacheFile,
      agendaFirstLoadDelayMs: 60_000
    });

    await service.refreshContactsFromChats();

    assert.equal(contactStore.has('5511912345678@c.us'), false);
  });

  it('waits after the opening before the first agenda read', async () => {
    let getContactsCalls = 0;
    const { service } = createService({
      getContacts: async () => {
        getContactsCalls += 1;
        return [];
      }
    }, { agendaFirstLoadDelayMs: 60_000 });

    await service.refreshContactsFromChats();
    await service.whenAgendaSettled();

    assert.equal(getContactsCalls, 0);
  });

  it('does not read the agenda while messages are being sent', async () => {
    let busy = true;
    let getContactsCalls = 0;
    const { service } = createService({
      getContacts: async () => {
        getContactsCalls += 1;
        return [];
      }
    }, { isBusy: () => busy });

    await service.refreshContactsFromChats();
    await service.whenAgendaSettled();
    assert.equal(getContactsCalls, 0);

    busy = false;
    await service.refreshContactsFromChats();
    await service.whenAgendaSettled();
    assert.equal(getContactsCalls, 1);
  });
});
