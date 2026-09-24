import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { ContactsController } from '../../src/controllers/ContactsController.js';

function buildApp(refresh: () => Promise<boolean>, getContacts: () => unknown[]) {
  const contactsService = {
    requestAgendaReload: refresh,
    waitForContactsWarmup: async () => undefined
  };
  const contactStore = { size: 0, values: getContacts };
  const controller = new ContactsController(contactsService as never, contactStore as never, {} as never, 'test');
  const app = express();
  app.get('/api/whatsapp/contacts', controller.list);
  return app;
}

describe('GET /api/whatsapp/contacts?refreshAgenda=1', () => {
  it('returns contacts only after the agenda refresh finishes', async () => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let finishRefresh: (value: boolean) => void = () => undefined;
    const refresh = () => {
      markStarted();
      return new Promise<boolean>(resolve => { finishRefresh = resolve; });
    };
    let updated = false;
    const app = buildApp(refresh, () => updated ? [{ jid: '5511999999999@c.us' }] : []);

    const pending = request(app).get('/api/whatsapp/contacts?refreshAgenda=1');
    const responsePromise = pending.then(response => response);
    await started;
    updated = true;
    finishRefresh(true);

    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal(response.body.contacts.length, 1);
  });

  it('reports a failed refresh instead of showing the old list as newly updated', async () => {
    const app = buildApp(async () => false, () => [{ jid: '5511999999999@c.us' }]);
    const response = await request(app).get('/api/whatsapp/contacts?refreshAgenda=1');
    assert.equal(response.status, 503);
    assert.match(response.body.error, /Failed to refresh/);
  });
});
