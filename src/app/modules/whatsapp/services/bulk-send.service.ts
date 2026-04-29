import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable, Subject, Subscription } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';

import { WhatsappContact } from '../../../models/whatsapp.model';
import { renderBulkTemplate } from '../helpers/bulk-message.helper';
import { WhatsappStateService } from './whatsapp-state.service';

export type BulkItemStatus = 'pending' | 'current' | 'done' | 'skipped' | 'error';

export interface BulkItem {
  jid: string;
  name: string;
  status: BulkItemStatus;
  errorMessage?: string;
}

export interface BulkQueue {
  template: string;
  imageDataUrl?: string;
  scheduleId?: string;
  items: BulkItem[];
  isPaused: boolean;
  createdAt: string;
}

export interface BulkStartOptions {
  scheduleId?: string;
}

export interface BulkScheduleLifecycleEvent {
  scheduleId: string;
  outcome: 'completed' | 'cancelled';
}

const STORAGE_KEY = 'uniq-system.whatsapp.bulk-queue';
const QUEUE_PERSIST_DEBOUNCE_MS = 120;
const POST_SEND_DELAY_MS = 500;

@Injectable({ providedIn: 'root' })
export class BulkSendService implements OnDestroy {
  private readonly queueSubject = new BehaviorSubject<BulkQueue | null>(null);
  private readonly destroy$ = new Subject<void>();
  private readonly scheduleLifecycleSubject = new Subject<BulkScheduleLifecycleEvent>();
  private sentSubscription: Subscription | null = null;
  private persistTimerId: number | null = null;
  private pendingPersistQueue: BulkQueue | null = null;
  private readonly draftStateJids = new Set<string>();
  private postSendDelayTimerId: number | null = null;

  queue$: Observable<BulkQueue | null> = this.queueSubject.asObservable();
  scheduleLifecycle$: Observable<BulkScheduleLifecycleEvent> = this.scheduleLifecycleSubject.asObservable();

  constructor(private state: WhatsappStateService) {
    this.restoreQueue();
    this.listenMessageSent();
  }

  ngOnDestroy(): void {
    this.clearPostSendDelay();
    this.flushPendingPersist();
    this.destroy$.next();
    this.destroy$.complete();
    this.sentSubscription?.unsubscribe();
  }

  get currentItem(): BulkItem | null {
    const queue = this.queueSubject.value;
    return queue?.items.find(item => item.status === 'current') || null;
  }

  get hasActiveQueue(): boolean {
    return Boolean(this.queueSubject.value);
  }

  get isSendingCurrent(): boolean {
    return this.state.isSending || this.postSendDelayTimerId !== null;
  }

  get canSendCurrent(): boolean {
    const queue = this.queueSubject.value;
    const current = this.currentItem;
    if (!queue || queue.isPaused || !current || this.isSendingCurrent) {
      return false;
    }

    const currentJid = this.resolveQueueItemJid(current.jid);

    return !!this.state.getDraftTextForJid(currentJid).trim() || !!this.resolveCurrentImageDataUrl(currentJid, queue);
  }

  start(contacts: WhatsappContact[], template: string, imageDataUrl?: string, options: BulkStartOptions = {}): void {
    if (!contacts.length || !template.trim()) {
      return;
    }

    this.clearPostSendDelay();
    this.clearDraftStateForJids(Array.from(this.draftStateJids));

    const queue: BulkQueue = {
      template,
      imageDataUrl,
      scheduleId: options.scheduleId,
      items: contacts.map((contact, index) => ({
        jid: contact.jid,
        name: contact.name || contact.phone,
        status: index === 0 ? 'current' : 'pending'
      })),
      isPaused: false,
      createdAt: new Date().toISOString()
    };

    this.setQueue(queue);
    this.openCurrent();
  }

  pause(): void {
    const queue = this.queueSubject.value;
    if (!queue || queue.isPaused) {
      return;
    }
    this.setQueue({ ...queue, isPaused: true });
  }

  resume(): void {
    const queue = this.queueSubject.value;
    if (!queue || !queue.isPaused) {
      return;
    }
    this.setQueue({ ...queue, isPaused: false });

    if (!this.currentItem) {
      this.advanceToNext();
    } else {
      this.openCurrent();
    }
  }

  skipCurrent(): void {
    if (this.isSendingCurrent) {
      return;
    }

    const current = this.currentItem;
    const currentJid = current ? this.resolveQueueItemJid(current.jid) : '';

    this.updateCurrent('skipped');
    this.clearDraftStateForJids(currentJid ? [currentJid] : []);
    this.advanceToNext();
  }

  sendCurrent(): void {
    const queue = this.queueSubject.value;
    const current = this.currentItem;
    if (!queue || queue.isPaused || !current || this.isSendingCurrent) {
      return;
    }

    const currentJid = this.resolveQueueItemJid(current.jid);
    const caption = this.state.getDraftTextForJid(currentJid).trim();
    const imageDataUrl = this.resolveCurrentImageDataUrl(currentJid, queue);

    if (imageDataUrl) {
      const file = this.dataUrlToFile(imageDataUrl);
      if (!file) {
        return;
      }

      this.state.sendMedia(currentJid, file, caption).subscribe({
        next: () => {},
        error: () => {}
      });
      return;
    }

    if (!caption) {
      return;
    }

    this.state.sendText(currentJid, caption).subscribe({
      next: () => {},
      error: () => {}
    });
  }

  cancel(): void {
    const queue = this.queueSubject.value;
    if (this.isSendingCurrent) {
      return;
    }

    if (!queue) {
      return;
    }

    this.clearQueueDraftState();
    this.setQueue(null);

    if (queue.scheduleId) {
      this.scheduleLifecycleSubject.next({ scheduleId: queue.scheduleId, outcome: 'cancelled' });
    }
  }

  private openCurrent(): void {
    const current = this.currentItem;
    if (!current) {
      return;
    }

    const queue = this.queueSubject.value;
    if (!queue) {
      return;
    }

    const currentJid = this.resolveQueueItemJid(current.jid);

    if (this.state.selectedContactJid !== currentJid) {
      void this.state.selectContact(currentJid, { loadHistory: false, markAsRead: false });
    }

    this.state.setDraftTextForJid(currentJid, renderBulkTemplate(queue.template, current.name));
    this.state.setDraftImageDataUrlForJid(currentJid, queue.imageDataUrl ?? null);
    this.draftStateJids.add(currentJid);
  }

  private resolveCurrentImageDataUrl(jid: string, queue: BulkQueue): string | null {
    return queue.imageDataUrl ?? this.state.getDraftImageDataUrlForJid(jid);
  }

  private resolveQueueItemJid(jid: string): string {
    return this.state.resolveConversationJid(jid);
  }

  private dataUrlToFile(dataUrl: string): File | null {
    try {
      const commaIndex = dataUrl.indexOf(',');
      if (commaIndex === -1) {
        return null;
      }

      const header = dataUrl.slice(0, commaIndex);
      const base64Data = dataUrl.slice(commaIndex + 1);
      const mimeMatch = header.match(/:(.*?);/);
      const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
      const byteString = atob(base64Data);
      const bytes = new Uint8Array(byteString.length);

      for (let index = 0; index < byteString.length; index += 1) {
        bytes[index] = byteString.charCodeAt(index);
      }

      const extension = this.detectExtensionFromMime(mime);
      return new File([bytes], `bulk-template.${extension}`, { type: mime });
    } catch {
      return null;
    }
  }

  private detectExtensionFromMime(mime: string): string {
    const subtype = mime.split('/')[1] || 'bin';
    const normalized = subtype.split(';')[0].toLowerCase();
    if (normalized === 'jpeg') {
      return 'jpg';
    }
    return normalized.includes('+') ? normalized.split('+')[0] : normalized;
  }

  private advanceToNext(): void {
    const queue = this.queueSubject.value;
    if (!queue) {
      return;
    }

    if (queue.isPaused) {
      return;
    }

    const nextIndex = queue.items.findIndex(item => item.status === 'pending');
    if (nextIndex === -1) {
      this.finishQueue();
      return;
    }

    const items = queue.items.map((item, index) =>
      index === nextIndex ? { ...item, status: 'current' as BulkItemStatus } : item
    );

    this.setQueue({ ...queue, items });
    this.openCurrent();
  }

  private finishQueue(): void {
    const queue = this.queueSubject.value;
    if (queue) {
      this.clearQueueDraftState();
    }

    this.setQueue(null);

    if (queue?.scheduleId) {
      this.scheduleLifecycleSubject.next({ scheduleId: queue.scheduleId, outcome: 'completed' });
    }
  }

  private updateCurrent(status: BulkItemStatus, errorMessage?: string): void {
    const queue = this.queueSubject.value;
    if (!queue) {
      return;
    }

    const items = queue.items.map(item =>
      item.status === 'current' ? { ...item, status, errorMessage } : item
    );

    this.setQueue({ ...queue, items });
  }

  private listenMessageSent(): void {
    this.sentSubscription = this.state.messageSent$
      .pipe(
        takeUntil(this.destroy$),
        filter((event): event is { jid: string; at: number } => event !== null)
      )
      .subscribe(event => {
        const current = this.currentItem;
        const currentJid = current ? this.resolveQueueItemJid(current.jid) : '';
        if (!current || currentJid !== event.jid) {
          return;
        }

        this.updateCurrent('done');
        this.clearDraftStateForJids([currentJid]);
        this.startPostSendDelay();
      });
  }

  private startPostSendDelay(): void {
    this.clearPostSendDelay();
    this.postSendDelayTimerId = window.setTimeout(() => {
      this.postSendDelayTimerId = null;
      this.advanceToNext();
    }, POST_SEND_DELAY_MS);
  }

  private clearPostSendDelay(): void {
    if (this.postSendDelayTimerId === null) {
      return;
    }

    window.clearTimeout(this.postSendDelayTimerId);
    this.postSendDelayTimerId = null;
  }

  private setQueue(queue: BulkQueue | null): void {
    this.queueSubject.next(queue);
    this.schedulePersist(queue);
  }

  private clearQueueDraftState(): void {
    this.clearDraftStateForJids(Array.from(this.draftStateJids));
  }

  private clearDraftStateForJids(jids: string[]): void {
    if (!jids.length) {
      return;
    }

    this.state.clearDraftTextsForJids(jids);
    this.state.clearDraftImageDataUrlsForJids(jids);
    jids.forEach(jid => this.draftStateJids.delete(jid));
  }

  private schedulePersist(queue: BulkQueue | null): void {
    this.pendingPersistQueue = queue;

    if (this.persistTimerId !== null) {
      window.clearTimeout(this.persistTimerId);
      this.persistTimerId = null;
    }

    if (!queue) {
      this.persistQueue(null);
      return;
    }

    this.persistTimerId = window.setTimeout(() => {
      const snapshot = this.pendingPersistQueue;
      this.persistTimerId = null;
      this.persistQueue(snapshot);
    }, QUEUE_PERSIST_DEBOUNCE_MS);
  }

  private flushPendingPersist(): void {
    if (this.persistTimerId === null) {
      return;
    }

    window.clearTimeout(this.persistTimerId);
    this.persistTimerId = null;
    this.persistQueue(this.pendingPersistQueue);
  }

  private persistQueue(queue: BulkQueue | null): void {
    try {
      if (!queue) {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
    } catch {
      // ignore persistence errors
    }
  }

  private restoreQueue(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as BulkQueue;
      if (!parsed || !Array.isArray(parsed.items) || !parsed.template) {
        return;
      }

      const restored: BulkQueue = {
        ...parsed,
        isPaused: true,
        items: parsed.items.map(item =>
          item.status === 'current' ? { ...item, status: 'pending' } : item
        )
      };

      this.queueSubject.next(restored);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
}
