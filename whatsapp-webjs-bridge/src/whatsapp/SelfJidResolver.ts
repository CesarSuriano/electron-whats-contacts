import type { Client as WebJsClient } from 'whatsapp-web.js';
import type { RawJid, RawMessage } from '../domain/types.js';
import { normalizeJid } from '../utils/jid.js';
import { isSamePhoneJid, isValidPersonalJid } from '../utils/jid.js';

export class SelfJidResolver {
  private readonly knownSelfJids = new Set<string>();

  constructor(private readonly client: WebJsClient) {}

  private static serializeWidLike(value: unknown): string {
    if (!value) {
      return '';
    }

    if (typeof value === 'string') {
      return normalizeJid(value);
    }

    if (typeof value === 'object' && value !== null) {
      const raw = value as RawJid;
      if (typeof raw._serialized === 'string') {
        return normalizeJid(raw._serialized);
      }

      const user = typeof raw.user === 'string' ? raw.user.trim() : '';
      const server = typeof raw.server === 'string' ? raw.server.trim() : '';
      if (user && server) {
        return normalizeJid(`${user}@${server}`);
      }
    }

    return '';
  }

  private listOwnJids(): string[] {
    const info = (this.client as WebJsClient & { info?: { wid?: unknown; me?: unknown; user?: unknown } }).info;
    const candidates = [
      SelfJidResolver.serializeWidLike(info?.wid),
      SelfJidResolver.serializeWidLike(info?.me),
      SelfJidResolver.serializeWidLike(info?.user)
    ];

    for (const jid of this.knownSelfJids) {
      candidates.push(SelfJidResolver.serializeWidLike(jid));
    }

    return Array.from(new Set(candidates.filter(Boolean)));
  }

  getOwnJid(): string {
    const ownJids = this.listOwnJids();
    return ownJids.find(isValidPersonalJid) || ownJids[0] || '';
  }

  registerSelfJid(jid: string | RawJid | null | undefined): void {
    const normalized = SelfJidResolver.serializeWidLike(jid);
    if (normalized) {
      this.knownSelfJids.add(normalized);
    }
  }

  clearKnownSelfJids(): void {
    this.knownSelfJids.clear();
  }

  getSerializedMessageId(message: RawMessage | null | undefined): string {
    const rawId = message?.id;
    if (!rawId) {
      return '';
    }

    if (typeof rawId === 'string') {
      return rawId;
    }

    if (typeof rawId._serialized === 'string') {
      return rawId._serialized;
    }

    return '';
  }

  resolveIsFromMe(message: RawMessage | null | undefined): boolean {
    if (!message) {
      return false;
    }

    const id = message.id;
    if (id && typeof id !== 'string' && typeof id.fromMe === 'boolean') {
      return id.fromMe;
    }

    const serializedId = this.getSerializedMessageId(message);
    if (serializedId.startsWith('true_')) {
      return true;
    }
    if (serializedId.startsWith('false_')) {
      return false;
    }

    const fromMe = message.fromMe;
    if (typeof fromMe === 'boolean') {
      return fromMe;
    }
    if (typeof fromMe === 'number') {
      return fromMe === 1;
    }
    if (typeof fromMe === 'string') {
      const normalized = fromMe.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1') {
        return true;
      }
      if (normalized === 'false' || normalized === '0') {
        return false;
      }
    }

    const ownJids = this.listOwnJids();
    if (!ownJids.length) {
      return false;
    }

    const from = typeof message.from === 'string' ? message.from : '';
    const author = typeof message.author === 'string' ? message.author : '';
    return ownJids.some(ownJid => isSamePhoneJid(from, ownJid) || isSamePhoneJid(author, ownJid));
  }

  isSelfJid(jid: string | null | undefined): boolean {
    const ownJids = this.listOwnJids();
    if (!ownJids.length || !jid) {
      return false;
    }

    return ownJids.some(ownJid => isSamePhoneJid(ownJid, jid));
  }
}
