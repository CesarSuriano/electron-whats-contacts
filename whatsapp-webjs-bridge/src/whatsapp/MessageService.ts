import pkg from 'whatsapp-web.js';
import type { Client as WebJsClient, Message } from 'whatsapp-web.js';
import type { RawMessage } from '../domain/types.js';
import { SessionState } from '../state/SessionState.js';
import { EventStore } from '../state/EventStore.js';
import { ContactStore } from '../state/ContactStore.js';
import { LidMap } from '../state/LidMap.js';
import { SelfJidResolver } from './SelfJidResolver.js';
import { isGroupJid, isLinkedId, isPersonalJid, isValidPersonalJid, normalizeJid } from '../utils/jid.js';
import { brazilianAlternativeJid } from '../utils/phone.js';
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

type WebJsMessageExtended = Message & {
  delete?: (everyone?: boolean) => Promise<void>;
  forward?: (chat: unknown) => Promise<void>;
};

type WebJsClientWithMessaging = WebJsClient & {
  sendMessage: (chatId: string, content: string | InstanceType<typeof MessageMedia>, options?: Record<string, unknown>) => Promise<Message>;
  getMessageById: (id: string) => Promise<WebJsMessageExtended | null | undefined>;
  getChatById: (id: string) => Promise<{ sendSeen?: () => Promise<unknown> } | null | undefined>;
};

export class MessageService {
  constructor(
    private readonly client: WebJsClient,
    private readonly sessionState: SessionState,
    private readonly eventStore: EventStore,
    private readonly contactStore: ContactStore,
    private readonly lidMap: LidMap,
    private readonly selfJidResolver: SelfJidResolver
  ) {}

  requireReady(): DestinationError | null {
    if (!this.sessionState.isReady()) {
      return { ok: false, error: 'WhatsApp session is not ready yet' };
    }
    return null;
  }

  validateDestination(to: string): DestinationValidation {
    let chatId = normalizeJid(to);
    if (!chatId) {
      return { ok: false, error: 'Invalid destination number' };
    }

    if (!isGroupJid(chatId) && !isValidPersonalJid(chatId) && !isLinkedId(chatId)) {
      return { ok: false, error: 'Invalid destination number' };
    }

    chatId = this.resolvePreferredPersonalDestination(chatId);

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
    const delivery = await this.sendWithBrazilianAlternative(chatId, candidate => clientWithSend.sendMessage(candidate, text) as Promise<Message & {
      id?: { _serialized?: string; remote?: { _serialized?: string } | string };
      timestamp?: number;
      to?: string;
      ack?: number;
    }>);
    const sent = delivery.sent;
    const deliveredChatId = delivery.chatId;

    const sentIdSerialized = sent.id?._serialized || '';
    const receivedAt = toIsoFromUnixTimestamp(sent.timestamp);

    this.registerLidFromSentMessage(deliveredChatId, sent);

    this.eventStore.pushEvent({
      id: sentIdSerialized,
      source: 'send-api',
      isFromMe: true,
      chatJid: deliveredChatId,
      text,
      receivedAt,
      payload: {
        id: sentIdSerialized,
        timestamp: sent.timestamp || 0,
        ack: sent.ack || 0
      }
    });

    this.contactStore.upsertOnOutbound({
      jid: deliveredChatId,
      preview: text,
      receivedAt,
      type: 'chat'
    });

    return {
      id: sentIdSerialized,
      to: sent.to || deliveredChatId,
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

    const delivery = await this.sendWithBrazilianAlternative(chatId, candidate => clientWithSend.sendMessage(candidate, media, options) as Promise<Message & {
      id?: { _serialized?: string; remote?: { _serialized?: string } | string };
      timestamp?: number;
      to?: string;
      ack?: number;
    }>);
    const sent = delivery.sent;
    const deliveredChatId = delivery.chatId;

    const sentIdSerialized = sent.id?._serialized || '';
    const receivedAt = toIsoFromUnixTimestamp(sent.timestamp);
    const mediaDataUrl = isImage
      ? `data:${mimetype};base64,${buffer.toString('base64')}`
      : null;

    this.registerLidFromSentMessage(deliveredChatId, sent);

    this.eventStore.pushEvent({
      id: sentIdSerialized,
      source: 'send-media-api',
      isFromMe: true,
      chatJid: deliveredChatId,
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
      jid: deliveredChatId,
      preview: caption,
      receivedAt,
      type: isImage ? 'image' : 'document',
      hasMedia: true,
      mediaMimetype: mimetype
    });

    return {
      id: sentIdSerialized,
      to: sent.to || deliveredChatId,
      timestamp: sent.timestamp || 0
    };
  }

  private async sendWithBrazilianAlternative<T>(
    chatId: string,
    send: (candidateChatId: string) => Promise<T>
  ): Promise<{ chatId: string; sent: T }> {
    const candidates = this.buildSendCandidates(chatId);
    let lastError: unknown = null;

    for (const candidate of candidates) {
      try {
        return { chatId: candidate, sent: await send(candidate) };
      } catch (error) {
        lastError = error;
      }
    }

    // Última tentativa: pergunta ao próprio WhatsApp Web qual é o JID
    // canônico daquele número (resolve o caso "número está cadastrado, mas
    // nem com nem sem 9º dígito bate com o que tentamos"). Best-effort:
    // se a chamada falhar ou não devolver JID, propaga o erro original.
    const lookupJid = await this.lookupCanonicalJid(chatId);
    if (lookupJid && !candidates.includes(lookupJid)) {
      try {
        return { chatId: lookupJid, sent: await send(lookupJid) };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error('No send candidates produced for ' + chatId);
  }

  /**
   * Lista de variantes a tentar para um JID. Para números brasileiros
   * personal, sempre tentamos as DUAS formas (com e sem 9º dígito), em
   * ordem de preferência baseada em quem está no contactStore.
   *
   * Antes a função `resolveBrazilianFallbackDestination` tinha um bug:
   * quando `resolvePreferredPersonalDestination` escolhia o variante como
   * preferido (porque era o conhecido), o fallback recomputava o mesmo
   * variante e abortava. Resultado: mensagem nunca tentava o JID original.
   */
  private buildSendCandidates(chatId: string): string[] {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const push = (jid: string | null | undefined): void => {
      if (!jid || seen.has(jid)) return;
      if (this.selfJidResolver.isSelfJid(jid)) return;
      candidates.push(jid);
      seen.add(jid);
    };

    const preferred = this.resolvePreferredPersonalDestination(chatId);
    push(preferred);
    push(chatId);

    if (isPersonalJid(chatId) && isValidPersonalJid(chatId)) {
      push(brazilianAlternativeJid(chatId));
    }

    return candidates;
  }

  private async lookupCanonicalJid(chatId: string): Promise<string | null> {
    if (!isPersonalJid(chatId) || !isValidPersonalJid(chatId)) {
      return null;
    }

    const clientWithLookup = this.client as WebJsClient & {
      getNumberId?: (phone: string) => Promise<{ _serialized?: string } | null | undefined>;
    };

    if (typeof clientWithLookup.getNumberId !== 'function') {
      return null;
    }

    try {
      const phone = chatId.replace('@c.us', '');
      const result = await withTimeout(
        clientWithLookup.getNumberId(phone),
        8000,
        `getNumberId(${phone})`
      );
      const serialized = result?._serialized;
      if (typeof serialized === 'string' && isPersonalJid(serialized)) {
        return serialized;
      }
    } catch {
      // best-effort
    }
    return null;
  }

  private resolvePreferredPersonalDestination(chatId: string): string {
    if (!isPersonalJid(chatId) || !isValidPersonalJid(chatId)) {
      return chatId;
    }

    const alternativeJid = brazilianAlternativeJid(chatId);
    if (!alternativeJid) {
      return chatId;
    }

    const current = this.contactStore.get(chatId);
    const alternative = this.contactStore.get(alternativeJid);

    if (!alternative) {
      return chatId;
    }

    if (!current || this.scoreKnownDestination(alternative) > this.scoreKnownDestination(current)) {
      return alternativeJid;
    }

    return chatId;
  }

  private scoreKnownDestination(contact: { found?: boolean; fromGetChats?: boolean; getChatsTimestampMs?: number; lastMessageAt?: string | null; lastMessagePreview?: string }): number {
    let score = 0;

    if (contact.found) {
      score += 4;
    }

    if (contact.fromGetChats) {
      score += 8;
    }

    if ((contact.getChatsTimestampMs || 0) > 0) {
      score += 4;
    }

    if (contact.lastMessageAt) {
      score += 2;
    }

    if (contact.lastMessagePreview) {
      score += 1;
    }

    return score;
  }

  private registerLidFromSentMessage(
    chatId: string,
    sent: { id?: { _serialized?: string; remote?: { _serialized?: string } | string }; to?: string }
  ): void {
    if (!isPersonalJid(chatId) || !isValidPersonalJid(chatId)) {
      return;
    }

    const candidates: string[] = [];

    const remote = sent.id?.remote;
    if (typeof remote === 'string') {
      candidates.push(remote.trim());
    } else if (remote && typeof remote === 'object' && typeof remote._serialized === 'string') {
      candidates.push(remote._serialized.trim());
    }

    if (typeof sent.to === 'string') {
      candidates.push(sent.to.trim());
    }

    const sentIdSerialized = typeof sent.id?._serialized === 'string' ? sent.id._serialized.trim() : '';
    if (sentIdSerialized) {
      const parts = sentIdSerialized.split('_');
      if (parts.length >= 3) {
        candidates.push(parts[1]);
      }
    }

    for (const candidate of candidates) {
      if (candidate && candidate !== chatId && isLinkedId(candidate)) {
        if (this.lidMap.getLid(chatId) !== candidate) {
          this.lidMap.set(chatId, candidate);
        }
        return;
      }
    }
  }

  async sendReply(chatId: string, text: string, quotedMessageId: string): Promise<SendTextResult> {
    const clientWithSend = this.client as WebJsClientWithMessaging;
    const delivery = await this.sendWithBrazilianAlternative(chatId, candidate => clientWithSend.sendMessage(candidate, text, { quotedMessageId }) as Promise<Message & {
      id?: { _serialized?: string; remote?: { _serialized?: string } | string };
      timestamp?: number;
      to?: string;
      ack?: number;
    }>);
    const sent = delivery.sent;
    const deliveredChatId = delivery.chatId;

    const sentIdSerialized = sent.id?._serialized || '';
    const receivedAt = toIsoFromUnixTimestamp(sent.timestamp);

    this.registerLidFromSentMessage(deliveredChatId, sent);

    this.eventStore.pushEvent({
      id: sentIdSerialized,
      source: 'send-api',
      isFromMe: true,
      chatJid: deliveredChatId,
      text,
      receivedAt,
      payload: {
        id: sentIdSerialized,
        timestamp: sent.timestamp || 0,
        ack: sent.ack || 0,
        quotedMsgBody: text,
        quotedMsgFromMe: false
      }
    });

    this.contactStore.upsertOnOutbound({
      jid: deliveredChatId,
      preview: text,
      receivedAt,
      type: 'chat'
    });

    return {
      id: sentIdSerialized,
      to: sent.to || deliveredChatId,
      timestamp: sent.timestamp || 0
    };
  }

  async deleteMessage(messageId: string, deleteForEveryone = true): Promise<void> {
    const clientWithMessages = this.client as WebJsClientWithMessaging;
    const message = await clientWithMessages.getMessageById(messageId);

    if (!message) {
      throw new Error('Mensagem não encontrada ou já expirou do cache');
    }

    if (typeof message.delete !== 'function') {
      throw new Error('Operação de apagar não suportada para esta mensagem');
    }

    await message.delete(deleteForEveryone);
    this.eventStore.removeEvent(messageId);
  }

  async forwardMessage(chatId: string, messageId: string): Promise<void> {
    const clientWithMessages = this.client as WebJsClientWithMessaging;
    const message = await clientWithMessages.getMessageById(messageId);

    if (!message) {
      throw new Error('Mensagem não encontrada ou já expirou do cache');
    }

    if (typeof message.forward !== 'function') {
      throw new Error('Operação de encaminhar não suportada para esta mensagem');
    }

    const chat = await clientWithMessages.getChatById(chatId);
    if (!chat) {
      throw new Error('Conversa de destino não encontrada');
    }

    await message.forward(chat);
  }

  async markAsSeen(jid: string): Promise<void> {
    this.contactStore.resetUnreadCount(jid);

    const clientWithChat = this.client as WebJsClientWithMessaging;
    let lastError: unknown = null;

    for (const candidateJid of this.buildSeenCandidates(jid)) {
      try {
        const chat = await clientWithChat.getChatById(candidateJid);
        if (chat && typeof chat.sendSeen === 'function') {
          await chat.sendSeen();
          return;
        }
      } catch (err) {
        lastError = err;
      }
    }

    if (lastError) {
      console.warn(
        '[whatsapp-webjs-bridge] sendSeen falhou para',
        jid,
        '-',
        (lastError as { message?: string } | null)?.message || String(lastError)
      );
    }
  }

  private buildSeenCandidates(jid: string): string[] {
    const candidates = [jid];

    if (isLinkedId(jid)) {
      const canonicalJid = this.lidMap.findCanonical(jid);
      if (canonicalJid) {
        candidates.push(canonicalJid);
      }
    } else {
      const linkedJid = this.lidMap.getLid(jid);
      if (linkedJid) {
        candidates.push(linkedJid);
      }
    }

    return Array.from(new Set(candidates.filter(Boolean)));
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
