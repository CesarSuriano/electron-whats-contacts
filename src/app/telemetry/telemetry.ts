// Telemetria da tela: eventos pequenos (tempos, estados, erros) enviados em
// lote para a bridge, que sanitiza e grava no Firestore. track() só empurra
// para um buffer; o envio acontece a cada poucos segundos e nunca bloqueia a
// interface. Não registrar texto de mensagem, telefone, nome ou imagem.

export type TelemetryValue = string | number | boolean | null;
export type TelemetryData = Record<string, TelemetryValue | undefined>;

interface RendererTelemetryEvent {
  name: string;
  ts: string;
  data: Record<string, TelemetryValue>;
}

const BRIDGE_TELEMETRY_URL = 'http://localhost:3344/api/telemetry';
const FLUSH_INTERVAL_MS = 10_000;
const FLUSH_AT_EVENTS = 40;
const MAX_EVENTS_PER_REQUEST = 150;
const MAX_BUFFERED_EVENTS = 600;
const MAX_STRING_LENGTH = 300;

// Timers e envios rodam fora da zona do Angular: se rodassem dentro, cada
// ciclo dispararia uma verificação de mudanças na tela inteira.
function runOutsideAngular(task: () => void): void {
  const rootZone = (globalThis as { Zone?: { root?: { run: (fn: () => void) => void } } }).Zone?.root;
  if (rootZone) {
    rootZone.run(task);
    return;
  }
  task();
}

function isUnitTestEnvironment(): boolean {
  const globalScope = globalThis as { __karma__?: unknown; jasmine?: unknown };
  return typeof globalScope.__karma__ !== 'undefined' || typeof globalScope.jasmine !== 'undefined';
}

function cleanData(data: TelemetryData | undefined): Record<string, TelemetryValue> {
  const result: Record<string, TelemetryValue> = {};
  if (!data) {
    return result;
  }

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === 'number') {
      if (Number.isFinite(value)) {
        result[key] = Math.round(value * 100) / 100;
      }
      continue;
    }
    result[key] = typeof value === 'string' ? value.slice(0, MAX_STRING_LENGTH) : value;
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

class RendererTelemetry {
  private readonly enabled = !isUnitTestEnvironment() && typeof window !== 'undefined' && typeof fetch === 'function';
  private buffer: RendererTelemetryEvent[] = [];
  private sending = false;

  constructor() {
    if (!this.enabled) {
      return;
    }

    runOutsideAngular(() => {
      window.setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
      window.addEventListener('pagehide', () => this.flushOnExit());
      window.addEventListener('unhandledrejection', event => {
        this.trackError('error.ui_unhandled_rejection', event.reason);
      });
    });
  }

  track(name: string, data?: TelemetryData): void {
    if (!this.enabled) {
      return;
    }

    try {
      this.buffer.push({ name, ts: new Date().toISOString(), data: cleanData(data) });
      if (this.buffer.length > MAX_BUFFERED_EVENTS) {
        this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_EVENTS);
      }
      if (this.buffer.length >= FLUSH_AT_EVENTS) {
        runOutsideAngular(() => void this.flush());
      }
    } catch {
      // Telemetria nunca pode quebrar a tela.
    }
  }

  trackError(name: string, error: unknown, data?: TelemetryData): void {
    this.track(name, {
      ...data,
      message: errorMessageOf(error),
      errorName: error instanceof Error ? error.name : typeof error
    });
  }

  private async flush(): Promise<void> {
    if (this.sending || !this.buffer.length) {
      return;
    }

    this.sending = true;
    const batch = this.buffer.splice(0, MAX_EVENTS_PER_REQUEST);
    try {
      const response = await fetch(BRIDGE_TELEMETRY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: batch })
      });
      if (!response.ok) {
        this.requeue(batch);
      }
    } catch {
      // Bridge ainda subindo ou reiniciando: tenta de novo no próximo ciclo.
      this.requeue(batch);
    } finally {
      this.sending = false;
    }
  }

  private requeue(batch: RendererTelemetryEvent[]): void {
    this.buffer = [...batch, ...this.buffer].slice(-MAX_BUFFERED_EVENTS);
  }

  private flushOnExit(): void {
    if (!this.buffer.length || typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
      return;
    }

    try {
      const batch = this.buffer.splice(0, MAX_EVENTS_PER_REQUEST);
      // text/plain: o sendBeacon não faz a verificação de CORS que JSON exigiria.
      navigator.sendBeacon(BRIDGE_TELEMETRY_URL, new Blob([JSON.stringify({ events: batch })], { type: 'text/plain' }));
    } catch {
      // Sem envio na saída.
    }
  }
}

export const telemetry = new RendererTelemetry();
