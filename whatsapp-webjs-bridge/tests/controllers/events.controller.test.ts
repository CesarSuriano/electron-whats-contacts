import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import type { Client as WebJsClient } from 'whatsapp-web.js';
import { EventsController } from '../../src/controllers/EventsController.js';
import { EventStore } from '../../src/state/EventStore.js';
import { ContactStore } from '../../src/state/ContactStore.js';
import { LidMap } from '../../src/state/LidMap.js';
import { SessionState } from '../../src/state/SessionState.js';
import { SelfJidResolver } from '../../src/whatsapp/SelfJidResolver.js';
import { HistoryService } from '../../src/whatsapp/HistoryService.js';
import { IngestionService } from '../../src/whatsapp/IngestionService.js';

function buildApp() {
  const client = {
    info: { wid: { _serialized: '5511000000000@c.us' } },
    getChats: async () => []
  } as unknown as WebJsClient;

  const selfJidResolver = new SelfJidResolver(client);
  const sessionState = new SessionState('test', () => selfJidResolver.getOwnJid());
  sessionState.status = 'ready';
  const eventStore = new EventStore();
  const contactStore = new ContactStore();
  const lidMap = new LidMap();
  const historyService = new HistoryService(client, sessionState, lidMap, selfJidResolver, {
    enableHistoryEvents: false
  });
  const ingestionService = new IngestionService(
    client,
    sessionState,
    eventStore,
    contactStore,
    lidMap,
    selfJidResolver
  );

  const controller = new EventsController(eventStore, historyService, ingestionService, 'test-instance', {
    enableHistoryEvents: false
  });

  const app = express();
  app.get('/api/whatsapp/events', controller.list);
  return { app, eventStore };
}

describe('GET /api/whatsapp/events', () => {
  it('returns events sorted desc by receivedAt', async () => {
    const { app, eventStore } = buildApp();
    eventStore.pushEvent({
      id: 'old',
      source: 'test',
      isFromMe: false,
      chatJid: '5511@c.us',
      receivedAt: '2024-01-01T00:00:00.000Z',
      payload: { id: 'old', timestamp: 0 }
    });
    eventStore.pushEvent({
      id: 'new',
      source: 'test',
      isFromMe: false,
      chatJid: '5511@c.us',
      receivedAt: '2026-01-01T00:00:00.000Z',
      payload: { id: 'new', timestamp: 0 }
    });

    const res = await request(app).get('/api/whatsapp/events');
    assert.equal(res.status, 200);
    assert.equal(res.body.instanceName, 'test-instance');
    assert.equal(res.body.events.length, 2);
    assert.equal(res.body.events[0].id, 'new');
    assert.equal(res.body.events[1].id, 'old');
  });

  it('respects the limit query param', async () => {
    const { app, eventStore } = buildApp();
    for (let i = 0; i < 20; i++) {
      eventStore.pushEvent({
        id: `evt-${i}`,
        source: 'test',
        isFromMe: false,
        chatJid: '5511@c.us',
        receivedAt: new Date(1700000000000 + i * 1000).toISOString(),
        payload: { id: `evt-${i}`, timestamp: i }
      });
    }
    const res = await request(app).get('/api/whatsapp/events?limit=5');
    assert.equal(res.status, 200);
    assert.equal(res.body.events.length, 5);
  });
});
