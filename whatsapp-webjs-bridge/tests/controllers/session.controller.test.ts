import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

import { SessionController } from '../../src/controllers/SessionController.js';
import { SessionState } from '../../src/state/SessionState.js';

function buildApp(status: 'init_error' | 'qr_required' = 'init_error') {
  const sessionState = new SessionState('test-instance', () => '');
  sessionState.status = status;
  sessionState.lastError = 'erro anterior';

  let ensureInitializedCalls = 0;
  let recoveryBudgetResetCalls = 0;

  const sessionManager = {
    getSessionSnapshot: () => sessionState.snapshot(),
    ensureInitialized: async () => {
      ensureInitializedCalls += 1;
      sessionState.status = 'qr_required';
      sessionState.lastError = '';
    },
    disconnect: async () => undefined,
    getInstanceSummary: () => ({
      name: 'test-instance',
      token: 'local-session',
      connected: false,
      jid: '',
      webhook: ''
    })
  };

  const recoveryBudget = {
    reset: () => {
      recoveryBudgetResetCalls += 1;
    }
  };

  const controller = new SessionController(
    sessionManager as never,
    sessionState,
    recoveryBudget as never
  );

  const app = express();
  app.post('/api/whatsapp/session/connect', controller.connect);

  return {
    app,
    getEnsureInitializedCalls: () => ensureInitializedCalls,
    getRecoveryBudgetResetCalls: () => recoveryBudgetResetCalls
  };
}

describe('POST /api/whatsapp/session/connect', () => {
  it('resets the shared recovery budget before retrying a failed session', async () => {
    const { app, getEnsureInitializedCalls, getRecoveryBudgetResetCalls } = buildApp('init_error');

    const res = await request(app).post('/api/whatsapp/session/connect');

    assert.equal(res.status, 200);
    assert.equal(getRecoveryBudgetResetCalls(), 1);
    assert.equal(getEnsureInitializedCalls(), 1);
    assert.equal(res.body.status, 'qr_required');
  });

  it('resets the shared recovery budget even when the QR is already available', async () => {
    const { app, getEnsureInitializedCalls, getRecoveryBudgetResetCalls } = buildApp('qr_required');

    const res = await request(app).post('/api/whatsapp/session/connect');

    assert.equal(res.status, 200);
    assert.equal(getRecoveryBudgetResetCalls(), 1);
    assert.equal(getEnsureInitializedCalls(), 0);
    assert.equal(res.body.status, 'qr_required');
  });
});
