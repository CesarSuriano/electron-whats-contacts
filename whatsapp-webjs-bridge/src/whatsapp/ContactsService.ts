import type { Client as WebJsClient } from 'whatsapp-web.js';
import type {
  ContactEntry,
  ContactsUpdatedCallback,
  RawChat,
  RawContact,
  RawMessage,
  WhatsappLabel
} from '../domain/types.js';
import { SessionState } from '../state/SessionState.js';
import { ContactStore } from '../state/ContactStore.js';
import { LidMap } from '../state/LidMap.js';
import { SelfJidResolver } from './SelfJidResolver.js';
import { normalizePhone, brazilianAlternativeJid } from '../utils/phone.js';
import {
  isGroupJid,
  isLinkedId,
  isPersonalJid,
  isPersonalOrLinkedJid,
  isValidPersonalJid
} from '../utils/jid.js';
import { getContactName, extractLastMessagePreview } from '../utils/contact.js';
import { withTimeout } from '../utils/time.js';

export interface ContactsServiceOptions {
  enableProfilePhotoFetch?: boolean;
}

const PHOTO_TTL_MS = 30 * 60 * 1000;
const LINKED_CHAT_CANONICAL_RESOLVE_LIMIT = 25;
const LINKED_CHAT_CANONICAL_RESOLVE_TIMEOUT_MS = 2500;
const LINKED_CHAT_CANONICAL_RESOLVE_CONCURRENCY = 4;
const LABEL_CHATS_TIMEOUT_MS = 12000;
const CONTACTS_REFRESH_COOLDOWN_MS = 25 * 1000;
const CONTACTS_REFRESH_TIMEOUT_MS = 90 * 1000;
const CONTACTS_FETCH_TIMEOUT_MS = 45 * 1000;
const CONTACTS_EMPTY_CACHE_WAIT_MS = 1500;

interface PhotoCacheEntry {
  url: string | null;
  fetchedAt: number;
}

interface LastMessageMetadata {
  lastMessageType: string;
  lastMessageHasMedia: boolean;
  lastMessageMediaMimetype: string;
}

type WebJsClientWithInternals = WebJsClient & {
  pupPage?: {
    evaluate: <T>(pageFunction: (...args: unknown[]) => T | Promise<T>, ...args: unknown[]) => Promise<T>;
  };
};

function resolveLastMessageMetadata(
  lastMessage: RawMessage | null | undefined,
  existing: Partial<ContactEntry> = {}
): LastMessageMetadata {
  const lastMessageType = typeof lastMessage?.type === 'string'
    ? lastMessage.type
    : (typeof existing.lastMessageType === 'string' ? existing.lastMessageType : '');
  const lastMessageMediaMimetype = typeof lastMessage?._data?.mimetype === 'string'
    ? lastMessage._data.mimetype
    : (typeof existing.lastMessageMediaMimetype === 'string' ? existing.lastMessageMediaMimetype : '');
  const lastMessageHasMedia = lastMessage
    ? Boolean(lastMessage?.hasMedia)
      || Boolean(lastMessageMediaMimetype)
      || lastMessageType === 'image'
      || lastMessageType === 'video'
      || lastMessageType === 'audio'
      || lastMessageType === 'ptt'
      || lastMessageType === 'document'
      || lastMessageType === 'sticker'
    : Boolean(existing.lastMessageHasMedia);

  return {
    lastMessageType,
    lastMessageHasMedia,
    lastMessageMediaMimetype
  };
}

export class ContactsService {
  private readonly photosByJid = new Map<string, PhotoCacheEntry>();
  private lastContactsRefreshAt = 0;
  private contactsRefreshPromise: Promise<void> | null = null;
  private onContactsUpdated: ContactsUpdatedCallback | null = null;

  constructor(
    private readonly client: WebJsClient,
    private readonly sessionState: SessionState,
    private readonly contactStore: ContactStore,
    private readonly lidMap: LidMap,
    private readonly selfJidResolver: SelfJidResolver,
    private readonly options: ContactsServiceOptions = {}
  ) {}

  setOnContactsUpdated(callback: ContactsUpdatedCallback | null): void {
    this.onContactsUpdated = callback;
  }

  getLastContactsRefreshAt(): number {
    return this.lastContactsRefreshAt;
  }

  getCurrentRefreshPromise(): Promise<void> | null {
    return this.contactsRefreshPromise;
  }

  async loadLabelsMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const clientWithLabels = this.client as WebJsClient & {
      getLabels?: () => Promise<unknown[]>;
    };

    if (typeof clientWithLabels.getLabels !== 'function') {
      return map;
    }

    try {
      const labels = await clientWithLabels.getLabels();
      (labels || []).forEach(raw => {
        const label = raw as { id?: unknown; name?: unknown; _data?: { id?: unknown; name?: unknown } } | null;
        const id = String(label?.id ?? label?._data?.id ?? '').trim();
        const name = String(label?.name ?? label?._data?.name ?? '').trim();
        if (id && name) {
          map.set(id, name);
        }
      });
    } catch {
      // Ignore label loading errors.
    }

    return map;
  }

  async loadLabels(): Promise<WhatsappLabel[]> {
    const labels: WhatsappLabel[] = [];
    const clientWithLabels = this.client as WebJsClient & {
      getLabels?: () => Promise<unknown[]>;
      getChatsByLabelId?: (labelId: string) => Promise<RawChat[]>;
    };

    if (typeof clientWithLabels.getLabels !== 'function') {
      return labels;
    }

    try {
      const rawLabels = await clientWithLabels.getLabels();
      const resolvedLabels = await Promise.all((rawLabels || []).map(async raw => {
        const label = raw as {
          id?: unknown;
          name?: unknown;
          hexColor?: unknown;
          getChats?: () => Promise<RawChat[]>;
          _data?: { id?: unknown; name?: unknown; hexColor?: unknown };
        } | null;
        const id = String(label?.id ?? label?._data?.id ?? '').trim();
        const name = String(label?.name ?? label?._data?.name ?? '').trim();
        const hexColor = String(label?.hexColor ?? label?._data?.hexColor ?? '').trim();
        if (!id || !name) {
          return null;
        }

        const chatJids = await this.loadLabelChatJids(raw, id);
        return {
          id,
          name,
          hexColor: hexColor || null,
          ...(chatJids.length ? { chatJids } : {})
        } satisfies WhatsappLabel;
      }));

      resolvedLabels.forEach(label => {
        if (label) {
          labels.push(label);
        }
      });
    } catch {
      const labelsMap = await this.loadLabelsMap();
      for (const [id, name] of labelsMap.entries()) {
        labels.push({ id, name, hexColor: null });
      }
    }

    return labels;
  }

  private async loadLabelChatJids(rawLabel: unknown, labelId: string): Promise<string[]> {
    const labelWithChats = rawLabel as { getChats?: () => Promise<RawChat[]> } | null;
    const clientWithLabels = this.client as WebJsClient & {
      getChatsByLabelId?: (id: string) => Promise<RawChat[]>;
    };

    const loadChats = typeof labelWithChats?.getChats === 'function'
      ? () => labelWithChats.getChats!()
      : (typeof clientWithLabels.getChatsByLabelId === 'function'
        ? () => clientWithLabels.getChatsByLabelId!(labelId)
        : null);

    if (!loadChats) {
      return [];
    }

    try {
      const chats = await withTimeout(loadChats(), LABEL_CHATS_TIMEOUT_MS, `labelChats(${labelId})`);
      if (!Array.isArray(chats) || !chats.length) {
        return [];
      }

      const resolvedCanonicalByLid = await this.resolveRecentLinkedChatCanonicals(chats);
      return Array.from(new Set(chats.map(chat => {
        const rawJid = String(chat?.id?._serialized || '').trim();
        if (!rawJid) {
          return '';
        }

        if (isLinkedId(rawJid)) {
          return resolvedCanonicalByLid.get(rawJid) || this.lidMap.findCanonical(rawJid) || rawJid;
        }

        if (isValidPersonalJid(rawJid)) {
          if (this.contactStore.has(rawJid)) {
            return rawJid;
          }

          const alternativeJid = brazilianAlternativeJid(rawJid);
          if (alternativeJid && this.contactStore.has(alternativeJid)) {
            return alternativeJid;
          }
        }

        return rawJid;
      }).filter(Boolean)));
    } catch {
      return [];
    }
  }

  resolveChatLabelNames(chat: RawChat | null | undefined, labelsMap: Map<string, string>): string[] {
    const rawLabels = Array.isArray(chat?.labels) ? chat.labels : [];
    const ids = rawLabels
      .map(item => {
        if (typeof item === 'string' || typeof item === 'number') {
          return String(item);
        }
        if (item && typeof item === 'object') {
          const record = item as { id?: string | number; labelId?: string | number };
          if (record.id !== undefined && record.id !== null) {
            return String(record.id);
          }
          if (record.labelId !== undefined && record.labelId !== null) {
            return String(record.labelId);
          }
        }
        return '';
      })
      .filter(Boolean);

    const names = ids.map(id => labelsMap.get(id) || '').filter(Boolean);
    return Array.from(new Set(names));
  }

  private extractCanonicalJidFromContact(contact: RawContact | null | undefined, fallbackJid = ''): string {
    if (!contact) {
      return '';
    }

    if (contact.isMe === true) {
      return '';
    }

    const serialized = contact.id?._serialized || '';
    if (isPersonalJid(serialized)) {
      return this.selfJidResolver.isSelfJid(serialized) ? '' : serialized;
    }

    const lidUser = typeof contact.id?.user === 'string'
      ? contact.id.user
      : normalizePhone(fallbackJid);
    const number = typeof contact.number === 'string' ? contact.number.trim() : '';
    if (number.length < 8 || number === lidUser) {
      return '';
    }

    const canonicalJid = `${number}@c.us`;
    return this.selfJidResolver.isSelfJid(canonicalJid) ? '' : canonicalJid;
  }

  private isSelfContactEntry(jid: string, contact: Partial<ContactEntry> | null = null): boolean {
    if (this.selfJidResolver.isSelfJid(jid)) {
      return true;
    }

    const phone = typeof contact?.phone === 'string' && contact.phone.trim()
      ? contact.phone.trim()
      : normalizePhone(jid);

    return phone.length >= 8 && this.selfJidResolver.isSelfJid(`${phone}@c.us`);
  }

  private async resolveCanonicalJidForLinkedChat(chat: RawChat | null | undefined): Promise<string> {
    const lidJid = chat?.id?._serialized || '';
    if (!lidJid || !isLinkedId(lidJid)) {
      return '';
    }

    const knownCanonical = this.lidMap.findCanonical(lidJid);
    if (knownCanonical) {
      return knownCanonical;
    }

    const clientWithContact = this.client as WebJsClient & {
      getContactById?: (id: string) => Promise<RawContact>;
    };

    const resolvers: Array<() => Promise<RawContact>> = [];
    if (typeof chat?.getContact === 'function') {
      resolvers.push(() => chat.getContact!());
    }
    if (typeof clientWithContact.getContactById === 'function') {
      resolvers.push(() => clientWithContact.getContactById!(lidJid));
    }

    for (const resolveContact of resolvers) {
      try {
        const contact = await withTimeout(
          resolveContact(),
          LINKED_CHAT_CANONICAL_RESOLVE_TIMEOUT_MS,
          `resolveCanonicalJidForLinkedChat(${lidJid})`
        );
        const canonicalJid = this.extractCanonicalJidFromContact(contact, lidJid);
        if (canonicalJid) {
          this.lidMap.set(canonicalJid, lidJid);
          return canonicalJid;
        }
      } catch {
        // Fall through to the next resolution strategy.
      }
    }

    return '';
  }

  private async resolveRecentLinkedChatCanonicals(chats: RawChat[]): Promise<Map<string, string>> {
    const candidates = (chats || [])
      .filter(chat => !chat?.isGroup && isLinkedId(chat?.id?._serialized || ''))
      .sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0))
      .slice(0, LINKED_CHAT_CANONICAL_RESOLVE_LIMIT);

    const resolved = new Map<string, string>();
    if (!candidates.length) {
      return resolved;
    }

    let cursor = 0;

    const runWorker = async (): Promise<void> => {
      while (cursor < candidates.length) {
        const currentIndex = cursor;
        cursor += 1;

        const chat = candidates[currentIndex];
        const lidJid = chat?.id?._serialized || '';
        if (!lidJid) {
          continue;
        }

        const canonicalJid = await this.resolveCanonicalJidForLinkedChat(chat);
        if (canonicalJid) {
          resolved.set(lidJid, canonicalJid);
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(LINKED_CHAT_CANONICAL_RESOLVE_CONCURRENCY, candidates.length) },
        () => runWorker()
      )
    );

    return resolved;
  }

  async refreshContactsFromChats(preloadedChats: RawChat[] | null = null): Promise<void> {
    if (!this.sessionState.isReady()) {
      return;
    }

    const clientWithChats = this.client as WebJsClient & {
      getChats: () => Promise<RawChat[]>;
      getContacts: () => Promise<RawContact[]>;
    };

    const chatsPromise: Promise<RawChat[]> = preloadedChats
      ? Promise.resolve(preloadedChats)
      : clientWithChats.getChats();

    const contactsPromise: Promise<RawContact[]> = withTimeout(
      clientWithChats.getContacts(),
      CONTACTS_FETCH_TIMEOUT_MS,
      'getContacts'
    ).catch(err => {
      console.warn('[whatsapp-webjs-bridge] getContacts demorou demais, continuando só com dados dos chats:', (err as { message?: string } | null)?.message || String(err));
      return [] as RawContact[];
    });

    const [chats, contacts, labelsMap] = await Promise.all([
      chatsPromise,
      contactsPromise,
      this.loadLabelsMap()
    ]);
    const resolvedCanonicalByLid = await this.resolveRecentLinkedChatCanonicals(chats);
    this.lastContactsRefreshAt = Date.now();

    for (const [jid, existing] of this.contactStore.entries()) {
      this.contactStore.set(jid, {
        ...existing,
        fromGetChats: false,
        getChatsTimestampMs: 0
      });
    }

    contacts
      .filter(contact =>
        contact?.id?._serialized &&
        isPersonalOrLinkedJid(contact.id._serialized) &&
        contact.isMe === true
      )
      .forEach(contact => {
        const rawJid = contact.id!._serialized!;
        this.selfJidResolver.registerSelfJid(rawJid);

        if (isPersonalJid(rawJid)) {
          return;
        }

        const lidUser = typeof contact.id?.user === 'string' ? contact.id.user : normalizePhone(rawJid);
        const number = typeof contact.number === 'string' ? contact.number.trim() : '';
        if (number.length >= 8 && number !== lidUser) {
          this.selfJidResolver.registerSelfJid(`${number}@c.us`);
        }
      });

    contacts
      .filter(contact =>
        contact?.id?._serialized &&
        isPersonalOrLinkedJid(contact.id._serialized) &&
        contact.isMyContact === true &&
        contact.isMe !== true
      )
      .forEach(contact => {
        const rawJid = contact.id!._serialized!;

        const lidUser = typeof contact.id?.user === 'string' ? contact.id.user : normalizePhone(rawJid);

        let phone: string | null;
        if (isPersonalJid(rawJid)) {
          phone = normalizePhone(rawJid);
        } else {
          const num = typeof contact.number === 'string' ? contact.number.trim() : '';
          phone = (num.length >= 8 && num !== lidUser) ? num : null;
        }

        if (!phone) {
          return;
        }

        const canonicalJid = `${phone}@c.us`;
        if (!isValidPersonalJid(canonicalJid)) {
          return;
        }

        if (this.selfJidResolver.isSelfJid(canonicalJid)) {
          return;
        }

        const existing = this.contactStore.get(canonicalJid);
        const displayName = getContactName(contact);

        this.contactStore.set(canonicalJid, this.contactStore.createDefault(canonicalJid, {
          phone,
          name: displayName || existing?.name || phone,
          found: true,
          lastMessageAt: existing?.lastMessageAt ?? null,
          lastMessagePreview: existing?.lastMessagePreview ?? '',
          lastMessageFromMe: Boolean(existing?.lastMessageFromMe),
          lastMessageType: typeof existing?.lastMessageType === 'string' ? existing.lastMessageType : '',
          lastMessageHasMedia: Boolean(existing?.lastMessageHasMedia),
          lastMessageMediaMimetype: typeof existing?.lastMessageMediaMimetype === 'string' ? existing.lastMessageMediaMimetype : '',
          lastMessageAck: existing?.lastMessageAck ?? null,
          unreadCount: typeof existing?.unreadCount === 'number' ? existing.unreadCount : 0,
          labels: Array.isArray(existing?.labels) ? existing.labels : [],
          isGroup: false,
          fromGetChats: false,
          getChatsTimestampMs: 0
        }));

        if (isLinkedId(rawJid)) {
          this.lidMap.set(canonicalJid, rawJid);
        }
      });

    chats
      .filter(chat => !chat.isGroup
        && isValidPersonalJid(chat.id?._serialized)
        && !this.selfJidResolver.isSelfJid(chat.id?._serialized))
      .forEach(chat => {
        const serialized = chat.id?._serialized || '';
        if (!serialized) {
          return;
        }

        const phone = normalizePhone(serialized);

        let existing = this.contactStore.get(serialized);
        let canonicalKey = serialized;
        if (!existing?.found) {
          const altJid = brazilianAlternativeJid(serialized);
          if (altJid) {
            const altExisting = this.contactStore.get(altJid);
            if (altExisting?.found) {
              existing = altExisting;
              canonicalKey = altJid;
              this.contactStore.delete(altJid);
            }
          }
        }

        const displayName = chat.name && chat.name.trim() ? chat.name.trim() : '';
        const getChatsTimestampMs = typeof chat.timestamp === 'number' && chat.timestamp > 0
          ? chat.timestamp * 1000
          : (typeof existing?.getChatsTimestampMs === 'number' ? existing.getChatsTimestampMs : 0);
        const lastMessageAt = typeof chat.timestamp === 'number' && chat.timestamp > 0
          ? new Date(chat.timestamp * 1000).toISOString()
          : existing?.lastMessageAt || null;
        const unreadCount = typeof chat.unreadCount === 'number'
          ? chat.unreadCount
          : (typeof existing?.unreadCount === 'number' ? existing.unreadCount : 0);
        const labels = this.resolveChatLabelNames(chat, labelsMap);
        const lastMessagePreview = extractLastMessagePreview(chat) || existing?.lastMessagePreview || '';
        const lastMessageFromMe = chat?.lastMessage
          ? this.selfJidResolver.resolveIsFromMe(chat.lastMessage)
          : Boolean(existing?.lastMessageFromMe);
        const {
          lastMessageType,
          lastMessageHasMedia,
          lastMessageMediaMimetype
        } = resolveLastMessageMetadata(chat?.lastMessage, existing);

        this.contactStore.set(canonicalKey, this.contactStore.createDefault(canonicalKey, {
          phone: normalizePhone(canonicalKey),
          name: existing?.name || displayName || phone,
          found: true,
          lastMessageAt,
          lastMessagePreview,
          lastMessageFromMe,
          lastMessageType,
          lastMessageHasMedia,
          lastMessageMediaMimetype,
          lastMessageAck: existing?.lastMessageAck ?? null,
          unreadCount,
          labels,
          isGroup: false,
          fromGetChats: true,
          getChatsTimestampMs
        }));
      });

    chats
      .filter(chat => chat.isGroup && isGroupJid(chat.id?._serialized))
      .forEach(chat => {
        const serialized = chat.id?._serialized || '';
        if (!serialized) {
          return;
        }

        const existing = this.contactStore.get(serialized);
        const getChatsTimestampMs = typeof chat.timestamp === 'number' && chat.timestamp > 0
          ? chat.timestamp * 1000
          : (typeof existing?.getChatsTimestampMs === 'number' ? existing.getChatsTimestampMs : 0);
        const lastMessageAt = typeof chat.timestamp === 'number' && chat.timestamp > 0
          ? new Date(chat.timestamp * 1000).toISOString()
          : existing?.lastMessageAt || null;
        const unreadCount = typeof chat.unreadCount === 'number'
          ? chat.unreadCount
          : (typeof existing?.unreadCount === 'number' ? existing.unreadCount : 0);
        const labels = this.resolveChatLabelNames(chat, labelsMap);
        const lastMessagePreview = extractLastMessagePreview(chat) || existing?.lastMessagePreview || '';
        const lastMessageFromMe = chat?.lastMessage
          ? this.selfJidResolver.resolveIsFromMe(chat.lastMessage)
          : Boolean(existing?.lastMessageFromMe);
        const {
          lastMessageType,
          lastMessageHasMedia,
          lastMessageMediaMimetype
        } = resolveLastMessageMetadata(chat?.lastMessage, existing);

        this.contactStore.set(serialized, this.contactStore.createDefault(serialized, {
          phone: normalizePhone(serialized),
          name: (chat.name && chat.name.trim()) || existing?.name || 'Grupo',
          found: true,
          lastMessageAt,
          lastMessagePreview,
          lastMessageFromMe,
          lastMessageType,
          lastMessageHasMedia,
          lastMessageMediaMimetype,
          lastMessageAck: existing?.lastMessageAck ?? null,
          unreadCount,
          labels,
          isGroup: true,
          fromGetChats: true,
          getChatsTimestampMs
        }));
      });

    const canonicalByLid = new Map<string, string>();
    for (const [canonicalJid, lidJid] of this.lidMap.entries()) {
      canonicalByLid.set(lidJid, canonicalJid);
    }
    for (const [lidJid, canonicalJid] of resolvedCanonicalByLid.entries()) {
      canonicalByLid.set(lidJid, canonicalJid);
    }

    chats
      .filter(chat => !chat.isGroup && isLinkedId(chat.id?._serialized))
      .forEach(chat => {
        const lidJid = chat.id?._serialized || '';
        if (!lidJid) {
          return;
        }

        const canonicalKey = canonicalByLid.get(lidJid) || lidJid;
        const existing = this.contactStore.get(canonicalKey) || this.contactStore.get(lidJid);

        if (canonicalKey !== lidJid && this.contactStore.has(lidJid)) {
          this.contactStore.delete(lidJid);
        }

        const getChatsTimestampMs = typeof chat.timestamp === 'number' && chat.timestamp > 0
          ? chat.timestamp * 1000
          : (typeof existing?.getChatsTimestampMs === 'number' ? existing.getChatsTimestampMs : 0);
        const lastMessageAt = typeof chat.timestamp === 'number' && chat.timestamp > 0
          ? new Date(chat.timestamp * 1000).toISOString()
          : existing?.lastMessageAt || null;
        const unreadCount = typeof chat.unreadCount === 'number'
          ? chat.unreadCount
          : (typeof existing?.unreadCount === 'number' ? existing.unreadCount : 0);
        const labels = this.resolveChatLabelNames(chat, labelsMap);
        const lastMessagePreview = extractLastMessagePreview(chat) || existing?.lastMessagePreview || '';
        const lastMessageFromMe = chat?.lastMessage
          ? this.selfJidResolver.resolveIsFromMe(chat.lastMessage)
          : Boolean(existing?.lastMessageFromMe);
        const {
          lastMessageType,
          lastMessageHasMedia,
          lastMessageMediaMimetype
        } = resolveLastMessageMetadata(chat?.lastMessage, existing);
        const displayName = chat.name && chat.name.trim() ? chat.name.trim() : '';
        const resolvedPhone = isLinkedId(canonicalKey) ? '' : normalizePhone(canonicalKey);

        if (!isLinkedId(canonicalKey) && !isValidPersonalJid(canonicalKey)) {
          this.contactStore.delete(lidJid);
          if (canonicalKey !== lidJid) {
            this.contactStore.delete(canonicalKey);
          }
          return;
        }

        if (this.isSelfContactEntry(canonicalKey, { phone: resolvedPhone })) {
          this.contactStore.delete(lidJid);
          if (canonicalKey !== lidJid) {
            this.contactStore.delete(canonicalKey);
          }
          return;
        }

        this.contactStore.set(canonicalKey, this.contactStore.createDefault(canonicalKey, {
          phone: resolvedPhone,
          name: existing?.name || displayName || resolvedPhone || normalizePhone(canonicalKey),
          found: true,
          lastMessageAt,
          lastMessagePreview,
          lastMessageFromMe,
          lastMessageType,
          lastMessageHasMedia,
          lastMessageMediaMimetype,
          lastMessageAck: existing?.lastMessageAck ?? null,
          unreadCount,
          labels,
          isGroup: false,
          fromGetChats: true,
          getChatsTimestampMs
        }));
      });

    for (const [jid, existing] of this.contactStore.entries()) {
      if (isPersonalJid(jid) && !isValidPersonalJid(jid)) {
        this.contactStore.delete(jid);
        continue;
      }

      if (this.isSelfContactEntry(jid, existing)) {
        this.contactStore.delete(jid);
      }
    }

    for (const [canonicalJid] of this.lidMap.entries()) {
      if (this.selfJidResolver.isSelfJid(canonicalJid)) {
        this.lidMap.delete(canonicalJid);
      }
    }

    for (const [jid, existing] of this.contactStore.entries()) {
      if (existing.fromGetChats) {
        continue;
      }

      this.contactStore.set(jid, {
        ...existing,
        lastMessageAt: null,
        lastMessagePreview: '',
        lastMessageFromMe: false,
        lastMessageAck: null,
        lastMessageType: '',
        lastMessageHasMedia: false,
        lastMessageMediaMimetype: '',
        unreadCount: 0,
        labels: []
      });
    }
  }

  triggerRefresh(options: { preloadedChats?: RawChat[] | null; reason?: string } = {}): Promise<void> {
    if (this.contactsRefreshPromise) {
      return this.contactsRefreshPromise;
    }

    const { preloadedChats = null, reason = 'unspecified' } = options;

    this.contactsRefreshPromise = (async () => {
      try {
        await withTimeout(
          this.refreshContactsFromChats(preloadedChats),
          CONTACTS_REFRESH_TIMEOUT_MS,
          `refreshing contacts (${reason})`
        );
        if (this.onContactsUpdated) {
          try {
            this.onContactsUpdated(this.contactStore.values());
          } catch (err) {
            console.warn('[whatsapp-webjs-bridge] onContactsUpdated listener falhou:', (err as { message?: string } | null)?.message || String(err));
          }
        }
      } catch (error) {
        console.warn('[whatsapp-webjs-bridge] Falha ao atualizar contatos:', (error as { message?: string } | null)?.message || String(error));
      } finally {
        this.contactsRefreshPromise = null;
      }
    })();

    return this.contactsRefreshPromise;
  }

  async waitForContactsWarmup(waitForRefresh: boolean): Promise<void> {
    const isCacheEmpty = this.contactStore.size === 0;
    const shouldRefresh = this.sessionState.isReady()
      && (isCacheEmpty || Date.now() - this.lastContactsRefreshAt >= CONTACTS_REFRESH_COOLDOWN_MS);

    if (shouldRefresh) {
      const refreshPromise = this.triggerRefresh({ reason: 'contacts-endpoint' });
      if (waitForRefresh) {
        try {
          await withTimeout(refreshPromise, CONTACTS_REFRESH_TIMEOUT_MS, 'waiting contacts refresh');
        } catch {
          // Fall back to current cache if refresh is still running or timed out.
        }
      } else if (isCacheEmpty) {
        try {
          await withTimeout(refreshPromise, CONTACTS_EMPTY_CACHE_WAIT_MS, 'warming contacts cache');
        } catch {
          // Return immediately with current cache if warm-up is still in progress.
        }
      }
      return;
    }

    if (waitForRefresh && this.contactsRefreshPromise) {
      try {
        await withTimeout(this.contactsRefreshPromise, CONTACTS_REFRESH_TIMEOUT_MS, 'waiting contacts refresh');
      } catch {
        // Fall back to current cache if refresh is still running or timed out.
      }
    }
  }

  private async downloadAsDataUrl(url: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': 'image/*,*/*;q=0.8'
        },
        signal: controller.signal
      });
      if (!response.ok) {
        console.log('[whatsapp-webjs-bridge] download não-OK:', response.status, response.statusText);
        return null;
      }
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const buffer = await response.arrayBuffer();
      if (!buffer || buffer.byteLength === 0) {
        return null;
      }
      const base64 = Buffer.from(buffer).toString('base64');
      return `data:${contentType};base64,${base64}`;
    } catch (err) {
      console.log('[whatsapp-webjs-bridge] erro no download:', (err as { message?: string } | null)?.message || String(err));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async tryGetPhotoDataUrlFromPage(targetId: string): Promise<string | null> {
    const clientWithPage = this.client as WebJsClientWithInternals;
    if (!clientWithPage.pupPage || !targetId) {
      return null;
    }

    try {
      return await withTimeout(
        clientWithPage.pupPage.evaluate(async (candidateId: unknown) => {
          const readAsDataUrl = (blob: Blob): Promise<string | null> => new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
            reader.readAsDataURL(blob);
          });

          try {
            const store = (window as unknown as {
              Store?: {
                WidFactory?: { createWid?: (id: string) => unknown };
                ProfilePicThumb?: {
                  get?: (wid: unknown) => { img?: string; eurl?: string } | null;
                  find?: (wid: unknown) => Promise<{ img?: string; eurl?: string } | null>;
                };
                ProfilePic?: {
                  requestProfilePicFromServer?: (wid: unknown) => Promise<{ img?: string; eurl?: string } | null>;
                  profilePicFind?: (wid: unknown) => Promise<{ img?: string; eurl?: string } | null>;
                };
              };
              WWebJS?: {
                getProfilePicThumbToBase64?: (wid: unknown) => Promise<string | null>;
              };
            }).Store;
            const wWebJs = (window as unknown as {
              WWebJS?: {
                getProfilePicThumbToBase64?: (wid: unknown) => Promise<string | null>;
              };
            }).WWebJS;

            const chatWid = store?.WidFactory?.createWid
              ? store.WidFactory.createWid(String(candidateId))
              : candidateId;

            let profilePic: { img?: string; eurl?: string } | null = null;
            if (store?.ProfilePicThumb?.get) {
              profilePic = store.ProfilePicThumb.get(chatWid) || null;
            }
            if (!profilePic && store?.ProfilePicThumb?.find) {
              try {
                profilePic = await store.ProfilePicThumb.find(chatWid);
              } catch {
                profilePic = null;
              }
            }

            if (!profilePic && store?.ProfilePic) {
              try {
                profilePic = typeof store.ProfilePic.requestProfilePicFromServer === 'function'
                  ? await store.ProfilePic.requestProfilePicFromServer(chatWid)
                  : (typeof store.ProfilePic.profilePicFind === 'function'
                    ? await store.ProfilePic.profilePicFind(chatWid)
                    : null);
              } catch {
                profilePic = null;
              }
            }

            const imageUrl = profilePic?.img || profilePic?.eurl || null;
            if (imageUrl) {
              try {
                const response = await fetch(imageUrl);
                if (response.ok) {
                  const blob = await response.blob();
                  if (blob && blob.size > 0) {
                    return await readAsDataUrl(blob);
                  }
                }
              } catch {
                // fall through to helper fallback
              }
            }

            if (wWebJs?.getProfilePicThumbToBase64) {
              const base64 = await wWebJs.getProfilePicThumbToBase64(chatWid);
              if (typeof base64 === 'string' && base64.length > 0) {
                return `data:image/jpeg;base64,${base64}`;
              }
            }

            return null;
          } catch {
            return null;
          }
        }, targetId),
        12000,
        `getProfilePicThumbToBase64(${targetId})`
      );
    } catch (err) {
      console.log('[whatsapp-webjs-bridge] fallback no navegador falhou para', targetId, '-', (err as { message?: string } | null)?.message || String(err));
      return null;
    }
  }

  private async tryGetPhotoUrlForId(targetId: string): Promise<string | null> {
    if (!targetId) {
      return null;
    }

    const clientWithPhotos = this.client as WebJsClient & {
      getProfilePicUrl: (id: string) => Promise<string | undefined>;
      getContactById: (id: string) => Promise<RawContact>;
    };

    try {
      const url = await withTimeout(
        clientWithPhotos.getProfilePicUrl(targetId),
        8000,
        `getProfilePicUrl(${targetId})`
      );
      if (typeof url === 'string' && url.length > 0) {
        return url;
      }
    } catch (err) {
      console.log('[whatsapp-webjs-bridge] client.getProfilePicUrl falhou para', targetId, '-', (err as { message?: string } | null)?.message || String(err));
    }

    try {
      const contact = await withTimeout(
        clientWithPhotos.getContactById(targetId),
        8000,
        `getContactById(${targetId})`
      );
      if (contact && typeof contact.getProfilePicUrl === 'function') {
        const url = await withTimeout(
          contact.getProfilePicUrl(),
          8000,
          `contact.getProfilePicUrl(${targetId})`
        );
        if (typeof url === 'string' && url.length > 0) {
          return url;
        }
      }
    } catch (err) {
      console.log('[whatsapp-webjs-bridge] getContactById fallback falhou para', targetId, '-', (err as { message?: string } | null)?.message || String(err));
    }

    return null;
  }

  private async findLidByPhoneLookup(phoneJid: string): Promise<string | null> {
    if (!isPersonalJid(phoneJid)) {
      return null;
    }
    const targetPhone = normalizePhone(phoneJid);
    if (!targetPhone) {
      return null;
    }

    const clientWithContacts = this.client as WebJsClient & {
      getContacts: () => Promise<RawContact[]>;
    };

    try {
      const contacts = await clientWithContacts.getContacts();
      for (const contact of contacts) {
        const rawJid = contact?.id?._serialized;
        if (!isLinkedId(rawJid)) continue;
        const num = typeof contact.number === 'string' ? contact.number.trim() : '';
        const lidUser = typeof contact.id?.user === 'string' ? contact.id.user : '';
        if (num && num === targetPhone && num !== lidUser) {
          this.lidMap.set(phoneJid, rawJid);
          return rawJid;
        }
      }
    } catch (err) {
      console.log('[whatsapp-webjs-bridge] falha ao varrer contatos para LID:', (err as { message?: string } | null)?.message || String(err));
    }
    return null;
  }

  async fetchProfilePhotoUrl(jid: string): Promise<string | null> {
    const isGroup = isGroupJid(jid);
    if (!this.sessionState.isReady() || (!isGroup && !isPersonalOrLinkedJid(jid))) {
      return null;
    }

    const cached = this.photosByJid.get(jid);
    if (cached && Date.now() - cached.fetchedAt < PHOTO_TTL_MS) {
      return cached.url;
    }

    if (!this.options.enableProfilePhotoFetch) {
      this.photosByJid.set(jid, { url: null, fetchedAt: Date.now() });
      return null;
    }

    const candidates: string[] = [];
    const knownCanonical = isLinkedId(jid) ? this.lidMap.findCanonical(jid) : '';
    if (knownCanonical) {
      candidates.push(knownCanonical);
    }

    if (!candidates.includes(jid)) {
      candidates.push(jid);
    }

    const knownLid = isGroup ? '' : (isPersonalJid(jid) ? this.lidMap.getLid(jid) : '');
    if (knownLid && !candidates.includes(knownLid)) {
      candidates.push(knownLid);
    }

    let externalUrl: string | null = null;
    let usedCandidate: string | null = null;

    for (const candidate of candidates) {
      externalUrl = await this.tryGetPhotoUrlForId(candidate);
      if (externalUrl) {
        usedCandidate = candidate;
        break;
      }
    }

    if (!externalUrl && isPersonalJid(jid) && !knownLid) {
      const discoveredLid = await this.findLidByPhoneLookup(jid);
      if (discoveredLid) {
        candidates.push(discoveredLid);
        externalUrl = await this.tryGetPhotoUrlForId(discoveredLid);
        if (externalUrl) {
          usedCandidate = discoveredLid;
        }
      }
    }

    let dataUrl: string | null = null;
    if (externalUrl) {
      console.log('[whatsapp-webjs-bridge] foto obtida para', jid, 'via', usedCandidate, '— baixando...');
      dataUrl = await this.downloadAsDataUrl(externalUrl);
      if (!dataUrl) {
        console.log('[whatsapp-webjs-bridge] falha ao baixar foto de', jid, externalUrl.slice(0, 100));
      }
    }

    if (!dataUrl) {
      const pageCandidates = usedCandidate
        ? [usedCandidate, ...candidates.filter(candidate => candidate !== usedCandidate)]
        : candidates;

      for (const candidate of pageCandidates) {
        dataUrl = await this.tryGetPhotoDataUrlFromPage(candidate);
        if (dataUrl) {
          usedCandidate = candidate;
          console.log('[whatsapp-webjs-bridge] foto obtida no navegador para', jid, 'via', usedCandidate);
          break;
        }
      }
    }

    if (!dataUrl) {
      console.log('[whatsapp-webjs-bridge] fallback de navegador sem foto para', jid, '(candidatos:', candidates.join(', ') + ')');
      this.photosByJid.set(jid, { url: null, fetchedAt: Date.now() });
      return null;
    }

    this.photosByJid.set(jid, { url: dataUrl, fetchedAt: Date.now() });
    return dataUrl;
  }
}
