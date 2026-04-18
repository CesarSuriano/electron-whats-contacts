import type { Request, Response } from 'express';
import { EventStore } from '../state/EventStore.js';
import { HistoryService } from '../whatsapp/HistoryService.js';
import { IngestionService } from '../whatsapp/IngestionService.js';
import type { WhatsappEvent } from '../domain/types.js';

export class EventsController {
  constructor(
    private readonly eventStore: EventStore,
    private readonly historyService: HistoryService,
    private readonly ingestionService: IngestionService,
    private readonly instanceName: string,
    private readonly options: { enableHistoryEvents: boolean }
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));

    try {
      if (this.eventStore.events.length === 0) {
        await this.ingestionService.seedEventsFromRecentChats();
      }

      const historyEvents = this.options.enableHistoryEvents
        ? await this.historyService.loadRecentChatEvents(limit)
        : [];

      const merged = new Map<string, WhatsappEvent>();
      [...this.eventStore.events, ...historyEvents].forEach(event => {
        if (!merged.has(event.id)) {
          merged.set(event.id, event);
        }
      });

      const sorted = Array.from(merged.values())
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
        .slice(0, limit);

      res.json({
        instanceName: this.instanceName,
        events: sorted
      });
    } catch {
      res.json({
        instanceName: this.instanceName,
        events: this.eventStore.snapshot(limit)
      });
    }
  };
}
