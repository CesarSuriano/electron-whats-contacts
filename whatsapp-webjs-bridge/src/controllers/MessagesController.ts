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

  replyMessage = async (req: Request, res: Response): Promise<void> => {
    try {
      const notReady = this.messageService.requireReady();
      if (notReady) {
        res.status(409).json(notReady);
        return;
      }

      const to = typeof req.body?.to === 'string' ? req.body.to : '';
      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      const quotedMessageId = typeof req.body?.quotedMessageId === 'string' ? req.body.quotedMessageId : '';

      if (!to || !text || !quotedMessageId) {
        res.status(400).json({ error: 'Fields "to", "text" and "quotedMessageId" are required' });
        return;
      }

      const destination = this.messageService.validateDestination(to);
      if (!destination.ok) {
        res.status(400).json({ error: destination.error, details: destination.details });
        return;
      }

      const result = await this.messageService.sendReply(destination.chatId, text, quotedMessageId);
      res.json({ instanceName: this.instanceName, result });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to send reply',
        details: (error as { message?: string } | null)?.message
      });
    }
  };

  deleteMessage = async (req: Request, res: Response): Promise<void> => {
    try {
      const notReady = this.messageService.requireReady();
      if (notReady) {
        res.status(409).json(notReady);
        return;
      }

      const messageId = typeof req.params?.messageId === 'string' ? decodeURIComponent(req.params.messageId) : '';
      if (!messageId) {
        res.status(400).json({ error: 'Param "messageId" is required' });
        return;
      }

      const everyoneParam = String(req.query?.everyone ?? 'true').toLowerCase();
      const deleteForEveryone = everyoneParam !== 'false' && everyoneParam !== '0';

      await this.messageService.deleteMessage(messageId, deleteForEveryone);
      res.json({ instanceName: this.instanceName, ok: true });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to delete message',
        details: (error as { message?: string } | null)?.message
      });
    }
  };

  forwardMessage = async (req: Request, res: Response): Promise<void> => {
    try {
      const notReady = this.messageService.requireReady();
      if (notReady) {
        res.status(409).json(notReady);
        return;
      }

      const to = typeof req.body?.to === 'string' ? req.body.to : '';
      const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId : '';

      if (!to || !messageId) {
        res.status(400).json({ error: 'Fields "to" and "messageId" are required' });
        return;
      }

      const destination = this.messageService.validateDestination(to);
      if (!destination.ok) {
        res.status(400).json({ error: destination.error, details: destination.details });
        return;
      }

      await this.messageService.forwardMessage(destination.chatId, messageId);
      res.json({ instanceName: this.instanceName, ok: true });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to forward message',
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
