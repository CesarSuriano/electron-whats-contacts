import pkg from 'whatsapp-web.js';
import type { Client as WebJsClient, Message } from 'whatsapp-web.js';
import type { RawMessage } from '../domain/types.js';
import { SessionState } from '../state/SessionState.js';
import { EventStore } from '../state/EventStore.js';
import { ContactStore } from '../state/ContactStore.js';
import { SelfJidResolver } from './SelfJidResolver.js';
import { isGroupJid, isValidPersonalJid, normalizeJid } from '../utils/jid.js';
import { toIsoFromUnixTimestamp, withTimeout } from '../utils/time.js';
import { readMessageInlineImageDataUrl } from '../utils/media.js';
import { isIgnoredWhatsappMessage } from '../utils/message.js';

const { MessageMedia } = pkg;

export interface SendTextResult {
  id: string;
  to: string;
  timestamp: number;
}

export interface SendMediaResult extends SendTextResult {}

export interface ValidatedDestination {
  ok: true;
  chatId: string;
}

export interface DestinationError {
  ok: false;
  error: string;
  details?: string;
}

export type DestinationValidation = ValidatedDestination | DestinationError;

type WebJsClientWithMessaging = WebJsClient & {
  sendMessage: (chatId: string, content: string | InstanceType<typeof MessageMedia>, options?: Record<string, unknown>) => Promise<Message>;
  getMessageById: (id: string) => Promise<Message | null | undefined>;
  getChatById: (id: string) => Promise<{ sendSeen?: () => Promise<unknown> } | null | undefined>;
};

export class MessageService {
  constructor(
    private readonly client: WebJsClient,
    private readonly sessionState: SessionState,
    private readonly eventStore: EventStore,
    private readonly contactStore: ContactStore,
    private readonly selfJidResolver: SelfJidResolver
  ) {}

  requireReady(): DestinationError | null {
    if (!this.sessionState.isReady()) {
      return { ok: false, error: 'WhatsApp session is not ready yet' };
    }
    return null;
  }

  validateDestination(to: string): DestinationValidation {
    const chatId = normalizeJid(to);
    if (!chatId) {
      return { ok: false, error: 'Invalid destination number' };
    }

    if (isGroupJid(chatId)) {
      return {
        ok: false,
        error: 'Group destinations are not supported',
        details: 'Envio para grupos não é suportado por esta API.'
      };
    }

    if (!isValidPersonalJid(chatId)) {
      return { ok: false, error: 'Invalid destination number' };
    }

    if (this.selfJidResolver.isSelfJid(chatId)) {
      return {
        ok: false,
        error: 'Destination matches the current WhatsApp account',
        details: 'Envio para o proprio numero foi bloqueado para evitar autoenvio.'
      };
    }

    return { ok: true, chatId };
  }

  async sendText(chatId: string, text: string): Promise<SendTextResult> {
    const clientWithSend = this.client as WebJsClientWithMessaging;
    const sent = await clientWithSend.sendMessage(chatId, text) as Message & {
      id?: { _serialized?: string };
      timestamp?: number;
      to?: string;
      ack?: number;
    };

    const sentIdSerialized = sent.id?._serialized || '';
    const receivedAt = toIsoFromUnixTimestamp(sent.timestamp);

    this.eventStore.pushEvent({
      id: sentIdSerialized,
      source: 'send-api',
      isFromMe: true,
      chatJid: chatId,
      text,
      receivedAt,
      payload: {
        id: sentIdSerialized,
        timestamp: sent.timestamp || 0,
        ack: sent.ack || 0
      }
    });

    this.contactStore.upsertOnOutbound({
      jid: chatId,
      preview: text,
      receivedAt,
      type: 'chat'
    });

    return {
      id: sentIdSerialized,
      to: sent.to || chatId,
      timestamp: sent.timestamp || 0
    };
  }

  async sendMedia(
    chatId: string,
    buffer: Buffer,
    mimetype: string,
    filename: string,
    caption: string
  ): Promise<SendMediaResult> {
    const clientWithSend = this.client as WebJsClientWithMessaging;
    const media = new MessageMedia(
      mimetype,
      buffer.toString('base64'),
      filename || 'arquivo'
    );

    const isImage = mimetype.startsWith('image/');
    const options: Record<string, unknown> = {
      caption: caption || undefined,
      sendMediaAsDocument: !isImage
    };

    const sent = await clientWithSend.sendMessage(chatId, media, options) as Message & {
      id?: { _serialized?: string };
      timestamp?: number;
      to?: string;
      ack?: number;
    };

    const sentIdSerialized = sent.id?._serialized || '';
    const receivedAt = toIsoFromUnixTimestamp(sent.timestamp);
    const mediaDataUrl = isImage
      ? `data:${mimetype};base64,${buffer.toString('base64')}`
      : null;

    this.eventStore.pushEvent({
      id: sentIdSerialized,
      source: 'send-media-api',
      isFromMe: true,
      chatJid: chatId,
      text: caption,
      receivedAt,
      payload: {
        id: sentIdSerialized,
        timestamp: sent.timestamp || 0,
        ack: sent.ack || 0,
        hasMedia: true,
        mediaMimetype: mimetype,
        mediaFilename: filename || '',
        mediaDataUrl
      }
    });

    this.contactStore.upsertOnOutbound({
      jid: chatId,
      preview: caption,
      receivedAt,
      type: isImage ? 'image' : 'document',
      hasMedia: true,
      mediaMimetype: mimetype
    });

    return {
      id: sentIdSerialized,
      to: sent.to || chatId,
      timestamp: sent.timestamp || 0
    };
  }

  async markAsSeen(jid: string): Promise<void> {
    this.contactStore.resetUnreadCount(jid);

    const clientWithChat = this.client as WebJsClientWithMessaging;
    try {
      const chat = await clientWithChat.getChatById(jid);
      if (chat && typeof chat.sendSeen === 'function') {
        await chat.sendSeen();
      }
    } catch (err) {
      console.warn(
        '[whatsapp-webjs-bridge] sendSeen falhou para',
        jid,
        '-',
        (err as { message?: string } | null)?.message || String(err)
      );
    }
  }

  async resolveHistoryImageDataUrl(message: RawMessage): Promise<string | null> {
    const inlineImageDataUrl = readMessageInlineImageDataUrl(message);
    if (inlineImageDataUrl) {
      return inlineImageDataUrl;
    }

    const serializedId = this.selfJidResolver.getSerializedMessageId(message) || '';
    let mediaMessage: RawMessage = message;
    const clientWithMessages = this.client as WebJsClientWithMessaging;

    if (typeof mediaMessage?.downloadMedia !== 'function' && serializedId) {
      try {
        const hydrated = await withTimeout(
          clientWithMessages.getMessageById(serializedId),
          10000,
          `getMessageById(${serializedId})`
        );
        if (hydrated) {
          mediaMessage = hydrated as unknown as RawMessage;
        }
      } catch {
        // Keep original serialized message when hydration fails.
      }
    }

    const mediaMimetype = typeof mediaMessage?._data?.mimetype === 'string'
      ? mediaMessage._data.mimetype.trim()
      : (typeof message?._data?.mimetype === 'string' ? message._data.mimetype.trim() : '');
    const isImageMessage = mediaMimetype.startsWith('image/')
      || mediaMessage?.type === 'image'
      || message?.type === 'image';

    if (!isImageMessage || typeof mediaMessage?.downloadMedia !== 'function') {
      return null;
    }

    try {
      const media = await withTimeout(
        mediaMessage.downloadMedia!(),
        15000,
        `downloading history media (${serializedId || 'unknown'})`
      );
      if (!media?.data) {
        return null;
      }

      const resolvedMimetype = media?.mimetype || mediaMimetype || 'image/jpeg';
      return `data:${resolvedMimetype};base64,${media.data}`;
    } catch {
      return null;
    }
  }

  shouldIncludeHistoryMessage(message: RawMessage | null | undefined): boolean {
    if (!message || isIgnoredWhatsappMessage(message)) {
      return false;
    }

    const body = typeof message.body === 'string' ? message.body.trim() : '';
    if (body) {
      return true;
    }

    if (readMessageInlineImageDataUrl(message)) {
      return true;
    }

    const mediaMimetype = typeof message?._data?.mimetype === 'string'
      ? message._data.mimetype.trim().toLowerCase()
      : '';
    const type = typeof message?.type === 'string' ? message.type : '';

    return Boolean(message.hasMedia)
      || mediaMimetype.length > 0
      || type === 'image'
      || type === 'video'
      || type === 'audio'
      || type === 'ptt'
      || type === 'document'
      || type === 'sticker'
      || type === 'revoked';
  }

  propagateAckToContact(messageId: string, ack: number): void {
    const chatJid = this.eventStore.getEventChatJid(messageId);
    if (!chatJid) {
      return;
    }

    this.contactStore.updateLastMessageAck(chatJid, ack);
  }
}
