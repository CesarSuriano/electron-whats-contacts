import dotenv from 'dotenv';
import { loadConfigFromEnv } from './config.js';
import { bindClientEvents, buildContainer } from './container.js';
import { createApp } from './app.js';

dotenv.config();

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const container = buildContainer(config);
  bindClientEvents(container);

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
