import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Client as WebJsClient } from 'whatsapp-web.js';
import { HistoryService } from '../../src/whatsapp/HistoryService.js';
import { SelfJidResolver } from '../../src/whatsapp/SelfJidResolver.js';
import { SessionState } from '../../src/state/SessionState.js';
import { LidMap } from '../../src/state/LidMap.js';

function makeService(clientOverride: Partial<WebJsClient> = {}): HistoryService {
  const client = {
    info: { wid: { _serialized: '5511000000000@c.us' } },
    getChatById: async () => null,
    getChats: async () => [],
    ...clientOverride
  } as unknown as WebJsClient;
  const selfJidResolver = new SelfJidResolver(client);
  const sessionState = new SessionState('test', () => selfJidResolver.getOwnJid());
  sessionState.status = 'ready';
  const lidMap = new LidMap();
  return new HistoryService(client, sessionState, lidMap, selfJidResolver);
}

describe('HistoryService concurrency control', () => {
  it('acquire/release cycle completes without hanging', async () => {
    const service = makeService();
    await service.acquireHistorySlot();
    await service.acquireHistorySlot();
    service.releaseHistorySlot();
    service.releaseHistorySlot();
  });

  it('extra releases do not throw or go negative', () => {
    const service = makeService();
    assert.doesNotThrow(() => {
      service.releaseHistorySlot();
      service.releaseHistorySlot();
      service.releaseHistorySlot();
    });
  });

  it('queues requests past concurrency limit (4) and releases them in FIFO order', async () => {
    const service = makeService();
    await Promise.all([
      service.acquireHistorySlot(),
      service.acquireHistorySlot(),
      service.acquireHistorySlot(),
      service.acquireHistorySlot()
    ]);

    let fifthAcquired = false;
    const waiter = (async () => {
      await service.acquireHistorySlot();
      fifthAcquired = true;
    })();

    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fifthAcquired, false, 'fifth acquire should still be pending');

    service.releaseHistorySlot();
    await waiter;
    assert.equal(fifthAcquired, true);

    service.releaseHistorySlot();
    service.releaseHistorySlot();
    service.releaseHistorySlot();
    service.releaseHistorySlot();
  });
});

describe('HistoryService history recovery', () => {
  it('tries store fallback when fetch recovery still returns fewer than 10 messages', async () => {
    const sparseHistory = [{ id: { _serialized: 'sparse-0' }, timestamp: 1 }];
    const recoveredHistory = Array.from({ length: 10 }, (_, index) => ({ id: { _serialized: `store-${index}` }, timestamp: index + 1 }));

    const client = {
      info: { wid: { _serialized: '5511000000000@c.us' } },
      getChatById: async () => ({
        fetchMessages: async () => sparseHistory
      })
    } as unknown as WebJsClient;

    const selfJidResolver = new SelfJidResolver(client);
    const sessionState = new SessionState('test', () => selfJidResolver.getOwnJid());
    sessionState.status = 'ready';
    const lidMap = new LidMap();
    const service = new HistoryService(client, sessionState, lidMap, selfJidResolver);
    let storeFallbackCalled = false;
    (service as unknown as { fetchMessagesFromStore: (chatId: string, limit: number) => Promise<unknown[]> }).fetchMessagesFromStore = async () => {
      storeFallbackCalled = true;
      return recoveredHistory;
    };

    const chat = {
      id: { _serialized: '5511999999999@c.us' },
      fetchMessages: async () => sparseHistory,
      syncHistory: async () => undefined
    };

    const history = await service.fetchChatHistoryWithRecovery(
      chat as never,
      '5511999999999@c.us',
      10
    );

    assert.equal(storeFallbackCalled, true);
    assert.equal(history.length, 10);
  });
});

describe('HistoryService.resolveChatsForHistory', () => {
  it('keeps a confirmed linked-id candidate for history lookup when the round-trip resolves back to the requested phone', async () => {
    const lidChat = { id: { _serialized: '12345678901234@lid' }, name: 'Contato' };
    const service = makeService({
      getChatById: async (id: string) => (id === '12345678901234@lid' ? lidChat : null),
      getChats: async () => [],
      pupPage: {
        evaluate: async (_fn: unknown, input: unknown) => {
          if (input === '5511987654321@c.us') {
            return { lid: '12345678901234@lid', phone: '5511987654321@c.us' };
          }
          if (input === '12345678901234@lid') {
            return { lid: '12345678901234@lid', phone: '5511987654321@c.us' };
          }
          return null;
        }
      }
    });

    const historyChats = await service.resolveChatsForHistory('5511987654321@c.us');

    assert.equal(historyChats.length, 1);
    assert.equal(historyChats[0]?.id?._serialized, '12345678901234@lid');
  });

  it('rejects a speculative linked-id candidate for history lookup when the round-trip resolves to a mirrored alias', async () => {
    const wrongLidChat = { id: { _serialized: '152896658239610@lid' }, name: 'Contato errado' };
    const service = makeService({
      getChatById: async (id: string) => (id === '152896658239610@lid' ? wrongLidChat : null),
      getChats: async () => [],
      pupPage: {
        evaluate: async (_fn: unknown, input: unknown) => {
          if (input === '554498143537@c.us') {
            return { lid: '152896658239610@lid', phone: '554498143537@c.us' };
          }
          if (input === '152896658239610@lid') {
            return { lid: '152896658239610@lid', phone: '152896658239610@c.us' };
          }
          return null;
        }
      }
    });

    const historyChats = await service.resolveChatsForHistory('554498143537@c.us');

    assert.equal(historyChats.length, 0);
  });
});
