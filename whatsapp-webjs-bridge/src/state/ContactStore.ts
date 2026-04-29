import type { ContactEntry } from '../domain/types.js';
import { isGroupJid } from '../utils/jid.js';
import { normalizePhone } from '../utils/phone.js';

export interface OutboundContactUpdate {
  jid: string;
  preview: string;
  receivedAt: string;
  type?: string;
  hasMedia?: boolean;
  mediaMimetype?: string;
}

export class ContactStore {
  private readonly byJid = new Map<string, ContactEntry>();

  get size(): number {
    return this.byJid.size;
  }

  entries(): IterableIterator<[string, ContactEntry]> {
    return this.byJid.entries();
  }

  values(): ContactEntry[] {
    return Array.from(this.byJid.values());
  }

  get(jid: string): ContactEntry | undefined {
    return this.byJid.get(jid);
  }

  set(jid: string, entry: ContactEntry): void {
    this.byJid.set(jid, entry);
  }

  has(jid: string): boolean {
    return this.byJid.has(jid);
  }

  delete(jid: string): boolean {
    return this.byJid.delete(jid);
  }

  createDefault(jid: string, overrides: Partial<ContactEntry> = {}): ContactEntry {
    const phone = normalizePhone(jid);
    return {
      jid,
      phone,
      name: phone || jid,
      found: true,
      lastMessageAt: null,
      lastMessagePreview: '',
      lastMessageFromMe: false,
      lastMessageType: '',
      lastMessageHasMedia: false,
      lastMessageMediaMimetype: '',
      lastMessageAck: null,
      unreadCount: 0,
      labels: [],
      isGroup: isGroupJid(jid),
      fromGetChats: false,
      getChatsTimestampMs: 0,
      ...overrides
    };
  }

  resetUnreadCount(chatJid: string): void {
    const existing = this.byJid.get(chatJid);
    if (existing) {
      this.byJid.set(chatJid, { ...existing, unreadCount: 0 });
    }
  }

  updateLastMessageAck(chatJid: string, ack: number): void {
    const existing = this.byJid.get(chatJid);
    if (existing && existing.lastMessageFromMe) {
      this.byJid.set(chatJid, { ...existing, lastMessageAck: ack });
    }
  }

  upsertOnOutbound(update: OutboundContactUpdate): ContactEntry {
    const { jid, preview, receivedAt, type = '', hasMedia = false, mediaMimetype = '' } = update;
    const timestampMs = Date.parse(receivedAt) || Date.now();
    const existing = this.byJid.get(jid);

    const entry: ContactEntry = existing
      ? {
          ...existing,
          lastMessageAt: receivedAt,
          lastMessagePreview: preview,
          lastMessageFromMe: true,
          lastMessageType: type || existing.lastMessageType,
          lastMessageHasMedia: hasMedia,
          lastMessageMediaMimetype: mediaMimetype || existing.lastMessageMediaMimetype,
          lastMessageAck: 0,
          fromGetChats: true,
          getChatsTimestampMs: timestampMs
        }
      : this.createDefault(jid, {
          lastMessageAt: receivedAt,
          lastMessagePreview: preview,
          lastMessageFromMe: true,
          lastMessageType: type,
          lastMessageHasMedia: hasMedia,
          lastMessageMediaMimetype: mediaMimetype,
          lastMessageAck: 0,
          fromGetChats: true,
          getChatsTimestampMs: timestampMs
        });

    this.byJid.set(jid, entry);
    return entry;
  }

  clear(): void {
    this.byJid.clear();
  }
}
