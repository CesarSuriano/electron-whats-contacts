import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { HistoryService } from '../whatsapp/HistoryService.js';
import { MessageService } from '../whatsapp/MessageService.js';
import { EventStore } from '../state/EventStore.js';
import { SelfJidResolver } from '../whatsapp/SelfJidResolver.js';
import type { HistoryDiagnostics, RawMessage, WhatsappEvent } from '../domain/types.js';
import { isSameConversationJid, normalizeRequestedChatJid } from '../utils/jid.js';
import { normalizePhone } from '../utils/phone.js';
import { readMessageText, readMessageTimestampSeconds } from '../utils/message.js';

interface HistoryStage extends HistoryDiagnostics {
  chatId?: string;
  chatName?: string;
  resultCount?: number;
  fatalError?: string;
}

export class HistoryController {
  constructor(
    private readonly historyService: HistoryService,
    private readonly messageService: MessageService,
    private readonly eventStore: EventStore,
    private readonly selfJidResolver: SelfJidResolver,
    private readonly instanceName: string
  ) {}

  messages = async (req: Request, res: Response): Promise<void> => {
    const limit = Math.max(1, Math.min(300, Number(req.query.limit || 120)));
    const deep = this.readBooleanFlag(req.query.deep);
    const debug = this.readBooleanFlag(req.query.debug);

    await this.historyService.acquireHistorySlot();
    try {
      const notReady = this.messageService.requireReady();
      if (notReady) {
        res.status(409).json(notReady);
        return;
      }

      const requestedJid = normalizeRequestedChatJid(decodeURIComponent(req.params.jid || ''));
      if (!requestedJid) {
        res.status(400).json({ error: 'Invalid chat jid' });
        return;
      }

      const chats = await this.historyService.resolveChatsForHistory(requestedJid);
      if (!chats.length) {
        const fallbackEvents = this.readFallbackEventsForChat(requestedJid, limit);
        res.json({
          instanceName: this.instanceName,
          events: fallbackEvents,
          ...(debug
            ? {
              debug: {
                requestedJid,
                deep,
                limit,
                resolvedChats: [],
                stages: [],
                fallbackSource: 'event-store',
                fallbackCount: fallbackEvents.length
              }
            }
            : {})
        });
        return;
      }

      const chatsToLoad = deep ? chats.slice(0, 3) : chats.slice(0, 1);
      const history: RawMessage[] = [];
      const seenMessageIds = new Set<string>();
      const stages: HistoryStage[] = [];

      for (const chat of chatsToLoad) {
        const stage: HistoryStage | null = debug
          ? {
            chatId: chat?.id?._serialized || '',
            chatName: typeof chat?.name === 'string' ? chat.name : ''
          }
          : null;

        const partial = await this.historyService
          .fetchChatHistoryWithRecovery(chat, requestedJid, limit, stage)
          .catch(error => {
            if (stage) {
              stage.fatalError = (error as { message?: string } | null)?.message || String(error);
            }
            return [] as RawMessage[];
          });

        if (stage) {
          stage.resultCount = Array.isArray(partial) ? partial.length : 0;
          stages.push(stage);
        }

        (partial || []).forEach(message => {
          const serializedId = this.selfJidResolver.getSerializedMessageId(message);
          if (serializedId) {
            if (seenMessageIds.has(serializedId)) {
              return;
            }
            seenMessageIds.add(serializedId);
          }
          history.push(message);
        });
      }

      history.sort((a, b) => readMessageTimestampSeconds(a) - readMessageTimestampSeconds(b));
      if (history.length > limit) {
        history.splice(0, history.length - limit);
      }

      const filteredHistory = history.filter(message => this.messageService.shouldIncludeHistoryMessage(message));

      const eventsHistory: WhatsappEvent[] = (await Promise.all(filteredHistory.map(async message => {
        const inlineImageDataUrl = await this.messageService.resolveHistoryImageDataUrl(message);
        const mediaMimetypeFromData = typeof message?._data?.mimetype === 'string'
          ? message._data.mimetype.trim()
          : '';
        const mediaMimetypeFromInline = inlineImageDataUrl
          ? (inlineImageDataUrl.match(/^data:([^;,]+)/i)?.[1] || '')
          : '';
        const mediaMimetype = mediaMimetypeFromData || mediaMimetypeFromInline;
        const mediaFilename = typeof message?._data?.filename === 'string' ? message._data.filename : '';
        const timestamp = readMessageTimestampSeconds(message);
        const receivedAt = timestamp > 0
          ? new Date(timestamp * 1000).toISOString()
          : new Date().toISOString();
        const serializedId = this.selfJidResolver.getSerializedMessageId(message) || randomUUID();
        const hasMedia = Boolean(message.hasMedia) || Boolean(mediaMimetype) || Boolean(inlineImageDataUrl);
        const ack = typeof message.ack === 'number' ? message.ack : null;

        return {
          id: serializedId,
          source: 'webjs-chat-history',
          receivedAt,
          isFromMe: this.selfJidResolver.resolveIsFromMe(message),
          chatJid: requestedJid,
          phone: normalizePhone(requestedJid),
          text: readMessageText(message),
          ack,
          payload: {
            id: serializedId,
            timestamp,
            type: message.type || '',
            hasMedia,
            mediaMimetype,
            mediaFilename,
            mediaDataUrl: inlineImageDataUrl,
            ack
          }
        } satisfies WhatsappEvent;
      })))
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));

      res.json({
        instanceName: this.instanceName,
        events: eventsHistory,
        ...(debug
          ? {
            debug: {
              requestedJid,
              deep,
              limit,
              loadedChats: chatsToLoad.length,
              resolvedChats: chats.map(chat => ({
                id: chat?.id?._serialized || '',
                name: typeof chat?.name === 'string' ? chat.name : ''
              })),
              stages,
              totalMergedMessages: history.length,
              totalEvents: eventsHistory.length
            }
          }
          : {})
      });
    } catch (error) {
      const requestedJid = normalizeRequestedChatJid(decodeURIComponent(req.params.jid || ''));
      console.warn(
        '[whatsapp-webjs-bridge] fallback de historico por conversa:',
        requestedJid,
        '-',
        (error as { message?: string } | null)?.message || String(error)
      );
      res.json({
        instanceName: this.instanceName,
        events: this.readFallbackEventsForChat(requestedJid, Math.max(1, Math.min(300, Number(req.query.limit || 120))))
      });
    } finally {
      this.historyService.releaseHistorySlot();
    }
  };

  private readFallbackEventsForChat(requestedJid: string, limit: number): WhatsappEvent[] {
    return this.eventStore.events
      .filter(event => isSameConversationJid(event.chatJid, requestedJid))
      .slice(0, Math.max(1, Math.min(300, Number(limit || 120))))
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  private readBooleanFlag(value: unknown): boolean {
    const normalized = String(value || '').toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
}
