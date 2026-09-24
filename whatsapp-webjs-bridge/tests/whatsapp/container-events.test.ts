import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { LABELS_POLL_PAUSE_AFTER_SEND_MS, bindClientEvents, isOutboundActive } from '../../src/container.js';
import { SessionState } from '../../src/state/SessionState.js';
import { wait } from '../../src/utils/time.js';

process.env.WA_READY_CHATS_TIMEOUT_MS = '0';

function createContainer(options: {
  manualDisconnect?: boolean;
  allowRecovery?: boolean;
  initializeInFlight?: boolean;
  getChats?: () => Promise<unknown[]>;
} = {}) {
  const client = new EventEmitter();
  Object.assign(client, {
    getChats: options.getChats ?? (async () => [])
  });
  const sessionState = new SessionState('local-webjs', () => '');
  const broadcasts: Array<{ type: string; payload: unknown }> = [];
  let ensureInitializedCalls = 0;
  let triggerRefreshCalls = 0;
  let lastPreloadedChatsCount = -1;
  let recoveryBudgetResetCalls = 0;
  let recoveryBudgetTryConsumeCalls = 0;

  const container = {
    client,
    sessionState,
    eventStore: {
      updateEventAck: () => undefined,
      setOnEventPushed: () => undefined
    },
    contactStore: {},
    contactsService: {
      loadLabels: async () => [{ id: 'label' }],
      triggerRefresh: async (opts?: { preloadedChats?: unknown[] | null }) => {
        triggerRefreshCalls += 1;
        lastPreloadedChatsCount = Array.isArray(opts?.preloadedChats) ? opts!.preloadedChats!.length : -1;
        await wait(20);
      },
      setOnContactsUpdated: () => undefined,
      setInitialContactsWarmup: () => undefined
    },
    ingestionService: {
      seedEventsFromRecentChats: async () => undefined,
      ingestInboundMessage: async () => undefined,
      ingestAckFromMessage: async () => undefined,
      ingestOutboundFromCreate: async () => undefined,
      setOnUnresolvedLid: () => undefined
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
      isInitializeInFlight: () => Boolean(options.initializeInFlight),
      getSessionSnapshot: () => sessionState.snapshot()
    },
    broadcaster: {
      broadcast: (type: string, payload: unknown) => {
        broadcasts.push({ type, payload });
      }
    },
    recoveryBudget: {
      tryConsume: () => {
        recoveryBudgetTryConsumeCalls += 1;
        return options.allowRecovery ?? true;
      },
      reset: () => {
        recoveryBudgetResetCalls += 1;
      },
      get attemptsInWindow() {
        return recoveryBudgetTryConsumeCalls;
      },
      get maxAttemptsAllowed() {
        return 10;
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
    getEnsureInitializedCalls: () => ensureInitializedCalls,
    getTriggerRefreshCalls: () => triggerRefreshCalls,
    getLastPreloadedChatsCount: () => lastPreloadedChatsCount,
    getRecoveryBudgetResetCalls: () => recoveryBudgetResetCalls
  };
}

describe('isOutboundActive', () => {
  it('is inactive before any send', () => {
    assert.equal(isOutboundActive(0, 1_000_000), false);
  });

  it('pauses the labels poll while sends are recent and resumes afterwards', () => {
    const now = 1_000_000;
    assert.equal(isOutboundActive(now - 1_000, now), true);
    assert.equal(isOutboundActive(now - LABELS_POLL_PAUSE_AFTER_SEND_MS, now), false);
  });
});

describe('bindClientEvents disconnected recovery', () => {
  it('tries to recover the session after a transient disconnect', async () => {
    const { client, sessionState, getEnsureInitializedCalls } = createContainer();

    sessionState.status = 'ready';
    // Razão não-terminal — desconexão de rede / page reload — é seguro
    // tentar reconectar.
    client.emit('disconnected', 'NAVIGATION');

    await wait(1300);

    assert.equal(getEnsureInitializedCalls(), 1);
  });

  it('ignores a late disconnected event while an initialization is in flight', async () => {
    const { client, sessionState, getEnsureInitializedCalls } = createContainer({ initializeInFlight: true });

    sessionState.status = 'initializing';
    client.emit('disconnected', 'NAVIGATION');

    await wait(1300);

    assert.equal(getEnsureInitializedCalls(), 0);
    assert.equal(sessionState.status, 'initializing');
  });

  it('processes a terminal LOGOUT even while an initialization is in flight', async () => {
    const { client, sessionState, getEnsureInitializedCalls } = createContainer({ initializeInFlight: true });

    sessionState.status = 'initializing';
    client.emit('disconnected', 'LOGOUT');

    await wait(1300);

    assert.equal(sessionState.status, 'disconnected');
    assert.equal(getEnsureInitializedCalls(), 0);
  });

  it('recovers the session when hydration keeps failing after ready', async () => {
    process.env.WA_READY_CHATS_TIMEOUT_MS = '5000';
    process.env.WA_READY_CHATS_POLL_MS = '5';

    try {
      const { client, sessionState, getEnsureInitializedCalls } = createContainer({
        getChats: async () => {
          throw new Error('Cannot read properties of undefined (reading \'getChats\')');
        }
      });

      client.emit('ready');
      await wait(600);

      assert.equal(getEnsureInitializedCalls(), 1);
      assert.equal(sessionState.status, 'init_error');
      assert.match(sessionState.lastError, /Reiniciando a sessao/i);
      client.emit('auth_failure', 'test cleanup');
    } finally {
      process.env.WA_READY_CHATS_TIMEOUT_MS = '0';
      delete process.env.WA_READY_CHATS_POLL_MS;
    }
  });

  it('does not auto-recover after a manual disconnect', async () => {
    const { client, sessionState, getEnsureInitializedCalls } = createContainer({ manualDisconnect: true });

    sessionState.status = 'ready';
    client.emit('disconnected', 'NAVIGATION');

    await wait(1300);

    assert.equal(getEnsureInitializedCalls(), 0);
  });

  it('stops auto-recovery when the shared recovery budget is exhausted', async () => {
    const { client, sessionState, getEnsureInitializedCalls } = createContainer({ allowRecovery: false });

    sessionState.status = 'ready';
    client.emit('disconnected', 'NAVIGATION');

    await wait(1300);

    assert.equal(getEnsureInitializedCalls(), 0);
    assert.equal(sessionState.status, 'init_error');
    assert.match(sessionState.lastError, /Tentar novamente/i);
  });

  // Bug "logout fantasma": quando o whatsapp-web.js dispara 'disconnected'
  // com razão terminal (sessão removida no servidor), tentar reconectar é
  // inútil e estressa o servidor. Antes a gente fazia retry indefinido.
  for (const terminalReason of ['LOGOUT', 'TOS_BLOCK', 'BAN', 'UNPAIRED', 'CONFLICT']) {
    it(`does not auto-recover when reason is "${terminalReason}" (terminal)`, async () => {
      const { client, sessionState, getEnsureInitializedCalls } = createContainer();

      sessionState.status = 'ready';
      client.emit('disconnected', terminalReason);

      await wait(1300);

      assert.equal(getEnsureInitializedCalls(), 0,
        `Não deveria tentar reconectar com reason terminal "${terminalReason}"`);
    });
  }

  it('ignores duplicate ready bootstraps while the first ready load is still running', async () => {
    const { client, getTriggerRefreshCalls } = createContainer();

    client.emit('ready');
    client.emit('ready');
    client.emit('ready');

    await wait(60);

    assert.equal(getTriggerRefreshCalls(), 1);
    client.emit('auth_failure', 'test cleanup');
  });

  it('resets the shared recovery budget when the client becomes ready', async () => {
    const { client, getRecoveryBudgetResetCalls } = createContainer();

    client.emit('ready');

    await wait(60);

    assert.equal(getRecoveryBudgetResetCalls(), 1);
    client.emit('auth_failure', 'test cleanup');
  });

  it('waits for the chat list to hydrate before the initial refresh', async () => {
    process.env.WA_READY_CHATS_TIMEOUT_MS = '2000';
    process.env.WA_READY_CHATS_POLL_MS = '10';

    try {
      const counts = [1, 3, 5, 5, 5, 5];
      let call = 0;
      const { client, getTriggerRefreshCalls, getLastPreloadedChatsCount } = createContainer({
        getChats: async () => new Array(counts[Math.min(call++, counts.length - 1)]).fill({ id: { _serialized: 'x@c.us' } })
      });

      client.emit('ready');
      await wait(400);

      assert.equal(getTriggerRefreshCalls(), 1);
      assert.equal(getLastPreloadedChatsCount(), 5, 'refresh deveria receber a lista estabilizada');
      client.emit('auth_failure', 'test cleanup');
    } finally {
      process.env.WA_READY_CHATS_TIMEOUT_MS = '0';
      delete process.env.WA_READY_CHATS_POLL_MS;
    }
  });

  it('recovers when authenticated never reaches ready', async () => {
    const previousTimeout = process.env.WA_AUTHENTICATED_READY_TIMEOUT_MS;
    process.env.WA_AUTHENTICATED_READY_TIMEOUT_MS = '20';

    try {
      const { client, sessionState, getEnsureInitializedCalls } = createContainer();

      client.emit('authenticated');

      await wait(60);

      assert.equal(getEnsureInitializedCalls(), 1);
      assert.equal(sessionState.status, 'init_error');
      assert.match(sessionState.lastError, /nao ficou pronto/i);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.WA_AUTHENTICATED_READY_TIMEOUT_MS;
      } else {
        process.env.WA_AUTHENTICATED_READY_TIMEOUT_MS = previousTimeout;
      }
    }
  });
});
