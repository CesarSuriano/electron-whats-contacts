import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { bindClientEvents } from '../../src/container.js';
import { SessionState } from '../../src/state/SessionState.js';
import { wait } from '../../src/utils/time.js';

function createContainer(options: { manualDisconnect?: boolean; allowRecovery?: boolean } = {}) {
  const client = new EventEmitter();
  Object.assign(client, {
    getChats: async () => []
  });
  const sessionState = new SessionState('local-webjs', () => '');
  const broadcasts: Array<{ type: string; payload: unknown }> = [];
  let ensureInitializedCalls = 0;
  let triggerRefreshCalls = 0;
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
      triggerRefresh: async () => {
        triggerRefreshCalls += 1;
        await wait(20);
      },
      setOnContactsUpdated: () => undefined
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
    getRecoveryBudgetResetCalls: () => recoveryBudgetResetCalls
  };
}

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
});
