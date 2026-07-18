import type { Request, Response } from 'express';
import { SessionManager } from '../whatsapp/SessionManager.js';
import { SessionState } from '../state/SessionState.js';
import { RecoveryBudget } from '../whatsapp/RecoveryBudget.js';

export class SessionController {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly sessionState: SessionState,
    private readonly recoveryBudget: RecoveryBudget
  ) {}

  getSession = (_req: Request, res: Response): void => {
    res.json(this.sessionManager.getSessionSnapshot());
  };

  connect = async (_req: Request, res: Response): Promise<void> => {
    try {
      this.recoveryBudget.reset();

      const status = this.sessionState.status;
      if (status === 'ready' || status === 'authenticated' || status === 'qr_required') {
        res.json(this.sessionManager.getSessionSnapshot());
        return;
      }

      await this.sessionManager.ensureInitialized();
      res.json(this.sessionManager.getSessionSnapshot());
    } catch (error) {
      res.status(500).json({
        error: 'Failed to connect session',
        details: (error as { message?: string } | null)?.message
      });
    }
  };

  restart = async (_req: Request, res: Response): Promise<void> => {
    try {
      this.recoveryBudget.reset();
      await this.sessionManager.prepareRestart();
      void this.sessionManager.ensureInitialized().catch(error => {
        console.error(
          '[whatsapp-webjs-bridge] Falha ao reiniciar sessao para novo QR:',
          (error as { message?: string } | null)?.message || String(error)
        );
      });
      res.json(this.sessionManager.getSessionSnapshot());
    } catch (error) {
      res.status(500).json({
        error: 'Failed to restart session',
        details: (error as { message?: string } | null)?.message
      });
    }
  };

  disconnect = async (_req: Request, res: Response): Promise<void> => {
    try {
      await this.sessionManager.disconnect();
      res.json(this.sessionManager.getSessionSnapshot());
    } catch (error) {
      res.status(500).json({
        error: 'Failed to disconnect session',
        details: (error as { message?: string } | null)?.message
      });
    }
  };

  getInstances = (_req: Request, res: Response): void => {
    res.json({
      instances: [this.sessionManager.getInstanceSummary()]
    });
  };
}
