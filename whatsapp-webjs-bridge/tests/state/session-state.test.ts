import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionState } from '../../src/state/SessionState.js';

describe('SessionState', () => {
  it('starts in initializing state with no QR or error', () => {
    const state = new SessionState('primary', () => '');
    assert.equal(state.status, 'initializing');
    assert.equal(state.qr, null);
    assert.equal(state.lastError, '');
    assert.equal(state.isReady(), false);
  });

  it('exposes snapshot including instance name and jid when ready', () => {
    const state = new SessionState('primary', () => '5511@c.us');
    state.status = 'ready';
    const snap = state.snapshot();
    assert.equal(snap.instanceName, 'primary');
    assert.equal(snap.status, 'ready');
    assert.equal(snap.jid, '5511@c.us');
    assert.equal(snap.hasQr, false);
  });

  it('does not expose jid before ready', () => {
    const state = new SessionState('primary', () => '5511@c.us');
    state.status = 'qr_required';
    state.qr = 'fakeqr';
    const snap = state.snapshot();
    assert.equal(snap.jid, '');
    assert.equal(snap.hasQr, true);
    assert.equal(snap.qr, 'fakeqr');
  });

  it('isReady reflects status', () => {
    const state = new SessionState('x', () => '');
    state.status = 'ready';
    assert.equal(state.isReady(), true);
    state.status = 'disconnected';
    assert.equal(state.isReady(), false);
  });
});
