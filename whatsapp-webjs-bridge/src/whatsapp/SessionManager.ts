import type { Client as WebJsClient } from 'whatsapp-web.js';
import type { InstanceSummary, SessionSnapshot, SessionStatus } from '../domain/types.js';
import { SessionState } from '../state/SessionState.js';
import { SelfJidResolver } from './SelfJidResolver.js';
import { isRecoverableInitError } from './RecoverableErrors.js';
import { wait, withTimeout } from '../utils/time.js';
import { telemetry } from '../telemetry/Telemetry.js';

const CLEANUP_TIMEOUT_MS = 10000;
const INIT_RETRY_DELAY_MS = 900;
const RECONNECT_CLEANUP_STATUSES = new Set<SessionStatus>(['disconnected', 'init_error', 'auth_failure', 'initializing']);

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

  isInitializeInFlight(): boolean {
    return this.initializePromise !== null;
  }

  private async cleanupBeforeInitialize(): Promise<void> {
    const startedAt = Date.now();
    try {
      await withTimeout(this.client.destroy(), CLEANUP_TIMEOUT_MS, 'destroy during cleanup');
      telemetry.track('session.cleanup', { ms: Date.now() - startedAt, ok: true });
    } catch (error) {
      telemetry.trackError('session.cleanup', error, { ms: Date.now() - startedAt, ok: false });
    }
  }

  private async initializeWithRetry(previousStatus: SessionStatus, generation: number, maxAttempts = 2): Promise<void> {
    let attempt = 1;

    while (attempt <= maxAttempts) {
      if (generation !== this.initGeneration) {
        return;
      }

      try {
        if (attempt > 1 || RECONNECT_CLEANUP_STATUSES.has(previousStatus)) {
          await this.cleanupBeforeInitialize();
        }

        const startedAt = Date.now();
        telemetry.track('session.initialize_start', { attempt, previousStatus });
        await this.client.initialize();
        telemetry.track('session.initialize_done', { attempt, ms: Date.now() - startedAt });
        return;
      } catch (error) {
        if (generation !== this.initGeneration) {
          return;
        }
        const canRetry = attempt < maxAttempts && isRecoverableInitError(error);
        telemetry.trackError('session.initialize_failed', error, { attempt, willRetry: canRetry });
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

    const previousStatus = this.sessionState.status;
    const generation = ++this.initGeneration;
    this.sessionState.status = 'initializing';
    this.sessionState.qr = null;
    this.sessionState.lastError = '';

    this.initializePromise = this.initializeWithRetry(previousStatus, generation)
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

  async prepareRestart(): Promise<void> {
    telemetry.track('session.restart_requested', { status: this.sessionState.status });
    this.initGeneration++;
    this.initializePromise = null;
    this.manualDisconnectInProgress = true;
    try {
      await this.cleanupBeforeInitialize();
      // O usuário pediu um QR novo: a sessão local salva não interessa mais.
      // Sem credenciais, o initialize pula a restauração e vai direto ao QR.
      const authStrategy = (this.client as { authStrategy?: { logout?: () => Promise<void> } }).authStrategy;
      if (authStrategy?.logout) {
        try {
          await withTimeout(authStrategy.logout(), CLEANUP_TIMEOUT_MS, 'local auth wipe during restart');
        } catch (error) {
          console.warn(
            '[whatsapp-webjs-bridge] Falha ao limpar sessao local no restart (seguindo mesmo assim):',
            (error as { message?: string } | null)?.message || String(error)
          );
        }
      }
    } finally {
      this.manualDisconnectInProgress = false;
    }
  }

  async disconnect(): Promise<void> {
    // Loga loud para diagnóstico: client.logout() é o ÚNICO caminho que
    // remove o LinkedDevice da conta WhatsApp do usuário no servidor (efeito:
    // celular oficial também aparece "deslogado"). Se você está investigando
    // um logout fantasma, procure essa mensagem no log: ela só aparece quando
    // o front bate explicitamente em POST /api/whatsapp/session/disconnect.
    console.warn(
      '[whatsapp-webjs-bridge] SessionManager.disconnect() chamado — esse é o único '
      + 'caminho do bridge que dispara client.logout() e remove o device da conta. '
      + 'Stack:\n' + (new Error('logout-trace').stack || '')
    );

    telemetry.track('session.manual_logout', { status: this.sessionState.status });
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
