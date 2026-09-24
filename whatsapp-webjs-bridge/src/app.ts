import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import type { Container } from './container.js';
import { buildRoutes } from './routes.js';
import { telemetry } from './telemetry/Telemetry.js';

export function createApp(container: Container): Express {
  const app = express();
  const { allowedOrigins } = container.config;

  const isOriginAllowed = (origin: string | undefined): boolean => {
    if (!origin || origin === 'null') {
      return true;
    }
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return true;
    }
    if (origin.startsWith('file://') && allowedOrigins.includes('file://')) {
      return true;
    }
    return false;
  };

  app.use((req, res, next) => {
    if (!isOriginAllowed(req.headers.origin as string | undefined)) {
      res.status(403).json({
        error: 'Forbidden',
        details: `Origin ${req.headers.origin} is not allowed by CORS`
      });
      return;
    }
    next();
  });

  app.use(cors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    }
  }));

  app.use(express.json({ limit: '2mb' }));

  // Tempo e status de cada requisição. Registra o padrão da rota
  // (ex.: /chats/:jid/messages), nunca o endereço com o número.
  app.use((req, res, next) => {
    if (!telemetry.isEnabled() || req.path === '/api/health' || req.path === '/api/telemetry') {
      next();
      return;
    }

    const startedAt = Date.now();
    res.on('finish', () => {
      const route = req.route?.path ? `${req.baseUrl || ''}${String(req.route.path)}` : 'unmatched';
      telemetry.track('http.request', {
        method: req.method,
        route,
        status: res.statusCode,
        ms: Date.now() - startedAt
      });
    });
    next();
  });

  app.use(buildRoutes(container));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'Arquivo excede o limite de 50MB' });
      return;
    }

    telemetry.trackError('error.http_unexpected', err);
    res.status(500).json({
      error: 'Unexpected error',
      details: (err as { message?: string } | null)?.message
    });
  });

  return app;
}
