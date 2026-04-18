import type { Request, Response } from 'express';
import { ContactsService } from '../whatsapp/ContactsService.js';
import { SessionState } from '../state/SessionState.js';

export class LabelsController {
  constructor(
    private readonly contactsService: ContactsService,
    private readonly sessionState: SessionState,
    private readonly instanceName: string
  ) {}

  list = async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!this.sessionState.isReady()) {
        res.json({ labels: [] });
        return;
      }

      const labels = await this.contactsService.loadLabels();
      res.json({ instanceName: this.instanceName, labels });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to load labels',
        details: (error as { message?: string } | null)?.message
      });
    }
  };
}
