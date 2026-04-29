import type { Client as WebJsClient } from 'whatsapp-web.js';
import type { ContactEntry, RawChat, RawMessage } from '../domain/types.js';
import { SessionState } from '../state/SessionState.js';
import { EventStore } from '../state/EventStore.js';
import { ContactStore } from '../state/ContactStore.js';
import { LidMap } from '../state/LidMap.js';
import { SelfJidResolver } from './SelfJidResolver.js';
import { normalizePhone } from '../utils/phone.js';
import {
  isGroupJid,
  isLinkedId,
  isPersonalJid,
  isPersonalOrLinkedJid,
  isValidPersonalJid
} from '../utils/jid.js';
import { getContactName, extractLastMessagePreview } from '../utils/contact.js';
import { isIgnoredWhatsappMessage, resolveMessagePreviewText } from '../utils/message.js';
import { resolvePhoneFromLid } from '../utils/lidResolver.js';
import { toIsoFromUnixTimestamp } from '../utils/time.js';

const EVENT_SEED_CHAT_LIMIT = 80;
const EVENT_SEED_COOLDOWN_MS = 60 * 1000;

type WebJsClientWithChats = WebJsClient & {
  getChats: () => Promise<RawChat[]>;
};

function serializeMessageJidCandidate(candidate: unknown): string {
  if (typeof candidate === 'string') {
    return candidate.trim();
  }

  if (candidate && typeof candidate === 'object') {
    const record = candidate as { _serialized?: unknown };
    if (typeof record._serialized === 'string') {
      return record._serialized.trim();
    }
  }

  return '';
}

function parseIsoTimestampMs(value: string | null | undefined): number {
  if (typeof value !== 'string' || !value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

type UnresolvedLidCallback = (lidJid: string) => void;

const UNRESOLVED_LID_NOTIFY_COOLDOWN_MS = 4000;

export class IngestionService {
  private lastSeedEventsAt = 0;
  private seedEventsPromise: Promise<void> | null = null;
  private onUnresolvedLid: UnresolvedLidCallback | null = null;
  private lastUnresolvedLidNotifyAt = 0;

  constructor(
    private readonly client: WebJsClient,
    private readonly sessionState: SessionState,
    private readonly eventStore: EventStore,
    private readonly contactStore: ContactStore,
    private readonly lidMap: LidMap,
    private readonly selfJidResolver: SelfJidResolver
  ) {}

  setOnUnresolvedLid(callback: UnresolvedLidCallback | null): void {
    this.onUnresolvedLid = callback;
  }

  private notifyUnresolvedLid(lidJid: string): void {
    if (!this.onUnresolvedLid) {
      return;
    }
    const now = Date.now();
    if (now - this.lastUnresolvedLidNotifyAt < UNRESOLVED_LID_NOTIFY_COOLDOWN_MS) {
      return;
    }
    this.lastUnresolvedLidNotifyAt = now;
    try {
      this.onUnresolvedLid(lidJid);
    } catch {
      // best effort
    }
  }

  resolveMessageChatJid(message: RawMessage | null | undefined): string {
    if (!message) {
      return '';
    }

    const messageIdRemote = typeof message.id === 'object' ? message.id?.remote : undefined;
    const remoteCandidates = [
      serializeMessageJidCandidate(messageIdRemote),
      serializeMessageJidCandidate(message.chatId),
      serializeMessageJidCandidate(message.chat?.id)
    ];
    const directionalCandidates = this.selfJidResolver.resolveIsFromMe(message)
      ? [
        serializeMessageJidCandidate(message.to),
        serializeMessageJidCandidate(message.from),
        serializeMessageJidCandidate(message._data?.to),
        serializeMessageJidCandidate(message._data?.from),
        serializeMessageJidCandidate(message.author)
      ]
      : [
        serializeMessageJidCandidate(message.from),
        serializeMessageJidCandidate(message.to),
        serializeMessageJidCandidate(message._data?.from),
        serializeMessageJidCandidate(message._data?.to),
        serializeMessageJidCandidate(message.author)
      ];

    const candidates = [...remoteCandidates, ...directionalCandidates].filter(Boolean);

    if (candidates.some(candidate => isGroupJid(candidate))) {
      return '';
    }

    for (const candidate of candidates) {
      if (!isPersonalOrLinkedJid(candidate)) {
        continue;
      }

      if (isPersonalJid(candidate) && !isValidPersonalJid(candidate)) {
        continue;
      }

      if (this.selfJidResolver.isSelfJid(candidate)) {
        continue;
      }

      return candidate;
    }

    return '';
  }

  async resolveContactPhone(message: RawMessage): Promise<string | null> {
    try {
      if (typeof message.getContact !== 'function') {
        return null;
      }
      const sourceLidDigits = normalizePhone(this.resolveMessageChatJid(message));
      const isMirroredLidAlias = (candidate: string): boolean => {
        return Boolean(sourceLidDigits) && normalizePhone(candidate) === sourceLidDigits;
      };

      const contact = await message.getContact();
      const rawJid = typeof contact.id?._serialized === 'string' ? contact.id._serialized.trim() : '';
      const lidUser = typeof contact.id?.user === 'string'
        ? contact.id.user.trim()
        : normalizePhone(rawJid);
      const number = typeof contact.number === 'string' ? contact.number.trim() : '';

      if (number.length >= 8 && number !== lidUser && !isMirroredLidAlias(number)) {
        return `${number}@c.us`;
      }

      if (isPersonalJid(rawJid) && isValidPersonalJid(rawJid) && !isMirroredLidAlias(rawJid)) {
        return rawJid;
      }

      if (isLinkedId(rawJid)) {
        const fromStore = await resolvePhoneFromLid(this.client, rawJid);
        if (fromStore && !this.selfJidResolver.isSelfJid(fromStore) && !isMirroredLidAlias(fromStore)) {
          return fromStore;
        }
      }
    } catch {
      // silencioso
    }
    return null;
  }

  private rewriteConversationReferences(fromJid: string, toJid: string): void {
    if (!fromJid || !toJid || fromJid === toJid) {
      return;
    }

    for (const event of this.eventStore.events) {
      if (event.chatJid === fromJid) {
        event.chatJid = toJid;
        event.phone = normalizePhone(toJid);
      }
    }
  }

  private registerCanonicalLid(canonicalJid: string, lidJid: string): void {
    if (!canonicalJid || !lidJid) {
      return;
    }

    const displacedCanonicals = this.lidMap.set(canonicalJid, lidJid);
    displacedCanonicals.forEach(displacedCanonical => {
      this.mergeAliasContactIntoCanonical(canonicalJid, displacedCanonical);
    });
  }

  private mergeAliasContactIntoCanonical(canonicalJid: string, aliasJid: string): void {
    if (!canonicalJid || !aliasJid || canonicalJid === aliasJid) {
      return;
    }

    const alias = this.contactStore.get(aliasJid);
    if (!alias) {
      return;
    }

    const canonical = this.contactStore.get(canonicalJid);
    const canonicalLastMessageAtMs = parseIsoTimestampMs(canonical?.lastMessageAt);
    const aliasLastMessageAtMs = parseIsoTimestampMs(alias.lastMessageAt);
    const latest = aliasLastMessageAtMs > canonicalLastMessageAtMs ? alias : (canonical || alias);

    const merged: ContactEntry = {
      jid: canonicalJid,
      phone: normalizePhone(canonicalJid),
      name: canonical?.name || alias.name || normalizePhone(canonicalJid),
      found: canonical?.found ?? alias.found ?? true,
      lastMessageAt: latest.lastMessageAt || canonical?.lastMessageAt || alias.lastMessageAt || null,
      lastMessagePreview: latest.lastMessagePreview || canonical?.lastMessagePreview || alias.lastMessagePreview || '',
      lastMessageFromMe: latest.lastMessageFromMe ?? Boolean(canonical?.lastMessageFromMe || alias.lastMessageFromMe),
      lastMessageType: latest.lastMessageType || canonical?.lastMessageType || alias.lastMessageType || '',
      lastMessageHasMedia: latest.lastMessageHasMedia ?? Boolean(canonical?.lastMessageHasMedia || alias.lastMessageHasMedia),
      lastMessageMediaMimetype: latest.lastMessageMediaMimetype
        || canonical?.lastMessageMediaMimetype
        || alias.lastMessageMediaMimetype
        || '',
      lastMessageAck: latest.lastMessageAck ?? canonical?.lastMessageAck ?? alias.lastMessageAck ?? null,
      unreadCount: (canonical?.unreadCount ?? 0) + (alias.unreadCount ?? 0),
      labels: Array.isArray(canonical?.labels) && canonical.labels.length
        ? canonical.labels
        : (Array.isArray(alias.labels) ? alias.labels : []),
      isGroup: false,
      fromGetChats: Boolean(canonical?.fromGetChats || alias.fromGetChats),
      getChatsTimestampMs: Math.max(
        Number(canonical?.getChatsTimestampMs || 0),
        Number(alias.getChatsTimestampMs || 0)
      )
    };

    this.contactStore.set(canonicalJid, merged);
    this.contactStore.delete(aliasJid);
    this.rewriteConversationReferences(aliasJid, canonicalJid);
  }

  async ingestInboundMessage(message: RawMessage | null | undefined, source: string): Promise<void> {
    if (!message || isIgnoredWhatsappMessage(message) || this.selfJidResolver.resolveIsFromMe(message)) {
      return;
    }

    let chatJid = this.resolveMessageChatJid(message);
    const originalLid = isLinkedId(chatJid) ? chatJid : null;

    if (isLinkedId(chatJid)) {
      const resolved = await this.resolveContactPhone(message);
      if (resolved) {
        console.log('[whatsapp-webjs-bridge] LID resolvido:', chatJid, '->', resolved);
        this.registerCanonicalLid(resolved, chatJid);
        chatJid = resolved;
      } else {
        const knownCanonical = this.lidMap.findCanonical(chatJid);
        if (knownCanonical) {
          console.log('[whatsapp-webjs-bridge] LID reaproveitado do mapa:', chatJid, '->', knownCanonical);
          chatJid = knownCanonical;
        } else {
          console.log('[whatsapp-webjs-bridge] LID sem canônico confiável, mantendo linked-id:', chatJid);
          this.notifyUnresolvedLid(chatJid);
        }
      }
    }

    if (originalLid && chatJid !== originalLid) {
      this.registerCanonicalLid(chatJid, originalLid);
      this.mergeAliasContactIntoCanonical(chatJid, originalLid);
    }

    if ((!isPersonalJid(chatJid) && !isLinkedId(chatJid)) || this.selfJidResolver.isSelfJid(chatJid)) {
      console.log('[whatsapp-webjs-bridge] mensagem descartada (sem chat 1:1):', {
        source,
        from: message.from,
        to: message.to,
        body: typeof message.body === 'string' ? message.body.slice(0, 60) : ''
      });
      return;
    }

    console.log('[whatsapp-webjs-bridge] mensagem recebida:', {
      source,
      chatJid,
      body: typeof message.body === 'string' ? message.body.slice(0, 60) : ''
    });

    const text = resolveMessagePreviewText(message);
    const mediaMimetype = typeof message?._data?.mimetype === 'string' ? message._data.mimetype : '';
    const mediaFilename = typeof message?._data?.filename === 'string' ? message._data.filename : '';
    const messageId = typeof message.id === 'object' && message.id?._serialized ? message.id._serialized : '';
    const receivedAt = toIsoFromUnixTimestamp(message.timestamp);
    let mediaDataUrl: string | null = null;

    if (mediaMimetype.startsWith('image/') || message.type === 'image') {
      try {
        if (typeof message.downloadMedia === 'function') {
          const media = await message.downloadMedia();
          if (media?.data) {
            const resolvedMimetype = media?.mimetype || mediaMimetype || 'image/jpeg';
            mediaDataUrl = `data:${resolvedMimetype};base64,${media.data}`;
          }
        }
      } catch {
        mediaDataUrl = null;
      }
    }

    this.eventStore.pushEvent({
      id: messageId,
      source,
      isFromMe: false,
      chatJid,
      text,
      receivedAt,
      payload: {
        id: messageId,
        timestamp: message.timestamp || 0,
        type: message.type || '',
        hasMedia: Boolean(message.hasMedia),
        mediaMimetype,
        mediaFilename,
        mediaDataUrl
      }
    });

    const getChatsTimestampMs = Number(message.timestamp || 0) > 0
      ? Number(message.timestamp) * 1000
      : Date.now();

    const existing = this.contactStore.get(chatJid);
    if (!existing) {
      let contactName = '';
      try {
        if (typeof message.getContact === 'function') {
          const contact = await message.getContact();
          contactName = getContactName(contact);
        }
      } catch {
        contactName = '';
      }

      const phone = isLinkedId(chatJid) ? '' : normalizePhone(chatJid);
      this.contactStore.set(chatJid, this.contactStore.createDefault(chatJid, {
        phone,
        name: contactName || phone,
        found: true,
        lastMessageAt: receivedAt,
        lastMessagePreview: text,
        lastMessageFromMe: false,
        unreadCount: 1,
        fromGetChats: true,
        getChatsTimestampMs
      }));
    } else {
      this.contactStore.set(chatJid, {
        ...existing,
        lastMessageAt: receivedAt,
        lastMessagePreview: text,
        lastMessageFromMe: false,
        unreadCount: (typeof existing.unreadCount === 'number' ? existing.unreadCount : 0) + 1,
        fromGetChats: true,
        getChatsTimestampMs
      });
    }
  }

  /**
   * Lightweight outbound ingestion for messages created on other devices
   * (e.g. user typed on phone directly). Updates contact preview/timestamp
   * without pushing a new event — the native message_ack handler will handle
   * acks, and /events endpoint picks these up via getChats during refresh.
   */
  async ingestOutboundFromCreate(message: RawMessage | null | undefined, source: string): Promise<void> {
    if (!message || isIgnoredWhatsappMessage(message) || !this.selfJidResolver.resolveIsFromMe(message)) {
      return;
    }

    let chatJid = this.resolveMessageChatJid(message);
    if (isLinkedId(chatJid)) {
      const knownCanonical = this.lidMap.findCanonical(chatJid);
      if (knownCanonical) {
        chatJid = knownCanonical;
      }
    }

    if ((!isPersonalJid(chatJid) && !isLinkedId(chatJid)) || this.selfJidResolver.isSelfJid(chatJid)) {
      return;
    }

    const text = resolveMessagePreviewText(message);
    const receivedAt = toIsoFromUnixTimestamp(message.timestamp);
    const messageId = typeof message.id === 'object' && message.id?._serialized ? message.id._serialized : '';
    const getChatsTimestampMs = Number(message.timestamp || 0) > 0
      ? Number(message.timestamp) * 1000
      : Date.now();

    const existing = this.contactStore.get(chatJid);
    const existingTimestampMs = existing?.getChatsTimestampMs || 0;

    if (existingTimestampMs >= getChatsTimestampMs) {
      return;
    }

    console.log('[whatsapp-webjs-bridge] outbound externo captado:', { source, chatJid });

    this.eventStore.pushEvent({
      id: messageId,
      source,
      isFromMe: true,
      chatJid,
      text,
      receivedAt,
      payload: {
        id: messageId,
        timestamp: message.timestamp || 0,
        type: message.type || '',
        hasMedia: Boolean(message.hasMedia),
        mediaMimetype: typeof message?._data?.mimetype === 'string' ? message._data.mimetype : '',
        mediaFilename: typeof message?._data?.filename === 'string' ? message._data.filename : '',
        ack: typeof message.ack === 'number' ? message.ack : 0
      }
    });

    if (!existing) {
      const phone = normalizePhone(chatJid);
      this.contactStore.set(chatJid, this.contactStore.createDefault(chatJid, {
        phone,
        name: phone,
        found: true,
        lastMessageAt: receivedAt,
        lastMessagePreview: text,
        lastMessageFromMe: true,
        lastMessageAck: typeof message.ack === 'number' ? message.ack : 0,
        fromGetChats: true,
        getChatsTimestampMs
      }));
      return;
    }

    this.contactStore.set(chatJid, {
      ...existing,
      lastMessageAt: receivedAt,
      lastMessagePreview: text,
      lastMessageFromMe: true,
      lastMessageAck: typeof message.ack === 'number' ? message.ack : existing.lastMessageAck,
      fromGetChats: true,
      getChatsTimestampMs
    });
  }

  async seedEventsFromRecentChats(preloadedChats: RawChat[] | null = null): Promise<void> {
    if (!this.sessionState.isReady()) {
      return;
    }

    const now = Date.now();
    if (now - this.lastSeedEventsAt < EVENT_SEED_COOLDOWN_MS && this.eventStore.events.length > 0) {
      return;
    }

    if (this.seedEventsPromise) {
      return this.seedEventsPromise;
    }

    const clientWithChats = this.client as WebJsClientWithChats;

    this.seedEventsPromise = (async () => {
      let chats: RawChat[] = preloadedChats || [];
      if (!chats.length) {
        try {
          chats = await clientWithChats.getChats();
        } catch {
          return;
        }
      }

      const candidates = chats
        .filter(chat => {
          const jid = chat.id?._serialized || '';
          if (chat.isGroup) {
            return isGroupJid(jid);
          }
          return isValidPersonalJid(jid) && !this.selfJidResolver.isSelfJid(jid);
        })
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .slice(0, EVENT_SEED_CHAT_LIMIT);

      candidates.forEach(chat => {
        const chatJid = chat.id?._serialized || '';
        if (!chatJid) {
          return;
        }

        const lastMessage = chat.lastMessage;
        const hasLastMessage = Boolean(lastMessage);
        const messageTimestamp = Number(lastMessage?.timestamp || chat.timestamp || Math.floor(Date.now() / 1000));
        const receivedAt = toIsoFromUnixTimestamp(messageTimestamp);
        const previewText = hasLastMessage ? extractLastMessagePreview(chat) : '';

        const lastMessageIdSerialized = typeof lastMessage?.id === 'object' && lastMessage.id?._serialized
          ? lastMessage.id._serialized
          : '';
        const eventId = lastMessageIdSerialized || `seed-${chatJid}-${messageTimestamp}`;

        this.eventStore.pushEvent({
          id: eventId,
          source: hasLastMessage ? 'webjs-seed' : 'webjs-seed-chat',
          isFromMe: this.selfJidResolver.resolveIsFromMe(lastMessage),
          chatJid,
          text: previewText,
          receivedAt,
          payload: {
            id: lastMessageIdSerialized,
            timestamp: messageTimestamp,
            type: lastMessage?.type || '',
            hasMedia: Boolean(lastMessage?.hasMedia)
          }
        });
      });

      this.lastSeedEventsAt = Date.now();
    })().finally(() => {
      this.seedEventsPromise = null;
    });

    return this.seedEventsPromise;
  }
}
