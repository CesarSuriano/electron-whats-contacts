import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Client as WebJsClient } from 'whatsapp-web.js';
import { resolvePhoneFromLid } from '../../src/utils/lidResolver.js';

function makeClient(evaluate: (input: unknown) => Promise<unknown>): WebJsClient {
  return {
    pupPage: {
      evaluate: async (_fn: unknown, input: unknown) => evaluate(input)
    }
  } as unknown as WebJsClient;
}

describe('lidResolver.resolvePhoneFromLid', () => {
  it('returns a real canonical phone when the linked-id lookup resolves to different digits', async () => {
    const client = makeClient(async () => ({
      lid: '12345678901234@lid',
      phone: '5511987654321@c.us'
    }));

    const resolved = await resolvePhoneFromLid(client, '12345678901234@lid');

    assert.equal(resolved, '5511987654321@c.us');
  });

  it('rejects a mirrored canonical alias when the phone only repeats the linked-id digits', async () => {
    const client = makeClient(async () => ({
      lid: '152896658239610@lid',
      phone: '152896658239610@c.us'
    }));

    const resolved = await resolvePhoneFromLid(client, '152896658239610@lid');

    assert.equal(resolved, null);
  });
});