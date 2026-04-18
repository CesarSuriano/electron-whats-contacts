import type { Request, Response } from 'express';
import { MessageService } from '../whatsapp/MessageService.js';

export class MessagesController {
  constructor(
    private readonly messageService: MessageService,
    private readonly instanceName: string
  ) {}

  sendText = async (req: Request, res: Response): Promise<void> => {
    try {
      const notReady = this.messageService.requireReady();
      if (notReady) {
        res.status(409).json(notReady);
        return;
      }

      const to = typeof req.body?.to === 'string' ? req.body.to : '';
      const text = typeof req.body?.text === 'string' ? req.body.text : '';

      if (!to || !text) {
        res.status(400).json({ error: 'Fields "to" and "text" are required' });
        return;
      }

      const destination = this.messageService.validateDestination(to);
      if (!destination.ok) {
        res.status(400).json({ error: destination.error, details: destination.details });
        return;
      }

      const result = await this.messageService.sendText(destination.chatId, text);
      res.json({ instanceName: this.instanceName, result });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to send message',
        details: (error as { message?: string } | null)?.message
      });
    }
  };

  sendMedia = async (req: Request, res: Response): Promise<void> => {
    try {
      const notReady = this.messageService.requireReady();
      if (notReady) {
        res.status(409).json(notReady);
        return;
      }

      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        res.status(400).json({ error: 'Field "file" is required' });
        return;
      }

      const to = typeof req.body?.to === 'string' ? req.body.to : '';
      const caption = typeof req.body?.caption === 'string' ? req.body.caption : '';

      if (!to) {
        res.status(400).json({ error: 'Field "to" is required' });
        return;
      }

      const destination = this.messageService.validateDestination(to);
      if (!destination.ok) {
        res.status(400).json({ error: destination.error, details: destination.details });
        return;
      }

      const mimetype = file.mimetype || 'application/octet-stream';
      const filename = file.originalname || 'arquivo';
      const result = await this.messageService.sendMedia(
        destination.chatId,
        file.buffer,
        mimetype,
        filename,
        caption
      );

      res.json({ instanceName: this.instanceName, result });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to send media',
        details: (error as { message?: string } | null)?.message
      });
    }
  };
}
