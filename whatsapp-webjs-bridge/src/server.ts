import dotenv from 'dotenv';
import type { Container } from './container.js';
import { loadConfigFromEnv } from './config.js';
import { bindClientEvents, buildContainer } from './container.js';
import { createApp } from './app.js';
import {
  getErrorMessage,
  isRecoverableInitError,
  isRecoverableLocalAuthLockError,
  isRecoverableProcessError
} from './whatsapp/RecoverableErrors.js';

dotenv.config();

const RECOVER_INIT_DELAY_MS = 1200;

function stopAutoRecoveryWithBudgetError(container: Container, origin: string, error: unknown): void {
  const attempts = container.recoveryBudget.attemptsInWindow;
  const maxAttempts = container.recoveryBudget.maxAttemptsAllowed;

  container.sessionState.status = 'init_error';
  container.sessionState.qr = null;
  container.sessionState.lastError = `Sessao do WhatsApp nao respondeu apos ${attempts}/${maxAttempts} tentativas automaticas. Clique em "Tentar novamente" para reiniciar a conexao.`;

  console.error(
    `[whatsapp-webjs-bridge] Limite de auto-recuperacao excedido (${origin}, ${attempts}/${maxAttempts}):`,
    getErrorMessage(error)
  );
  container.broadcaster.broadcast('session_state', container.sessionManager.getSessionSnapshot());
}

function tryConsumeRecoveryBudget(container: Container, origin: string, error: unknown): boolean {
  if (container.recoveryBudget.tryConsume()) {
    return true;
  }

  stopAutoRecoveryWithBudgetError(container, origin, error);
  return false;
}

function installProcessGuards(container: Container): void {
  let recoverTimer: NodeJS.Timeout | null = null;

  const scheduleRecovery = (origin: 'uncaughtException' | 'unhandledRejection', error: unknown): void => {
    if (!isRecoverableProcessError(error)) {
      const message = getErrorMessage(error);
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

    if (isRecoverableLocalAuthLockError(error)) {
      console.warn('[whatsapp-webjs-bridge] Ignorando erro recuperavel de lock no LocalAuth. Tentando recuperar sessao...');
      container.sessionState.lastError = 'Sessao desconectada. Tentando recuperar sessao salva...';
    } else {
      console.warn('[whatsapp-webjs-bridge] Ignorando erro recuperavel de contexto do WhatsApp Web. Tentando restaurar sessao...');
      container.sessionState.lastError = 'Contexto do WhatsApp Web reiniciado. Tentando restaurar sessao...';
    }

    container.broadcaster.broadcast('session_state', container.sessionManager.getSessionSnapshot());

    if (recoverTimer) {
      return;
    }

    if (!tryConsumeRecoveryBudget(container, `process:${origin}`, error)) {
      return;
    }

    const attempt = container.recoveryBudget.attemptsInWindow;
    const maxAttempts = container.recoveryBudget.maxAttemptsAllowed;
    container.sessionState.lastError = isRecoverableLocalAuthLockError(error)
      ? `Sessao desconectada. Tentando recuperar sessao salva (${attempt}/${maxAttempts})...`
      : `Contexto do WhatsApp Web reiniciado. Tentando restaurar sessao (${attempt}/${maxAttempts})...`;
    container.broadcaster.broadcast('session_state', container.sessionManager.getSessionSnapshot());

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
  let startupRecoveryTimer: NodeJS.Timeout | null = null;
  bindClientEvents(container);
  installProcessGuards(container);

  const stopRecoveringAndFail = (error: unknown, reason: string): void => {
    container.sessionState.status = 'init_error';
    container.sessionState.qr = null;
    container.sessionState.lastError = (error as { message?: string } | null)?.message
      || String(error)
      || reason;
    console.error(
      `[whatsapp-webjs-bridge] ${reason}:`,
      (error as { message?: string } | null)?.message || String(error)
    );
    container.broadcaster.broadcast('session_state', container.sessionManager.getSessionSnapshot());
  };

  const scheduleStartupRecovery = (error: unknown): void => {
    if (!isRecoverableInitError(error) || startupRecoveryTimer) {
      return;
    }

    if (!tryConsumeRecoveryBudget(container, 'startup', error)) {
      return;
    }

    const attempt = container.recoveryBudget.attemptsInWindow;
    const maxAttempts = container.recoveryBudget.maxAttemptsAllowed;
    console.warn(
      `[whatsapp-webjs-bridge] Inicializacao transitoria falhou (tentativa ${attempt}/${maxAttempts}). Tentando novamente...`
    );
    container.sessionState.status = 'initializing';
    container.sessionState.qr = null;
    container.sessionState.lastError = `Sessao demorou para responder. Tentando novamente (${attempt}/${maxAttempts})...`;
    container.broadcaster.broadcast('session_state', container.sessionManager.getSessionSnapshot());

    startupRecoveryTimer = setTimeout(() => {
      startupRecoveryTimer = null;

      if (container.sessionManager.isManualDisconnectInProgress()) {
        return;
      }

      if (container.sessionState.status === 'ready' || container.sessionState.status === 'authenticated' || container.sessionState.status === 'qr_required') {
        return;
      }

      container.sessionState.status = 'initializing';
      container.sessionState.qr = null;
      container.sessionState.lastError = '';
      container.broadcaster.broadcast('session_state', container.sessionManager.getSessionSnapshot());

      container.sessionManager.ensureInitialized()
        .catch(initError => {
          if (isRecoverableInitError(initError)) {
            scheduleStartupRecovery(initError);
            return;
          }
          stopRecoveringAndFail(initError, 'Falha ao recuperar inicializacao com erro não-recuperável');
        });
    }, RECOVER_INIT_DELAY_MS);
  };

  const app = createApp(container);

  const httpServer = app.listen(config.port, async () => {
    console.log(`[whatsapp-webjs-bridge] listening on http://localhost:${config.port}`);

    container.broadcaster.attach(httpServer, { allowedOrigins: config.allowedOrigins });
    console.log('[whatsapp-webjs-bridge] WebSocket server attached.');

    try {
      await container.sessionManager.ensureInitialized();
    } catch (error) {
      if (isRecoverableInitError(error)) {
        scheduleStartupRecovery(error);
        return;
      }

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
