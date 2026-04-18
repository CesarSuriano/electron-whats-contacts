import type { Request, Response } from 'express';

export class HealthController {
  health = (_req: Request, res: Response): void => {
    res.json({ status: 'ok' });
  };
}
