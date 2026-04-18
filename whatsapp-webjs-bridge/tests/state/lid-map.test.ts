import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LidMap } from '../../src/state/LidMap.js';

describe('LidMap', () => {
  it('stores and retrieves canonical→lid mapping', () => {
    const map = new LidMap();
    map.set('5511987654321@c.us', '144873692885172@lid');
    assert.equal(map.getLid('5511987654321@c.us'), '144873692885172@lid');
  });

  it('reverse lookup via findCanonical', () => {
    const map = new LidMap();
    map.set('5511@c.us', '999@lid');
    assert.equal(map.findCanonical('999@lid'), '5511@c.us');
  });

  it('returns empty string when canonical is unknown', () => {
    const map = new LidMap();
    assert.equal(map.findCanonical('unknown@lid'), '');
  });

  it('deletes and clears entries', () => {
    const map = new LidMap();
    map.set('a@c.us', 'x@lid');
    map.set('b@c.us', 'y@lid');
    assert.equal(map.delete('a@c.us'), true);
    assert.equal(map.getLid('a@c.us'), undefined);
    map.clear();
    assert.equal(map.getLid('b@c.us'), undefined);
  });
});
