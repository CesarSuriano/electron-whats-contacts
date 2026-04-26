import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SessionState } from '../../src/state/SessionState.js';
import { SessionManager } from '../../src/whatsapp/SessionManager.js';

function createManager(clientOverrides: Partial<{
  initialize: () => Promise<void>;
  destroy: () => Promise<void>;
  logout: () => Promise<void>;
}> = {}) {
  const client = {
    initialize: async () => undefined,
    destroy: async () => undefined,
    logout: async () => undefined,
    ...clientOverrides
  };

  const sessionState = new SessionState('local-webjs', () => '');
  const selfJidResolver = { getOwnJid: () => '' } as const;
  const sessionManager = new SessionManager(
    client as never,
    sessionState,
    selfJidResolver as never,
    'local-webjs'
  );

  return { client, sessionManager, sessionState };
}

describe('SessionManager.ensureInitialized', () => {
  it('destroys a stale client before reconnecting from disconnected state', async () => {
    const calls: string[] = [];
    const { sessionManager, sessionState } = createManager({
      logout: async () => {
        calls.push('logout');
      },
      destroy: async () => {
        calls.push('destroy');
      },
      initialize: async () => {
        calls.push('initialize');
      }
    });

    sessionState.status = 'disconnected';
    sessionState.lastError = 'LOGOUT';

    await sessionManager.ensureInitialized();

    assert.deepEqual(calls, ['logout', 'destroy', 'initialize']);
  });

  it('retries once after a retryable init failure and cleans up before the second attempt', async () => {
    const calls: string[] = [];
    let attempts = 0;
    const { sessionManager } = createManager({
      logout: async () => {
        calls.push('logout');
      },
      destroy: async () => {
        calls.push('destroy');
      },
      initialize: async () => {
        attempts += 1;
        calls.push(`initialize:${attempts}`);
        if (attempts === 1) {
          throw new Error('auth timeout');
        }
      }
    });

    await sessionManager.ensureInitialized();

    assert.deepEqual(calls, ['initialize:1', 'logout', 'destroy', 'initialize:2']);
  });
});