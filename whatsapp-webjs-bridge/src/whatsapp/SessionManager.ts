import type { Client as WebJsClient } from 'whatsapp-web.js';
import type { InstanceSummary, SessionSnapshot } from '../domain/types.js';
import { SessionState } from '../state/SessionState.js';
import { SelfJidResolver } from './SelfJidResolver.js';
import { wait } from '../utils/time.js';

const RETRYABLE_INIT_ERROR = /Execution context was destroyed|Target closed|Session closed/i;
const INIT_RETRY_DELAY_MS = 900;

function isRetryableInitError(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null)?.message || '');
  return RETRYABLE_INIT_ERROR.test(message);
}

export class SessionManager {
  private initializePromise: Promise<void> | null = null;
  private manualDisconnectInProgress = false;

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

  private async initializeWithRetry(maxAttempts = 2): Promise<void> {
    let attempt = 1;
    while (attempt <= maxAttempts) {
      try {
        await this.client.initialize();
        return;
      } catch (error) {
        const canRetry = attempt < maxAttempts && isRetryableInitError(error);
        if (!canRetry) {
          throw error;
        }
        await wait(INIT_RETRY_DELAY_MS * attempt);
        attempt += 1;
      }
    }
  }

  async ensureInitialized(): Promise<void> {
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.sessionState.status = 'initializing';
    this.sessionState.lastError = '';

    this.initializePromise = this.initializeWithRetry()
      .catch(error => {
        this.sessionState.status = 'init_error';
        this.sessionState.lastError = (error as { message?: string } | null)?.message || 'Falha ao inicializar cliente';
        throw error;
      })
      .finally(() => {
        this.initializePromise = null;
      });

    return this.initializePromise;
  }

  async disconnect(): Promise<void> {
    this.initializePromise = null;
    this.manualDisconnectInProgress = true;

    try {
      try {
        await this.client.logout();
      } catch (error) {
        console.warn('[whatsapp-webjs-bridge] logout falhou:', (error as { message?: string } | null)?.message || String(error));
      }

      try {
        await this.client.destroy();
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
