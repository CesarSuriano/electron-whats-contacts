import { createHash } from 'crypto';
import { promises as fsp } from 'fs';
import { appendFileSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';

// Telemetria de produção: eventos pequenos e anônimos (tempos, estados da
// sessão, erros) gravados em lote no Firestore. Nunca guarda texto de
// mensagem, telefone, nome ou imagem: todo texto passa por sanitizeString.
// track() só empurra para um buffer em memória; o envio é assíncrono e
// nenhum erro de telemetria chega ao restante da bridge.

export type TelemetryValue = string | number | boolean | null;
export type TelemetryData = Record<string, TelemetryValue | undefined>;

export interface TelemetryEvent {
  name: string;
  ts: string;
  src: string;
  sid: string;
  seq: number;
  data: Record<string, TelemetryValue>;
}

interface QueuedBatch {
  installId: string;
  appVersion: string;
  env: string;
  hostname: string;
  platform: string;
  events: TelemetryEvent[];
}

export interface TelemetryConfig {
  apiKey: string;
  projectId: string;
  installId: string;
  sessionId: string;
  appVersion: string;
  env: string;
  queueDir: string;
  hostname?: string;
  platform?: string;
  flushIntervalMs?: number;
  urgentFlushDelayMs?: number;
  fetchImpl?: typeof fetch;
}

const COLLECTION = 'telemetry';
const DEFAULT_FLUSH_INTERVAL_MS = 60_000;
const DEFAULT_URGENT_FLUSH_DELAY_MS = 2_000;
const MAX_BUFFERED_EVENTS = 2_000;
const MAX_EVENTS_PER_DOC = 300;
const MAX_DOC_JSON_CHARS = 700_000;
const MAX_QUEUE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_QUEUED_BATCHES_PER_FLUSH = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_DATA_KEYS = 40;
const MAX_STRING_LENGTH = 300;
const BRIDGE_QUEUE_FILE = 'pending-bridge.jsonl';
const MAIN_QUEUE_FILE = 'pending-main.jsonl';
// Eventos que ajudam a entender quedas de sessão saem logo, para não se
// perderem se o processo morrer antes do envio periódico.
const URGENT_EVENT_PREFIXES = ['session.', 'error.', 'bridge.', 'puppeteer.', 'client.'];

const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const NAME_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;

export function sanitizeString(value: string): string {
  let text = String(value);
  text = text.replace(/data:[^\s,;]+;base64,[A-Za-z0-9+/=]+/g, '[data]');
  text = text.replace(/[A-Za-z0-9+/]{120,}={0,2}/g, '[base64]');
  text = text.replace(/[\w.+:-]+@(c\.us|lid|g\.us|s\.whatsapp\.net|broadcast|newsletter)\b/gi, '[jid]');
  text = text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]');
  text = text.replace(/\+?\d[\d\s().-]{5,}\d/g, match => (match.replace(/\D/g, '').length >= 7 ? '[num]' : match));
  return text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}…` : text;
}

export function sanitizeData(data: TelemetryData | undefined): Record<string, TelemetryValue> {
  const result: Record<string, TelemetryValue> = {};
  if (!data || typeof data !== 'object') {
    return result;
  }

  let count = 0;
  for (const [key, value] of Object.entries(data)) {
    if (count >= MAX_DATA_KEYS || !KEY_PATTERN.test(key) || value === undefined) {
      continue;
    }

    if (value === null || typeof value === 'boolean') {
      result[key] = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        continue;
      }
      result[key] = value;
    } else if (typeof value === 'string') {
      result[key] = sanitizeString(value);
    } else {
      continue;
    }
    count += 1;
  }

  return result;
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === 'string') {
    return error;
  }
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(error);
}

function toFirestoreValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }
  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  return { mapValue: { fields: toFirestoreFields(value as Record<string, unknown>) } };
}

function toFirestoreFields(record: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    fields[key] = toFirestoreValue(value);
  }
  return fields;
}

export function buildFirestoreDocument(batch: QueuedBatch, sentAt: Date): Record<string, unknown> {
  return {
    fields: {
      installId: { stringValue: batch.installId },
      appVersion: { stringValue: batch.appVersion },
      env: { stringValue: batch.env },
      hostname: { stringValue: batch.hostname },
      platform: { stringValue: batch.platform },
      sentAt: { timestampValue: sentAt.toISOString() },
      events: toFirestoreValue(batch.events)
    }
  };
}

export class Telemetry {
  private config: TelemetryConfig | null = null;
  private buffer: TelemetryEvent[] = [];
  private seq = 0;
  private droppedEvents = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private urgentTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;
  private pageErrorCount = 0;

  configure(config: TelemetryConfig): void {
    this.config = {
      ...config,
      hostname: sanitizeString(config.hostname ?? os.hostname()).slice(0, 64),
      platform: config.platform ?? `${os.platform()} ${os.release()} ${os.arch()}`
    };

    try {
      mkdirSync(config.queueDir, { recursive: true });
    } catch {
      // Sem pasta local a fila offline só não persiste.
    }

    this.stopTimers();
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  isEnabled(): boolean {
    return this.config !== null;
  }

  get sessionId(): string {
    return this.config?.sessionId ?? '';
  }

  track(name: string, data?: TelemetryData, src = 'bridge'): void {
    try {
      const config = this.config;
      if (!config || !NAME_PATTERN.test(name)) {
        return;
      }

      this.push({
        name,
        ts: new Date().toISOString(),
        src,
        sid: config.sessionId,
        seq: ++this.seq,
        data: sanitizeData(data)
      });

      if (URGENT_EVENT_PREFIXES.some(prefix => name.startsWith(prefix))) {
        this.scheduleUrgentFlush();
      }
    } catch {
      // Telemetria nunca pode quebrar o fluxo principal.
    }
  }

  trackError(name: string, error: unknown, data?: TelemetryData): void {
    this.track(name, {
      ...data,
      message: errorMessageOf(error),
      errorName: error instanceof Error ? error.name : typeof error
    });
  }

  // Erros de JavaScript dentro do WhatsApp Web podem ser muitos; guarda os
  // primeiros de cada sessão.
  trackLimitedPageError(error: unknown): void {
    if (this.pageErrorCount >= 30) {
      return;
    }
    this.pageErrorCount += 1;
    this.trackError('puppeteer.page_js_error', error, { index: this.pageErrorCount });
  }

  // Eventos vindos da tela ou do processo principal, já com nome/ts próprios.
  trackExternal(events: unknown, defaultSrc: string): number {
    const config = this.config;
    if (!config || !Array.isArray(events)) {
      return 0;
    }

    let accepted = 0;
    for (const raw of events.slice(0, 200)) {
      const candidate = raw as { name?: unknown; ts?: unknown; data?: unknown; sid?: unknown } | null;
      const name = typeof candidate?.name === 'string' ? candidate.name : '';
      if (!NAME_PATTERN.test(name)) {
        continue;
      }
      const ts = typeof candidate?.ts === 'string' && !Number.isNaN(Date.parse(candidate.ts))
        ? new Date(candidate.ts).toISOString()
        : new Date().toISOString();
      const sid = typeof candidate?.sid === 'string' && /^[\w-]{1,64}$/.test(candidate.sid)
        ? candidate.sid
        : config.sessionId;

      this.push({
        name,
        ts,
        src: defaultSrc,
        sid,
        seq: ++this.seq,
        data: sanitizeData(candidate?.data as TelemetryData | undefined)
      });
      accepted += 1;

      if (URGENT_EVENT_PREFIXES.some(prefix => name.startsWith(prefix))) {
        this.scheduleUrgentFlush();
      }
    }

    return accepted;
  }

  // Identificador estável e anônimo de um contato: permite ver repetições
  // (ex.: o mesmo contato falhando) sem expor o número.
  contactRef(jid: string | null | undefined): string {
    const digits = String(jid || '').replace(/\D/g, '');
    if (!digits || !this.config) {
      return '';
    }
    return createHash('sha256').update(`${this.config.installId}:${digits}`).digest('hex').slice(0, 12);
  }

  flush(): Promise<void> {
    if (!this.config) {
      return Promise.resolve();
    }
    if (this.flushPromise) {
      return this.flushPromise;
    }

    this.flushPromise = this.runFlush()
      .catch(() => undefined)
      .finally(() => {
        this.flushPromise = null;
      });
    return this.flushPromise;
  }

  // Na saída do processo não dá para esperar a rede: grava o que sobrou no
  // disco e o próximo início envia.
  persistPendingSync(): void {
    const config = this.config;
    if (!config || !this.buffer.length) {
      return;
    }

    const events = this.buffer.splice(0, this.buffer.length);
    try {
      appendFileSync(path.join(config.queueDir, BRIDGE_QUEUE_FILE), `${JSON.stringify(this.buildBatch(events))}\n`);
    } catch {
      // Sem disco: descarta.
    }
  }

  stopTimers(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.urgentTimer) {
      clearTimeout(this.urgentTimer);
      this.urgentTimer = null;
    }
  }

  private push(event: TelemetryEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > MAX_BUFFERED_EVENTS) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_EVENTS);
      this.droppedEvents += 1;
    }
  }

  private scheduleUrgentFlush(): void {
    if (this.urgentTimer || !this.config) {
      return;
    }
    this.urgentTimer = setTimeout(() => {
      this.urgentTimer = null;
      void this.flush();
    }, this.config.urgentFlushDelayMs ?? DEFAULT_URGENT_FLUSH_DELAY_MS);
    this.urgentTimer.unref?.();
  }

  private buildBatch(events: TelemetryEvent[]): QueuedBatch {
    const config = this.config!;
    return {
      installId: config.installId,
      appVersion: config.appVersion,
      env: config.env,
      hostname: config.hostname ?? '',
      platform: config.platform ?? '',
      events
    };
  }

  private async runFlush(): Promise<void> {
    const config = this.config!;
    await this.absorbMainProcessEvents();

    if (this.droppedEvents > 0) {
      const dropped = this.droppedEvents;
      this.droppedEvents = 0;
      this.push({
        name: 'telemetry.dropped',
        ts: new Date().toISOString(),
        src: 'bridge',
        sid: config.sessionId,
        seq: ++this.seq,
        data: { count: dropped }
      });
    }

    let sentAny = false;
    while (this.buffer.length) {
      const events = this.buffer.splice(0, MAX_EVENTS_PER_DOC);
      const batch = this.buildBatch(events);
      const ok = await this.sendBatch(batch);
      if (!ok) {
        await this.appendToQueue(batch);
        // Sem rede: o restante também vai para a fila local.
        while (this.buffer.length) {
          await this.appendToQueue(this.buildBatch(this.buffer.splice(0, MAX_EVENTS_PER_DOC)));
        }
        return;
      }
      sentAny = true;
    }

    if (sentAny || !this.buffer.length) {
      await this.drainQueue();
    }
  }

  private async sendBatch(batch: QueuedBatch): Promise<boolean> {
    const document = buildFirestoreDocument(batch, new Date());
    const body = JSON.stringify(document);

    if (body.length > MAX_DOC_JSON_CHARS && batch.events.length > 1) {
      const middle = Math.ceil(batch.events.length / 2);
      const first = await this.sendBatch({ ...batch, events: batch.events.slice(0, middle) });
      const second = first && await this.sendBatch({ ...batch, events: batch.events.slice(middle) });
      return first && second;
    }

    const config = this.config!;
    const fetchImpl = config.fetchImpl ?? fetch;
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}`
      + `/databases/(default)/documents/${COLLECTION}?key=${encodeURIComponent(config.apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal
      });
      if (response.status === 400 || response.status === 413) {
        // Lote malformado: tentar de novo não resolve. Demais erros (403 com
        // regras ainda não publicadas, 429 de cota) ficam na fila local.
        console.warn(`[whatsapp-webjs-bridge] telemetria rejeitada (${response.status}); lote descartado.`);
        return true;
      }
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async appendToQueue(batch: QueuedBatch): Promise<void> {
    const file = path.join(this.config!.queueDir, BRIDGE_QUEUE_FILE);
    try {
      const size = await fsp.stat(file).then(stat => stat.size).catch(() => 0);
      if (size > MAX_QUEUE_FILE_BYTES) {
        return;
      }
      await fsp.appendFile(file, `${JSON.stringify(batch)}\n`);
    } catch {
      // Fila offline indisponível.
    }
  }

  private async drainQueue(): Promise<void> {
    const file = path.join(this.config!.queueDir, BRIDGE_QUEUE_FILE);
    let content = '';
    try {
      content = await fsp.readFile(file, 'utf8');
    } catch {
      return;
    }

    const lines = content.split('\n').filter(Boolean);
    if (!lines.length) {
      return;
    }

    const toSend = lines.slice(0, MAX_QUEUED_BATCHES_PER_FLUSH);
    let sent = 0;
    for (const line of toSend) {
      let batch: QueuedBatch | null = null;
      try {
        batch = JSON.parse(line) as QueuedBatch;
      } catch {
        sent += 1;
        continue;
      }
      if (!batch || !Array.isArray(batch.events) || !(await this.sendBatch(batch))) {
        break;
      }
      sent += 1;
    }

    try {
      const remaining = lines.slice(sent);
      if (remaining.length) {
        await fsp.writeFile(file, `${remaining.join('\n')}\n`);
      } else {
        await fsp.unlink(file);
      }
    } catch {
      // Se não conseguiu reescrever, reenviar alguns lotes é aceitável.
    }
  }

  // O processo principal (Electron) grava seus eventos num arquivo; a bridge
  // os lê e envia junto. Assim eles sobrevivem até a uma queda da bridge.
  private async absorbMainProcessEvents(): Promise<void> {
    const file = path.join(this.config!.queueDir, MAIN_QUEUE_FILE);
    const claimed = `${file}.${process.pid}.sending`;
    try {
      await fsp.rename(file, claimed);
    } catch {
      return;
    }

    try {
      const content = await fsp.readFile(claimed, 'utf8');
      const events = content
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      this.trackExternal(events, 'main');
    } catch {
      // Arquivo ilegível: descarta.
    } finally {
      await fsp.unlink(claimed).catch(() => undefined);
    }
  }
}

export const telemetry = new Telemetry();

export function configureTelemetryFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const apiKey = env.TELEMETRY_FIREBASE_API_KEY || '';
  const projectId = env.TELEMETRY_FIREBASE_PROJECT_ID || '';
  const installId = env.TELEMETRY_INSTALL_ID || '';
  const queueDir = env.TELEMETRY_DIR || '';
  if (!apiKey || !projectId || !installId || !queueDir || env.TELEMETRY_DISABLED === '1') {
    return false;
  }

  telemetry.configure({
    apiKey,
    projectId,
    installId,
    sessionId: env.TELEMETRY_SESSION_ID || `bridge-${Date.now().toString(36)}`,
    appVersion: env.TELEMETRY_APP_VERSION || 'desconhecida',
    env: env.TELEMETRY_ENV || 'development',
    queueDir
  });
  return true;
}
