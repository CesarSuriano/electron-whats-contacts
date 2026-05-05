import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isRecoverableInitError,
  isRecoverableLocalAuthLockError,
  isRecoverableProcessError
} from '../../src/whatsapp/RecoverableErrors.js';

describe('RecoverableErrors', () => {
  it('treats auth timeout as a recoverable init error', () => {
    assert.equal(isRecoverableInitError(new Error('auth timeout')), true);
  });

  it('treats execution context destruction as a recoverable init error', () => {
    assert.equal(
      isRecoverableInitError(new Error('Execution context was destroyed, most likely because of a navigation.')),
      true
    );
  });

  it('treats LocalAuth lock as a recoverable process error', () => {
    const error = new Error('EBUSY: resource busy or locked');
    error.stack = 'Error: EBUSY: resource busy or locked\n    at LocalAuth.js\n    at first_party_sets.db-journal';

    assert.equal(isRecoverableLocalAuthLockError(error), true);
    assert.equal(isRecoverableProcessError(error), true);
  });

  it('treats Runtime.callFunctionOn navigation errors as recoverable process errors', () => {
    const error = new Error('Protocol error (Runtime.callFunctionOn): Execution context was destroyed.');

    assert.equal(isRecoverableProcessError(error), true);
  });

  it('does not hide unrelated fatal errors', () => {
    const error = new Error('Unexpected configuration failure');

    assert.equal(isRecoverableInitError(error), false);
    assert.equal(isRecoverableProcessError(error), false);
  });
});
