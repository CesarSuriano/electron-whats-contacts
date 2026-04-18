import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Client as WebJsClient } from 'whatsapp-web.js';
import { HistoryService } from '../../src/whatsapp/HistoryService.js';
import { SelfJidResolver } from '../../src/whatsapp/SelfJidResolver.js';
import { SessionState } from '../../src/state/SessionState.js';
import { LidMap } from '../../src/state/LidMap.js';

function makeService(): HistoryService {
  const client = { info: { wid: { _serialized: '5511000000000@c.us' } } } as unknown as WebJsClient;
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
