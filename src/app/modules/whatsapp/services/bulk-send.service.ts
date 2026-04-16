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
  items: BulkItem[];
  isPaused: boolean;
  createdAt: string;
}

const STORAGE_KEY = 'uniq-system.whatsapp.bulk-queue';

@Injectable({ providedIn: 'root' })
export class BulkSendService implements OnDestroy {
  private readonly queueSubject = new BehaviorSubject<BulkQueue | null>(null);
  private readonly destroy$ = new Subject<void>();
  private sentSubscription: Subscription | null = null;

  queue$: Observable<BulkQueue | null> = this.queueSubject.asObservable();

  constructor(private state: WhatsappStateService) {
    this.restoreQueue();
    this.listenMessageSent();
  }

  ngOnDestroy(): void {
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

  start(contacts: WhatsappContact[], template: string, imageDataUrl?: string): void {
    if (!contacts.length || !template.trim()) {
      return;
    }

    const queue: BulkQueue = {
      template,
      imageDataUrl,
      items: contacts.map(contact => ({
        jid: contact.jid,
        name: contact.name || contact.phone,
        status: 'pending'
      })),
      isPaused: false,
      createdAt: new Date().toISOString()
    };

    this.setQueue(queue);
    this.advanceToNext();
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
    this.updateCurrent('skipped');
    this.advanceToNext();
  }

  cancel(): void {
    this.setQueue(null);
    this.state.setDraftText('');
    this.state.setDraftImageDataUrl(null);
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

    this.state.selectContact(current.jid);
    this.state.setDraftText(renderBulkTemplate(queue.template, current.name));
    this.state.setDraftImageDataUrl(queue.imageDataUrl ?? null);
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
    this.setQueue(null);
    this.state.setDraftText('');
    this.state.setDraftImageDataUrl(null);
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
        if (!current || current.jid !== event.jid) {
          return;
        }

        this.updateCurrent('done');
        this.advanceToNext();
      });
  }

  private setQueue(queue: BulkQueue | null): void {
    this.queueSubject.next(queue);
    this.persistQueue(queue);
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
