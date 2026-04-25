import type { Client as WebJsClient } from 'whatsapp-web.js';

export type SessionStatus =
  | 'initializing'
  | 'qr_required'
  | 'authenticated'
  | 'ready'
  | 'auth_failure'
  | 'disconnected'
  | 'init_error';

export interface SessionSnapshot {
  instanceName: string;
  status: SessionStatus;
  jid: string;
  hasQr: boolean;
  qr: string | null;
  lastError: string;
}

export interface InstanceSummary {
  name: string;
  token: string;
  connected: boolean;
  jid: string;
  webhook: string;
}

export interface WhatsappEventPayload {
  id: string;
  timestamp: number;
  type?: string;
  hasMedia?: boolean;
  mediaMimetype?: string;
  mediaFilename?: string;
  mediaDataUrl?: string | null;
  ack?: number | null;
}

export interface WhatsappEvent {
  id: string;
  source: string;
  receivedAt: string;
  isFromMe: boolean;
  chatJid: string;
  phone: string;
  text: string;
  ack: number | null;
  payload: WhatsappEventPayload;
}

export interface ContactEntry {
  jid: string;
  phone: string;
  name: string;
  found: boolean;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  lastMessageFromMe: boolean;
  lastMessageType: string;
  lastMessageHasMedia: boolean;
  lastMessageMediaMimetype: string;
  lastMessageAck: number | null;
  unreadCount: number;
  labels: string[];
  isGroup: boolean;
  fromGetChats: boolean;
  getChatsTimestampMs: number;
}

export interface WhatsappLabel {
  id: string;
  name: string;
  hexColor: string | null;
  chatJids?: string[];
}

export interface HistoryDiagnostics {
  chatId?: string;
  chatName?: string;
  fetchMessagesCount?: number;
  fetchMessagesError?: string;
  syncHistoryAttempted?: boolean;
  syncFetchCount?: number;
  syncHistoryError?: string;
  resolvedChatId?: string;
  refreshFetchCount?: number;
  refreshError?: string;
  storeFallbackAttempted?: boolean;
  storeFallbackCount?: number;
  storeFallbackError?: string;
  fatalError?: string;
  finalSource?: string;
  finalCount?: number;
  resultCount?: number;
}

/**
 * Permissive representation of a whatsapp-web.js message as it is seen at
 * runtime — the library's exported types exclude several fields that the
 * underlying store actually carries (_data, mediaDataUrl, isNotification, etc.),
 * so we model only what we actually read.
 */
export interface RawJid {
  _serialized?: string;
  user?: string;
  server?: string;
  remote?: RawJid | string;
  fromMe?: boolean;
}

export interface RawMessage {
  id?: RawJid | string;
  body?: string;
  caption?: string;
  timestamp?: number;
  t?: number;
  msgTimestamp?: number;
  fromMe?: boolean | number | string;
  from?: string;
  to?: string;
  author?: string;
  type?: string;
  hasMedia?: boolean;
  ack?: number;
  isNotification?: boolean;
  isMedia?: boolean;
  mediaData?: unknown;
  isMMS?: boolean;
  mimetype?: string;
  mediaDataUrl?: string;
  chatId?: RawJid | string;
  chat?: { id?: RawJid | string };
  _data?: {
    mimetype?: string;
    filename?: string;
    body?: string;
    t?: number;
    from?: RawJid | string;
    to?: RawJid | string;
  };
  downloadMedia?: () => Promise<{ data?: string; mimetype?: string } | null>;
  getContact?: () => Promise<RawContact>;
}

export interface RawContact {
  id?: RawJid;
  name?: string;
  pushname?: string;
  shortName?: string;
  number?: string;
  isMe?: boolean;
  isMyContact?: boolean;
  getProfilePicUrl?: () => Promise<string | undefined>;
}

export interface RawChat {
  id?: RawJid;
  name?: string;
  isGroup?: boolean;
  timestamp?: number;
  unreadCount?: number;
  lastMessage?: RawMessage;
  labels?: Array<string | number | { id?: string | number; labelId?: string | number }>;
  fetchMessages?: (options: { limit: number }) => Promise<RawMessage[]>;
  sendSeen?: () => Promise<boolean>;
  syncHistory?: () => Promise<boolean>;
  getContact?: () => Promise<RawContact>;
  msgs?: unknown;
}

export type AckCallback = (event: { messageId: string; ack: number }) => void;
export type EventPushedCallback = (event: WhatsappEvent) => void;
export type ContactsUpdatedCallback = (contacts: ContactEntry[]) => void;
export type SessionStateCallback = (snapshot: SessionSnapshot) => void;

export interface WhatsappEventListeners {
  onEventPushed?: EventPushedCallback;
  onAck?: AckCallback;
  onContactsUpdated?: ContactsUpdatedCallback;
  onSessionState?: SessionStateCallback;
}

export type { WebJsClient };
