import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { bindClientEvents } from '../../src/container.js';
import { SessionState } from '../../src/state/SessionState.js';
import { wait } from '../../src/utils/time.js';

function createContainer(options: { manualDisconnect?: boolean } = {}) {
  const client = new EventEmitter();
  const sessionState = new SessionState('local-webjs', () => '');
  const broadcasts: Array<{ type: string; payload: unknown }> = [];
  let ensureInitializedCalls = 0;

  const container = {
    client,
    sessionState,
    eventStore: {
      updateEventAck: () => undefined,
      setOnEventPushed: () => undefined
    },
    contactStore: {},
    contactsService: {
      loadLabels: async () => [],
      triggerRefresh: async () => undefined,
      setOnContactsUpdated: () => undefined
    },
    ingestionService: {
      seedEventsFromRecentChats: async () => undefined,
      ingestInboundMessage: async () => undefined,
      ingestAckFromMessage: async () => undefined,
      ingestOutboundFromCreate: async () => undefined
    },
    messageService: {
      propagateAckToContact: () => undefined,
      syncOutboundAckFromMessage: async () => undefined
    },
    sessionManager: {
      ensureInitialized: async () => {
        ensureInitializedCalls += 1;
      },
      isManualDisconnectInProgress: () => Boolean(options.manualDisconnect),
      getSessionSnapshot: () => sessionState.snapshot()
    },
    broadcaster: {
      broadcast: (type: string, payload: unknown) => {
        broadcasts.push({ type, payload });
      }
    },
    selfJidResolver: {
      resolveIsFromMe: () => false,
      resolveOwnJid: () => '',
      getOwnJid: () => ''
    }
  };

  bindClientEvents(container as never);

  return {
    client,
    sessionState,
    broadcasts,
    getEnsureInitializedCalls: () => ensureInitializedCalls
  };
}

describe('bindClientEvents disconnected recovery', () => {
  it('tries to recover the session after an unexpected disconnect', async () => {
    const { client, sessionState, getEnsureInitializedCalls } = createContainer();

    sessionState.status = 'ready';
    client.emit('disconnected', 'LOGOUT');

    await wait(1300);

    assert.equal(getEnsureInitializedCalls(), 1);
  });

  it('does not auto-recover after a manual disconnect', async () => {
    const { client, sessionState, getEnsureInitializedCalls } = createContainer({ manualDisconnect: true });

    sessionState.status = 'ready';
    client.emit('disconnected', 'LOGOUT');

    await wait(1300);

    assert.equal(getEnsureInitializedCalls(), 0);
  });
});