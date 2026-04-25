import dotenv from 'dotenv';
import type { Container } from './container.js';
import { loadConfigFromEnv } from './config.js';
import { bindClientEvents, buildContainer } from './container.js';
import { createApp } from './app.js';

dotenv.config();

const LOCAL_AUTH_LOCK_ERROR = /EBUSY: resource busy or locked/i;
const LOCAL_AUTH_LOGOUT_PATH = /LocalAuth\.js|first_party_sets\.db-journal/i;
const RECOVER_INIT_DELAY_MS = 1200;

function isRecoverableLocalAuthLockError(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null)?.message || '');
  const stack = String((error as { stack?: unknown } | null)?.stack || '');
  const combined = `${message}\n${stack}`;
  return LOCAL_AUTH_LOCK_ERROR.test(combined) && LOCAL_AUTH_LOGOUT_PATH.test(combined);
}

function installProcessGuards(container: Container): void {
  let recoverTimer: NodeJS.Timeout | null = null;

  const scheduleRecovery = (origin: 'uncaughtException' | 'unhandledRejection', error: unknown): void => {
    if (!isRecoverableLocalAuthLockError(error)) {
      const message = String((error as { message?: unknown } | null)?.message || error);
      if (origin === 'unhandledRejection') {
        console.error('[whatsapp-webjs-bridge] Rejeicao nao tratada:', message);
      } else {
        console.error('[whatsapp-webjs-bridge] Excecao nao tratada:', message);
      }
      process.exit(1);
      return;
    }

    container.sessionState.status = 'disconnected';
    container.sessionState.qr = null;

    if (container.sessionManager.isManualDisconnectInProgress()) {
      container.sessionState.lastError = '';
      console.warn('[whatsapp-webjs-bridge] Ignorando lock recuperavel do LocalAuth durante desconexao manual.');
      container.broadcaster.broadcast('session_state', container.sessionManager.getSessionSnapshot());
      return;
    }

    console.warn('[whatsapp-webjs-bridge] Ignorando erro recuperavel de lock no LocalAuth. Tentando recuperar sessao...');
    container.sessionState.lastError = 'Sessao desconectada. Gerando novo QR code...';
    container.broadcaster.broadcast('session_state', container.sessionManager.getSessionSnapshot());

    if (recoverTimer) {
      return;
    }

    recoverTimer = setTimeout(() => {
      recoverTimer = null;
      container.sessionManager.ensureInitialized().catch(initError => {
        container.sessionState.status = 'init_error';
        container.sessionState.lastError = (initError as { message?: string } | null)?.message || String(initError);
        console.error(
          '[whatsapp-webjs-bridge] Falha ao recuperar sessao apos erro de lock:',
          (initError as { message?: string } | null)?.message || String(initError)
        );
        container.broadcaster.broadcast('session_state', container.sessionManager.getSessionSnapshot());
      });
    }, RECOVER_INIT_DELAY_MS);
  };

  process.on('uncaughtException', error => {
    scheduleRecovery('uncaughtException', error);
  });

  process.on('unhandledRejection', reason => {
    scheduleRecovery('unhandledRejection', reason);
  });
}

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const container = buildContainer(config);
  bindClientEvents(container);
  installProcessGuards(container);

  const app = createApp(container);

  const httpServer = app.listen(config.port, async () => {
    console.log(`[whatsapp-webjs-bridge] listening on http://localhost:${config.port}`);

    container.broadcaster.attach(httpServer, { allowedOrigins: config.allowedOrigins });
    console.log('[whatsapp-webjs-bridge] WebSocket server attached.');

    try {
      await container.sessionManager.ensureInitialized();
    } catch (error) {
      container.sessionState.status = 'init_error';
      container.sessionState.lastError = (error as { message?: string } | null)?.message || String(error);
      console.error(
        '[whatsapp-webjs-bridge] Falha ao inicializar cliente:',
        (error as { message?: string } | null)?.message || String(error)
      );
    }
  });

  httpServer.on('error', (error: NodeJS.ErrnoException) => {
    if (error?.code === 'EADDRINUSE') {
      console.warn(`[whatsapp-webjs-bridge] porta ${config.port} ja esta em uso. Usando instancia existente.`);
      process.exit(0);
      return;
    }

    console.error('[whatsapp-webjs-bridge] erro no servidor HTTP:', error.message);
    process.exit(1);
  });
}

main().catch(error => {
  console.error('[whatsapp-webjs-bridge] Erro fatal:', error);
  process.exit(1);
});
