import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { HistoryController } from '../../src/controllers/HistoryController.js';
import { EventStore } from '../../src/state/EventStore.js';
import type { HistoryService } from '../../src/whatsapp/HistoryService.js';
import type { MessageService } from '../../src/whatsapp/MessageService.js';
import type { SelfJidResolver } from '../../src/whatsapp/SelfJidResolver.js';

function buildApp() {
  const eventStore = new EventStore();

  const historyService = {
    acquireHistorySlot: async () => undefined,
    releaseHistorySlot: () => undefined,
    resolveChatsForHistory: async () => []
  } as unknown as HistoryService;

  const messageService = {
    requireReady: () => null
  } as unknown as MessageService;

  const selfJidResolver = {
    getSerializedMessageId: () => '',
    resolveIsFromMe: () => false
  } as unknown as SelfJidResolver;

  const controller = new HistoryController(
    historyService,
    messageService,
    eventStore,
    selfJidResolver,
    'test-instance'
  );

  const app = express();
  app.get('/api/whatsapp/chats/:jid/messages', controller.messages);
  return { app, eventStore };
}

describe('GET /api/whatsapp/chats/:jid/messages', () => {
  it('falls back to in-memory events when no chats are resolved', async () => {
    const { app, eventStore } = buildApp();

    eventStore.pushEvent({
      id: 'evt-1',
      source: 'ws',
      receivedAt: '2026-04-01T10:00:00.000Z',
      isFromMe: false,
      chatJid: '5511999999999@c.us',
      phone: '5511999999999',
      text: 'primeira',
      payload: {}
    });
    eventStore.pushEvent({
      id: 'evt-2',
      source: 'ws',
      receivedAt: '2026-04-01T10:01:00.000Z',
      isFromMe: false,
      chatJid: '5511888888888@c.us',
      phone: '5511888888888',
      text: 'outra conversa',
      payload: {}
    });
    eventStore.pushEvent({
      id: 'evt-3',
      source: 'ws',
      receivedAt: '2026-04-01T10:02:00.000Z',
      isFromMe: true,
      chatJid: '5511999999999@lid',
      phone: '5511999999999',
      text: 'segunda',
      payload: {}
    });

    const res = await request(app).get('/api/whatsapp/chats/5511999999999%40c.us/messages?limit=10');

    assert.equal(res.status, 200);
    assert.equal(res.body.instanceName, 'test-instance');
    assert.equal(Array.isArray(res.body.events), true);
    assert.equal(res.body.events.length, 2);
    assert.equal(res.body.events[0].id, 'evt-1');
    assert.equal(res.body.events[1].id, 'evt-3');
  });
});
