import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils.js');

// Exercise the installed injection, including the patch applied by postinstall.
// WhatsApp's models copy __x_* fields into their backing state. A MediaData's
// undefined __x_id therefore destroys an otherwise valid outgoing message id.
function buildHarness(media: Record<string, unknown>) {
  let captured: Record<string, any> | undefined;
  const user = { isLid: () => false };
  const chat = { id: user };
  class MsgKey {
    _serialized = 'true_destination_message';
    static async newId() { return 'message'; }
  }
  const modules: Record<string, unknown> = {
    WAWebChatGetters: { getIsNewsletter: () => false, getIsBroadcast: () => false },
    WALinkify: { findLink: () => undefined },
    WAWebUserPrefsMeUser: { getMaybeMeLidUser: () => user, getMaybeMePnUser: () => user },
    WAWebMsgKey: MsgKey,
    WAWebGetEphemeralFieldsMsgActionsUtils: { getEphemeralFields: () => ({}) },
    WAWebSendMsgChatAction: {
      addAndSendMsgToChat: (_chat: unknown, message: Record<string, any>) => {
        const id = Object.hasOwn(message, '__x_id') ? message['__x_id'] : message['id'];
        assert.ok(id, 'Outgoing message identity was overwritten by MediaData internals');
        captured = message;
        return [Promise.resolve(message), Promise.resolve()];
      }
    },
    WAWebCollections: { Msg: { get: () => captured } }
  };
  const window: Record<string, any> = {
    require: (name: string) => {
      assert.ok(name in modules, `Unexpected WhatsApp module: ${name}`);
      return modules[name];
    }
  };
  runInNewContext(`(${LoadUtils.toString()})()`, { window });
  window.WWebJS.processMediaData = async () => media;
  window.WWebJS.processStickerData = async () => media;
  return { window, chat };
}

describe('patched WhatsApp media message construction', () => {
  for (const type of ['image', 'document']) {
    it(`preserves the message id and caption for ${type} MediaData models`, async () => {
      const media = {
        __x_id: undefined,
        __x_mediaBlob: { internal: true },
        preview: 'preview',
        toJSON() {
          return { type, mimetype: type === 'image' ? 'image/png' : 'application/pdf',
            caption: (this as Record<string, unknown>)['caption'], filehash: 'hash' };
        }
      };
      const { window, chat } = buildHarness(media);
      const sent = await window.WWebJS.sendMessage(chat, '', { media: {}, caption: 'Legenda' });
      assert.equal(sent.id._serialized, 'true_destination_message');
      assert.equal(sent.type, type);
      assert.equal(sent.caption, 'Legenda');
      assert.equal(sent.filehash, 'hash');
      assert.equal(Object.hasOwn(sent, '__x_id'), false);
      assert.equal(Object.hasOwn(sent, '__x_mediaBlob'), false);
    });
  }

  it('retains plain-object media fields for stickers', async () => {
    const { window, chat } = buildHarness({ type: 'sticker', mimetype: 'image/webp', filehash: 'hash' });
    const sent = await window.WWebJS.sendMessage(chat, '', { media: {}, sendMediaAsSticker: true });
    assert.equal(sent.type, 'sticker');
    assert.equal(sent.filehash, 'hash');
    assert.equal(sent.id._serialized, 'true_destination_message');
  });

  it('keeps text messages unchanged', async () => {
    const { window, chat } = buildHarness({});
    const sent = await window.WWebJS.sendMessage(chat, 'Texto');
    assert.equal(sent.body, 'Texto');
    assert.equal(sent.type, 'chat');
    assert.equal(sent.id._serialized, 'true_destination_message');
  });
});
