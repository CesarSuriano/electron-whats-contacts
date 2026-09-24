import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import type { Client as WebJsClient } from 'whatsapp-web.js';
import { readLeanAgenda } from '../../src/whatsapp/readLeanAgenda.js';

describe('readLeanAgenda', () => {
  it('keeps the library contact mapping for 5000 contacts without fetching business profiles', async () => {
    const models = Array.from({ length: 5000 }, (_, index) => ({
      id: { _serialized: `${5511000000000 + index}@c.us`, user: String(5511000000000 + index) },
      userid: String(5511000000000 + index),
      name: `Cliente ${index}`,
      isMe: false,
      isMyContact: true,
      isBusiness: index % 2 === 0
    }));
    models[17] = {
      ...models[17],
      id: { _serialized: '12345678901234@lid', user: '12345678901234' },
      userid: '5511999999999'
    };

    let modelCalls = 0;
    let businessProfileCalls = 0;
    const pageWindow = {
      require: (moduleName: string) => {
        assert.equal(moduleName, 'WAWebCollections');
        return {
          Contact: { getModelsArray: () => models },
          BusinessProfile: {
            find: () => {
              businessProfileCalls += 1;
              throw new Error('Business profiles should not be fetched');
            }
          }
        };
      },
      WWebJS: {
        getContactModel: (contact: (typeof models)[number]) => {
          modelCalls += 1;
          return { ...contact, businessProfile: { largeField: 'not needed' } };
        }
      }
    };
    const client = {
      pupPage: {
        evaluate: async (pageFunction: () => unknown) => runInNewContext(`(${pageFunction.toString()})()`, { window: pageWindow })
      }
    } as unknown as WebJsClient;

    const contacts = await readLeanAgenda(client);

    assert.equal(contacts.length, 5000);
    assert.equal(modelCalls, 5000);
    assert.equal(businessProfileCalls, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(contacts[0])), {
      id: models[0].id,
      number: models[0].userid,
      name: models[0].name,
      isMe: false,
      isMyContact: true
    });
    assert.equal(contacts[17].id?._serialized, '12345678901234@lid');
    assert.equal(contacts[17].number, '5511999999999');
    assert.equal('businessProfile' in contacts[0], false);
  });

  it('fails safely if the WhatsApp Web contact helpers are unavailable', async () => {
    let heavyGetContactsCalls = 0;
    const client = {
      getContacts: async () => {
        heavyGetContactsCalls += 1;
        return [];
      },
      pupPage: {
        evaluate: async (pageFunction: () => unknown) => runInNewContext(`(${pageFunction.toString()})()`, { window: {} })
      }
    } as unknown as WebJsClient;

    await assert.rejects(readLeanAgenda(client), /contact helpers are not available/);
    assert.equal(heavyGetContactsCalls, 0);
  });
});
