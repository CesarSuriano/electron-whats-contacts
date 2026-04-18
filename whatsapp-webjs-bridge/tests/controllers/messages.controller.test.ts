import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import type { Client as WebJsClient, Message } from 'whatsapp-web.js';
import { MessageService } from '../../src/whatsapp/MessageService.js';
import { MessagesController } from '../../src/controllers/MessagesController.js';
import { SelfJidResolver } from '../../src/whatsapp/SelfJidResolver.js';
import { SessionState } from '../../src/state/SessionState.js';
import { EventStore } from '../../src/state/EventStore.js';
import { ContactStore } from '../../src/state/ContactStore.js';

function buildApp(options: { ready?: boolean; capturedSend?: { chatId?: string; content?: unknown } } = {}) {
  const client = {
    info: { wid: { _serialized: '5511000000000@c.us' } },
    sendMessage: async (chatId: string, content: unknown) => {
      if (options.capturedSend) {
        options.capturedSend.chatId = chatId;
        options.capturedSend.content = content;
      }
      return {
        id: { _serialized: 'sent-id' },
        timestamp: 1700001000,
        to: chatId,
        ack: 0
      } as unknown as Message;
    },
    getMessageById: async () => null,
    getChatById: async () => null
  } as unknown as WebJsClient;

  const selfJidResolver = new SelfJidResolver(client);
  const sessionState = new SessionState('test', () => selfJidResolver.getOwnJid());
  sessionState.status = options.ready === false ? 'initializing' : 'ready';
  const eventStore = new EventStore();
  const contactStore = new ContactStore();
  const messageService = new MessageService(client, sessionState, eventStore, contactStore, selfJidResolver);
  const controller = new MessagesController(messageService, 'test-instance');

  const app = express();
  app.use(express.json());
  app.post('/api/whatsapp/messages', controller.sendText);
  return { app, eventStore, contactStore };
}

describe('POST /api/whatsapp/messages', () => {
  it('returns 400 when required fields are missing', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/whatsapp/messages').send({});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Fields "to" and "text" are required/);
  });

  it('returns 409 when session is not ready', async () => {
    const { app } = buildApp({ ready: false });
    const res = await request(app)
      .post('/api/whatsapp/messages')
      .send({ to: '5511987654321', text: 'Olá' });
    assert.equal(res.status, 409);
    assert.equal(res.body.ok, false);
  });

  it('returns 400 for group destinations', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/whatsapp/messages')
      .send({ to: '120363000000000000@g.us', text: 'Olá' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Group/);
  });

  it('returns 400 when destination is own number', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/whatsapp/messages')
      .send({ to: '5511000000000', text: 'Olá' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /current WhatsApp account/);
  });

  it('sends text and upserts contact with full shape', async () => {
    const captured = {};
    const { app, contactStore, eventStore } = buildApp({ capturedSend: captured });
    const res = await request(app)
      .post('/api/whatsapp/messages')
      .send({ to: '5511987654321', text: 'Olá' });

    assert.equal(res.status, 200);
    assert.equal(res.body.instanceName, 'test-instance');
    assert.equal(res.body.result.id, 'sent-id');
    assert.equal(res.body.result.to, '5511987654321@c.us');

    const contact = contactStore.get('5511987654321@c.us');
    assert.ok(contact);
    assert.equal(contact.lastMessageType, 'chat');
    assert.equal(contact.lastMessageHasMedia, false);
    assert.deepEqual(contact.labels, []);
    assert.equal(contact.isGroup, false);
    assert.equal(contact.unreadCount, 0);
    assert.equal(contact.lastMessageAck, 0);

    assert.equal(eventStore.events.length, 1);
    assert.equal(eventStore.events[0]?.isFromMe, true);
  });
});
