import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { buildRoutes } from '../../src/routes.js';
import { telemetry } from '../../src/telemetry/Telemetry.js';

const noop = (_req: unknown, res: { end: () => void }) => res.end();

describe('POST /api/telemetry', () => {
  let baseUrl = '';
  let server: ReturnType<ReturnType<typeof express>['listen']>;

  before(async () => {
    telemetry.configure({
      apiKey: 'k',
      projectId: 'p',
      installId: 'install-route',
      sessionId: 'session-route',
      appVersion: 'test',
      env: 'test',
      queueDir: mkdtempSync(path.join(os.tmpdir(), 'uniq-telemetry-route-')),
      flushIntervalMs: 60_000,
      urgentFlushDelayMs: 60_000,
      fetchImpl: (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch
    });

    const controllers = new Proxy({}, { get: () => new Proxy({}, { get: () => noop }) });
    const app = express();
    app.use(express.json());
    app.use(buildRoutes({ controllers, config: { maxUploadBytes: 1024 } } as never));
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    telemetry.stopTimers();
    server.close();
  });

  it('accepts JSON batches from the app screen', async () => {
    const response = await fetch(`${baseUrl}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ name: 'ui.send', ts: new Date().toISOString(), data: { ms: 10 } }] })
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 1 });
  });

  it('accepts text/plain batches sent by sendBeacon when the window closes', async () => {
    const response = await fetch(`${baseUrl}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ events: [{ name: 'ui.app_start', data: {} }, { name: 'ui.send', data: {} }] })
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 2 });
  });

  it('ignores malformed bodies', async () => {
    const response = await fetch(`${baseUrl}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'isso não é json'
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 0 });
  });
});
