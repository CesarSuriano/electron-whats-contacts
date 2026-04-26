import type { Client as WebJsClient } from 'whatsapp-web.js';
import type { InstanceSummary, SessionSnapshot, SessionStatus } from '../domain/types.js';
import { SessionState } from '../state/SessionState.js';
import { SelfJidResolver } from './SelfJidResolver.js';
import { wait, withTimeout } from '../utils/time.js';

const RETRYABLE_INIT_ERROR = /Execution context was destroyed|Target closed|Session closed/i;
const LOGOUT_OR_AUTH_TIMEOUT_ERROR = /LOGOUT|auth timeout|Authentication failure|Max qrcode retries reached/i;
const CLEANUP_TIMEOUT_MS = 10000;
const INIT_RETRY_DELAY_MS = 900;
const RECONNECT_CLEANUP_STATUSES = new Set<SessionStatus>(['disconnected', 'init_error', 'auth_failure', 'initializing']);

function isRetryableInitError(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null)?.message || '');
  return RETRYABLE_INIT_ERROR.test(message);
}

export class SessionManager {
  private initializePromise: Promise<void> | null = null;
  private manualDisconnectInProgress = false;
  private initGeneration = 0;

  constructor(
    private readonly client: WebJsClient,
    private readonly sessionState: SessionState,
    private readonly selfJidResolver: SelfJidResolver,
    private readonly instanceName: string
  ) {}

  getInstanceSummary(): InstanceSummary {
    const connected = this.sessionState.isReady();
    return {
      name: this.instanceName,
      token: 'local-session',
      connected,
      jid: connected ? this.selfJidResolver.getOwnJid() : '',
      webhook: ''
    };
  }

  getSessionSnapshot(): SessionSnapshot {
    return this.sessionState.snapshot();
  }

  isManualDisconnectInProgress(): boolean {
    return this.manualDisconnectInProgress;
  }

  private shouldClearAuth(previousStatus: SessionStatus, lastError: string, error: unknown): boolean {
    const errorMessage = String((error as { message?: unknown } | null)?.message || error || '');
    const combined = `${lastError}\n${errorMessage}`;
    return previousStatus === 'auth_failure' || LOGOUT_OR_AUTH_TIMEOUT_ERROR.test(combined);
  }

  private async cleanupBeforeInitialize(clearAuth = false): Promise<void> {
    if (clearAuth) {
      try {
        await withTimeout(this.client.logout(), CLEANUP_TIMEOUT_MS, 'logout during cleanup');
      } catch {}
    }

    try {
      await withTimeout(this.client.destroy(), CLEANUP_TIMEOUT_MS, 'destroy during cleanup');
    } catch {}
  }

  private async initializeWithRetry(previousStatus: SessionStatus, previousLastError: string, generation: number, maxAttempts = 2): Promise<void> {
    let attempt = 1;
    let retryableFailure: unknown = null;

    while (attempt <= maxAttempts) {
      if (generation !== this.initGeneration) {
        return;
      }

      try {
        if (attempt > 1 || RECONNECT_CLEANUP_STATUSES.has(previousStatus)) {
          await this.cleanupBeforeInitialize(this.shouldClearAuth(previousStatus, previousLastError, retryableFailure));
        }

        await this.client.initialize();
        return;
      } catch (error) {
        if (generation !== this.initGeneration) {
          return;
        }
        const canRetry = attempt < maxAttempts && isRetryableInitError(error);
        if (!canRetry) {
          throw error;
        }
        retryableFailure = error;
        await wait(INIT_RETRY_DELAY_MS * attempt);
        attempt += 1;
      }
    }
  }

  async ensureInitialized(): Promise<void> {
    if (this.initializePromise) {
      return this.initializePromise;
    }

    const previousStatus = this.sessionState.status;
    const previousLastError = this.sessionState.lastError;
    const generation = ++this.initGeneration;
    this.sessionState.status = 'initializing';
    this.sessionState.qr = null;
    this.sessionState.lastError = '';

    this.initializePromise = this.initializeWithRetry(previousStatus, previousLastError, generation)
      .catch(error => {
        if (generation !== this.initGeneration) {
          return;
        }
        this.sessionState.status = 'init_error';
        this.sessionState.lastError = (error as { message?: string } | null)?.message || 'Falha ao inicializar cliente';
        throw error;
      })
      .finally(() => {
        if (generation === this.initGeneration) {
          this.initializePromise = null;
        }
      });

    return this.initializePromise;
  }

  async disconnect(): Promise<void> {
    this.initGeneration++;
    this.initializePromise = null;
    this.manualDisconnectInProgress = true;

    try {
      try {
        await withTimeout(this.client.logout(), CLEANUP_TIMEOUT_MS, 'logout during disconnect');
      } catch (error) {
        console.warn('[whatsapp-webjs-bridge] logout falhou:', (error as { message?: string } | null)?.message || String(error));
      }

      try {
        await withTimeout(this.client.destroy(), CLEANUP_TIMEOUT_MS, 'destroy during disconnect');
      } catch (error) {
        console.warn('[whatsapp-webjs-bridge] destroy falhou:', (error as { message?: string } | null)?.message || String(error));
      }

      this.sessionState.status = 'disconnected';
      this.sessionState.qr = null;
      this.sessionState.lastError = '';
    } finally {
      this.manualDisconnectInProgress = false;
    }
  }
}
