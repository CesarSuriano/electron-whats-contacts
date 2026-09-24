import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  Telemetry,
  buildFirestoreDocument,
  sanitizeData,
  sanitizeString
} from '../../src/telemetry/Telemetry.js';

interface CapturedRequest {
  url: string;
  body: {
    fields: Record<string, any>;
  };
}

function createTelemetry(responses: Array<number | 'network-error'> = []) {
  const requests: CapturedRequest[] = [];
  const queueDir = mkdtempSync(path.join(os.tmpdir(), 'uniq-telemetry-'));
  const fetchImpl = (async (url: string, init: { body: string }) => {
    requests.push({ url, body: JSON.parse(init.body) });
    const next = responses.length ? responses.shift()! : 200;
    if (next === 'network-error') {
      throw new Error('offline');
    }
    return { ok: next >= 200 && next < 300, status: next } as Response;
  }) as unknown as typeof fetch;

  const telemetry = new Telemetry();
  telemetry.configure({
    apiKey: 'test-key',
    projectId: 'uniq-test',
    installId: 'install-1',
    sessionId: 'session-1',
    appVersion: '3.0.0',
    env: 'test',
    queueDir,
    hostname: 'LOJA-PC',
    platform: 'win32 test',
    flushIntervalMs: 60_000,
    urgentFlushDelayMs: 60_000,
    fetchImpl
  });

  return { telemetry, requests, queueDir };
}

function eventsOf(request: CapturedRequest): Array<Record<string, any>> {
  return request.body.fields.events.arrayValue.values.map((value: any) => value.mapValue.fields);
}

describe('sanitizeString', () => {
  it('removes phone numbers, whatsapp ids and emails', () => {
    const text = sanitizeString('Falha para 5544999528824@c.us, lid 188149749805310@lid, tel (44) 99952-8824 e a@b.com');
    assert.equal(text.includes('9995'), false);
    assert.equal(text.includes('1881497'), false);
    assert.equal(text.includes('a@b.com'), false);
    assert.match(text, /\[jid\]/);
    assert.match(text, /\[num\]/);
    assert.match(text, /\[email\]/);
  });

  it('removes image data and long base64 blobs', () => {
    const text = sanitizeString(`imagem data:image/png;base64,${'A'.repeat(500)} fim ${'B'.repeat(200)}`);
    assert.equal(text.includes('AAAA'), false);
    assert.equal(text.includes('BBBB'), false);
    assert.match(text, /\[data\]/);
  });

  it('keeps short numbers such as percentages and status codes', () => {
    assert.equal(sanitizeString('loading 99% status 409 tentativa 2/5'), 'loading 99% status 409 tentativa 2/5');
  });

  it('truncates long texts', () => {
    assert.ok(sanitizeString('x'.repeat(1000)).length <= 301);
  });
});

describe('sanitizeData', () => {
  it('keeps only primitive values with safe keys', () => {
    const data = sanitizeData({
      ok: true,
      ms: 120,
      ratio: 0.5,
      nothing: null,
      skipped: undefined,
      invalid: Number.NaN,
      'bad key': 'x',
      nested: { a: 1 } as unknown as string,
      message: 'erro 5544999528824'
    });
    assert.deepEqual(data, { ok: true, ms: 120, ratio: 0.5, nothing: null, message: 'erro [num]' });
  });
});

describe('buildFirestoreDocument', () => {
  it('encodes the batch with typed Firestore values', () => {
    const document = buildFirestoreDocument({
      installId: 'i', appVersion: '3.0.0', env: 'test', hostname: 'pc', platform: 'win32',
      events: [{ name: 'a.b', ts: '2026-09-24T00:00:00.000Z', src: 'bridge', sid: 's', seq: 1, data: { ms: 10, ok: true, ratio: 0.5, note: null } }]
    }, new Date('2026-09-24T01:00:00.000Z')) as { fields: Record<string, any> };

    assert.deepEqual(document.fields.sentAt, { timestampValue: '2026-09-24T01:00:00.000Z' });
    const event = document.fields.events.arrayValue.values[0].mapValue.fields;
    assert.deepEqual(event.seq, { integerValue: '1' });
    const data = event.data.mapValue.fields;
    assert.deepEqual(data.ms, { integerValue: '10' });
    assert.deepEqual(data.ok, { booleanValue: true });
    assert.deepEqual(data.ratio, { doubleValue: 0.5 });
    assert.deepEqual(data.note, { nullValue: null });
  });
});

describe('Telemetry', () => {
  it('does nothing until configured', async () => {
    const telemetry = new Telemetry();
    telemetry.track('session.status', { to: 'ready' });
    await telemetry.flush();
    assert.equal(telemetry.isEnabled(), false);
  });

  it('sends buffered events in one Firestore document with install and session identity', async () => {
    const { telemetry, requests } = createTelemetry();
    telemetry.track('send.message', { ms: 40, ok: true });
    telemetry.track('history.load', { ms: 300 });
    await telemetry.flush();
    telemetry.stopTimers();

    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /projects\/uniq-test\/databases\/\(default\)\/documents\/telemetry\?key=test-key$/);
    assert.equal(requests[0].body.fields.installId.stringValue, 'install-1');
    assert.equal(requests[0].body.fields.hostname.stringValue, 'LOJA-PC');
    const events = eventsOf(requests[0]);
    assert.deepEqual(events.map(event => event.name.stringValue), ['send.message', 'history.load']);
    assert.equal(events[0].sid.stringValue, 'session-1');
  });

  it('ignores invalid event names and never throws', async () => {
    const { telemetry, requests } = createTelemetry();
    telemetry.track('Nome Invalido', { ok: true });
    telemetry.track('', {});
    await telemetry.flush();
    telemetry.stopTimers();
    assert.equal(requests.length, 0);
  });

  it('keeps events in a local queue while offline and sends them when the network returns', async () => {
    const { telemetry, requests, queueDir } = createTelemetry(['network-error']);
    telemetry.track('session.status', { to: 'disconnected' });
    await telemetry.flush();

    const queueFile = path.join(queueDir, 'pending-bridge.jsonl');
    assert.equal(existsSync(queueFile), true);

    telemetry.track('session.status', { to: 'ready' });
    await telemetry.flush();
    telemetry.stopTimers();

    const sentNames = requests.slice(1).flatMap(request => eventsOf(request).map(event => event.data.mapValue.fields.to.stringValue));
    assert.deepEqual(sentNames, ['ready', 'disconnected']);
    assert.equal(existsSync(queueFile), false);
  });

  it('keeps the batch when Firestore rejects it for permission (rules not published yet)', async () => {
    const { telemetry, queueDir } = createTelemetry([403]);
    telemetry.track('bridge.start', {});
    await telemetry.flush();
    telemetry.stopTimers();
    assert.equal(existsSync(path.join(queueDir, 'pending-bridge.jsonl')), true);
  });

  it('drops a malformed batch instead of retrying it forever', async () => {
    const { telemetry, queueDir } = createTelemetry([400]);
    telemetry.track('bridge.start', {});
    await telemetry.flush();
    telemetry.stopTimers();
    assert.equal(existsSync(path.join(queueDir, 'pending-bridge.jsonl')), false);
  });

  it('forwards events written by the Electron main process', async () => {
    const { telemetry, requests, queueDir } = createTelemetry();
    writeFileSync(
      path.join(queueDir, 'pending-main.jsonl'),
      `${JSON.stringify({ name: 'bridge.exit', ts: '2026-09-24T00:00:00.000Z', sid: 'previous-session', data: { code: 1 } })}\nlixo\n`
    );

    await telemetry.flush();
    telemetry.stopTimers();

    const events = eventsOf(requests[0]);
    assert.equal(events[0].name.stringValue, 'bridge.exit');
    assert.equal(events[0].src.stringValue, 'main');
    assert.equal(events[0].sid.stringValue, 'previous-session');
    assert.equal(existsSync(path.join(queueDir, 'pending-main.jsonl')), false);
  });

  it('writes pending events to disk synchronously on exit', () => {
    const { telemetry, queueDir } = createTelemetry();
    telemetry.track('bridge.memory', { rssMb: 200 });
    telemetry.persistPendingSync();
    telemetry.stopTimers();

    const saved = readFileSync(path.join(queueDir, 'pending-bridge.jsonl'), 'utf8').trim();
    assert.equal(JSON.parse(saved).events[0].name, 'bridge.memory');
  });

  it('accepts renderer events through trackExternal with sanitized data', async () => {
    const { telemetry, requests } = createTelemetry();
    const accepted = telemetry.trackExternal([
      { name: 'ui.send', ts: '2026-09-24T00:00:00.000Z', data: { ms: 900, text: 'para 5544999528824' } },
      { name: 'INVALIDO' },
      null
    ], 'renderer');
    await telemetry.flush();
    telemetry.stopTimers();

    assert.equal(accepted, 1);
    const event = eventsOf(requests[0])[0];
    assert.equal(event.src.stringValue, 'renderer');
    assert.equal(event.data.mapValue.fields.text.stringValue, 'para [num]');
  });

  it('builds a stable anonymous contact reference without the phone digits', () => {
    const { telemetry } = createTelemetry();
    telemetry.stopTimers();
    const first = telemetry.contactRef('5544999528824@c.us');
    assert.equal(first, telemetry.contactRef('5544999528824@c.us'));
    assert.equal(first.length, 12);
    assert.equal(first.includes('9995'), false);
    assert.notEqual(first, telemetry.contactRef('5544988887777@c.us'));
  });
});
