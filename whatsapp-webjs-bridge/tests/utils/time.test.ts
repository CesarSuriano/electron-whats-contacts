import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toIsoFromUnixTimestamp, withTimeout, wait } from '../../src/utils/time.js';

describe('toIsoFromUnixTimestamp', () => {
  it('returns ISO string for 0 (falls back to now)', () => {
    const result = toIsoFromUnixTimestamp(0);
    assert.equal(typeof result, 'string');
    assert.ok(result.includes('T'));
  });

  it('converts known unix timestamp to ISO', () => {
    assert.equal(toIsoFromUnixTimestamp(1700000000), '2023-11-14T22:13:20.000Z');
  });

  it('returns string for negative (falls back to now)', () => {
    assert.equal(typeof toIsoFromUnixTimestamp(-1), 'string');
  });

  it('returns string for NaN (falls back to now)', () => {
    assert.equal(typeof toIsoFromUnixTimestamp(Number('NaN')), 'string');
  });

  it('returns string for non-number (falls back to now)', () => {
    assert.equal(typeof toIsoFromUnixTimestamp('abc'), 'string');
  });
});

describe('withTimeout', () => {
  it('resolves with inner value when in time', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000, 'test');
    assert.equal(result, 'ok');
  });

  it('rejects with timeout message when slow', async () => {
    const slow = new Promise(resolve => setTimeout(() => resolve('late'), 200));
    await assert.rejects(
      () => withTimeout(slow, 20, 'slow-op'),
      /Timeout while slow-op/
    );
  });

  it('propagates inner rejection', async () => {
    const rejecting = Promise.reject(new Error('boom'));
    await assert.rejects(
      () => withTimeout(rejecting, 100, 'rejecting'),
      /boom/
    );
  });
});

describe('wait', () => {
  it('resolves after the given delay', async () => {
    const start = Date.now();
    await wait(20);
    assert.ok(Date.now() - start >= 15);
  });
});
