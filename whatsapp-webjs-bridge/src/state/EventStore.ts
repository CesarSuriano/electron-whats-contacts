import { randomUUID } from 'crypto';
import type { EventPushedCallback, WhatsappEvent, WhatsappEventPayload } from '../domain/types.js';
import { normalizePhone } from '../utils/phone.js';

const MAX_EVENTS = 200;
const MAX_RECENT_EVENT_IDS = 2000;

export interface PushEventInput {
  id?: string;
  source: string;
  isFromMe: boolean;
  chatJid: string;
  text?: string;
  payload: WhatsappEventPayload;
  receivedAt?: string;
}

export class EventStore {
  private readonly _events: WhatsappEvent[] = [];
  private readonly recentEventIds = new Set<string>();
  private readonly recentEventIdQueue: string[] = [];
  private readonly eventAckById = new Map<string, number>();
  private onEventPushed: EventPushedCallback | null = null;

  setOnEventPushed(callback: EventPushedCallback | null): void {
    this.onEventPushed = callback;
  }

  get events(): readonly WhatsappEvent[] {
    return this._events;
  }

  snapshot(limit = MAX_EVENTS): WhatsappEvent[] {
    return this._events.slice(0, limit);
  }

  trackEventId(eventId: string | null | undefined): void {
    if (!eventId || this.recentEventIds.has(eventId)) {
      return;
    }

    this.recentEventIds.add(eventId);
    this.recentEventIdQueue.push(eventId);

    if (this.recentEventIdQueue.length > MAX_RECENT_EVENT_IDS) {
      const removed = this.recentEventIdQueue.shift();
      if (removed) {
        this.recentEventIds.delete(removed);
      }
    }
  }

  pushEvent(input: PushEventInput): WhatsappEvent | null {
    const resolvedId = typeof input.id === 'string' && input.id.trim().length > 0
      ? input.id.trim()
      : randomUUID();

    if (this.recentEventIds.has(resolvedId)) {
      return null;
    }

    const ack = typeof input.payload?.ack === 'number' ? input.payload.ack : null;

    const event: WhatsappEvent = {
      id: resolvedId,
      source: input.source,
      receivedAt: typeof input.receivedAt === 'string' && input.receivedAt
        ? input.receivedAt
        : new Date().toISOString(),
      isFromMe: Boolean(input.isFromMe),
      chatJid: input.chatJid,
      phone: normalizePhone(input.chatJid),
      text: typeof input.text === 'string' ? input.text : '',
      ack,
      payload: input.payload
    };

    this._events.unshift(event);
    this.trackEventId(event.id);
    if (ack !== null) {
      this.eventAckById.set(resolvedId, ack);
    }
    if (this._events.length > MAX_EVENTS) {
      this._events.length = MAX_EVENTS;
    }

    if (this.onEventPushed) {
      try {
        this.onEventPushed(event);
      } catch {
        // Silent — listener failures must not affect state.
      }
    }

    return event;
  }

  updateEventAck(messageId: string | null | undefined, ack: number): void {
    if (!messageId) return;

    this.eventAckById.set(messageId, ack);

    const event = this._events.find(e => e.id === messageId);
    if (event) {
      event.ack = ack;
      if (event.payload && typeof event.payload === 'object') {
        event.payload.ack = ack;
      }
    }
  }

  getEventAck(messageId: string): number | null {
    return this.eventAckById.get(messageId) ?? null;
  }

  /** Returns the chatJid of the event with that id, if any. Used for ack propagation. */
  getEventChatJid(messageId: string): string | null {
    const event = this._events.find(e => e.id === messageId);
    return event ? event.chatJid : null;
  }
}
