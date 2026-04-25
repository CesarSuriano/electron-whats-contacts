export interface WhatsappInstance {
  name: string;
  token: string;
  connected: boolean;
  jid: string;
  webhook: string;
}

export interface WhatsappContact {
  jid: string;
  phone: string;
  name: string;
  found: boolean;
  photoUrl?: string | null;
  lastMessageAt?: string | null;
  lastMessagePreview?: string;
  lastMessageFromMe?: boolean;
  lastMessageAck?: number | null;
  lastMessageType?: string;
  lastMessageHasMedia?: boolean;
  lastMessageMediaMimetype?: string;
  unreadCount?: number;
  labels?: string[];
  isGroup?: boolean;
  fromGetChats?: boolean;
  getChatsTimestampMs?: number;
}

export interface WhatsappEvent {
  id: string;
  source: string;
  receivedAt: string;
  isFromMe: boolean;
  chatJid: string;
  phone: string;
  text: string;
  ack?: number | null;
  payload: unknown;
}

export interface WhatsappMessage {
  id: string;
  contactJid: string;
  text: string;
  sentAt: string;
  isFromMe: boolean;
  source: string;
  ack?: number | null;
  payload?: Record<string, unknown>;
}

export const enum MessageAck {
  ERROR = -1,
  PENDING = 0,
  SERVER = 1,
  DEVICE = 2,
  READ = 3,
  PLAYED = 4
}

export interface WhatsappMediaUpload {
  file: File;
  caption?: string;
}

export interface WhatsappLabel {
  id: string;
  name: string;
  hexColor?: string;
  chatJids?: string[];
}
