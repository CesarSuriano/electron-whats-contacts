import type { Request, Response } from 'express';
import { ContactsService } from '../whatsapp/ContactsService.js';
import { ContactStore } from '../state/ContactStore.js';
import { MessageService } from '../whatsapp/MessageService.js';
import { normalizeJid } from '../utils/jid.js';

export class ContactsController {
  constructor(
    private readonly contactsService: ContactsService,
    private readonly contactStore: ContactStore,
    private readonly messageService: MessageService,
    private readonly instanceName: string
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    try {
      const waitForRefreshRaw = String(req.query.waitForRefresh || '').toLowerCase();
      const waitForRefresh = waitForRefreshRaw === '1'
        || waitForRefreshRaw === 'true'
        || waitForRefreshRaw === 'yes';

      await this.contactsService.waitForContactsWarmup(waitForRefresh);

      res.json({
        instanceName: this.instanceName,
        contacts: this.contactStore.values()
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to load contacts',
        details: (error as { message?: string } | null)?.message
      });
    }
  };

  photo = async (req: Request, res: Response): Promise<void> => {
    try {
      const jid = normalizeJid(req.params.jid || '');
      if (!jid) {
        res.status(400).json({ error: 'Invalid jid' });
        return;
      }

      const photoUrl = await this.contactsService.fetchProfilePhotoUrl(jid);
      res.json({ jid, photoUrl });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to load photo',
        details: (error as { message?: string } | null)?.message
      });
    }
  };

  markSeen = async (req: Request, res: Response): Promise<void> => {
    try {
      const notReady = this.messageService.requireReady();
      if (notReady) {
        res.status(409).json(notReady);
        return;
      }

      const jid = normalizeJid(decodeURIComponent(req.params.jid || ''));
      if (!jid) {
        res.status(400).json({ error: 'Invalid jid' });
        return;
      }

      await this.messageService.markAsSeen(jid);
      res.json({ jid, ok: true });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to mark as seen',
        details: (error as { message?: string } | null)?.message
      });
    }
  };
}
