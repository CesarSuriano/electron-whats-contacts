import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Client as WebJsClient } from 'whatsapp-web.js';
import { SelfJidResolver } from '../../src/whatsapp/SelfJidResolver.js';

interface FakeClientInfo {
  info?: { wid?: unknown; me?: unknown; user?: unknown };
}

function makeClient(info: FakeClientInfo['info']): WebJsClient {
  return { info } as unknown as WebJsClient;
}

describe('SelfJidResolver.getOwnJid', () => {
  it('reads wid._serialized', () => {
    const resolver = new SelfJidResolver(makeClient({ wid: { _serialized: '5511000000000@c.us' } }));
    assert.equal(resolver.getOwnJid(), '5511000000000@c.us');
  });

  it('reconstructs own jid from wid user/server', () => {
    const resolver = new SelfJidResolver(makeClient({ wid: { user: '5511888888888', server: 'c.us' } }));
    assert.equal(resolver.getOwnJid(), '5511888888888@c.us');
  });

  it('falls back to registered self jid when client info is empty', () => {
    const resolver = new SelfJidResolver(makeClient({}));
    resolver.registerSelfJid('5511777777777@c.us');
    assert.equal(resolver.getOwnJid(), '5511777777777@c.us');
  });
});

describe('SelfJidResolver.getSerializedMessageId', () => {
  it('returns string id directly', () => {
    const resolver = new SelfJidResolver(makeClient({}));
    assert.equal(resolver.getSerializedMessageId({ id: 'abc123' }), 'abc123');
  });

  it('returns _serialized from object id', () => {
    const resolver = new SelfJidResolver(makeClient({}));
    assert.equal(
      resolver.getSerializedMessageId({ id: { _serialized: 'true_5511@c.us_abc' } }),
      'true_5511@c.us_abc'
    );
  });

  it('returns empty for object id without _serialized', () => {
    const resolver = new SelfJidResolver(makeClient({}));
    assert.equal(resolver.getSerializedMessageId({ id: {} }), '');
  });

  it('returns empty when no id', () => {
    const resolver = new SelfJidResolver(makeClient({}));
    assert.equal(resolver.getSerializedMessageId({}), '');
    assert.equal(resolver.getSerializedMessageId(null), '');
  });
});

describe('SelfJidResolver.resolveIsFromMe', () => {
  const OWN = '5511000000000@c.us';

  function resolver(): SelfJidResolver {
    return new SelfJidResolver(makeClient({ wid: { _serialized: OWN } }));
  }

  it('reads id.fromMe boolean', () => {
    assert.equal(resolver().resolveIsFromMe({ id: { fromMe: true } }), true);
    assert.equal(resolver().resolveIsFromMe({ id: { fromMe: false } }), false);
  });

  it('detects true_/false_ prefix in serialized id', () => {
    assert.equal(resolver().resolveIsFromMe({ id: { _serialized: 'true_5511@c.us_abc' } }), true);
    assert.equal(resolver().resolveIsFromMe({ id: { _serialized: 'false_5511@c.us_abc' } }), false);
  });

  it('coerces fromMe numbers and strings', () => {
    assert.equal(resolver().resolveIsFromMe({ fromMe: true }), true);
    assert.equal(resolver().resolveIsFromMe({ fromMe: false }), false);
    assert.equal(resolver().resolveIsFromMe({ fromMe: 1 }), true);
    assert.equal(resolver().resolveIsFromMe({ fromMe: 0 }), false);
    assert.equal(resolver().resolveIsFromMe({ fromMe: 'true' }), true);
    assert.equal(resolver().resolveIsFromMe({ fromMe: 'false' }), false);
  });

  it('compares from/author against own jid when fromMe is missing', () => {
    assert.equal(resolver().resolveIsFromMe({ from: OWN, to: '5522@c.us' }), true);
    assert.equal(resolver().resolveIsFromMe({ from: '5522@c.us', to: OWN }), false);
  });

  it('null → false', () => {
    assert.equal(resolver().resolveIsFromMe(null), false);
  });
});

describe('SelfJidResolver.isSelfJid', () => {
  it('matches registered self jid ignoring server differences', () => {
    const resolver = new SelfJidResolver(makeClient({ wid: { _serialized: '5511000000000@c.us' } }));
    assert.equal(resolver.isSelfJid('5511000000000@c.us'), true);
    assert.equal(resolver.isSelfJid('5511000000000@lid'), true);
    assert.equal(resolver.isSelfJid('5522@c.us'), false);
  });

  it('returns false when no own jid is registered', () => {
    const resolver = new SelfJidResolver(makeClient({}));
    assert.equal(resolver.isSelfJid('5511@c.us'), false);
  });
});
