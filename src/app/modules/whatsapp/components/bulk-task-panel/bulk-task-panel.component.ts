import { Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { BulkItem, BulkQueue, BulkSendService } from '../../services/bulk-send.service';

const MAX_VISIBLE_ITEMS = 18;

@Component({
  selector: 'app-bulk-task-panel',
  templateUrl: './bulk-task-panel.component.html',
  styleUrls: ['./bulk-task-panel.component.scss']
})
export class BulkTaskPanelComponent implements OnInit, OnDestroy {
  queue: BulkQueue | null = null;
  isMinimized = false;
  visibleItems: BulkItem[] = [];
  hiddenItemCount = 0;
  isCancelConfirmOpen = false;

  private destroy$ = new Subject<void>();

  constructor(private bulkSend: BulkSendService) {}

  ngOnInit(): void {
    this.bulkSend.queue$.pipe(takeUntil(this.destroy$)).subscribe(queue => {
      this.queue = queue;
      this.updateVisibleItems(queue);
      if (!queue) {
        this.isMinimized = false;
        this.isCancelConfirmOpen = false;
      }
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  get progress(): { done: number; total: number; percent: number } {
    if (!this.queue) {
      return { done: 0, total: 0, percent: 0 };
    }
    const total = this.queue.items.length;
    const done = this.queue.items.filter(item => item.status === 'done' || item.status === 'skipped').length;
    const percent = total === 0 ? 0 : Math.round((done / total) * 100);
    return { done, total, percent };
  }

  toggleMinimize(): void {
    this.isMinimized = !this.isMinimized;
  }

  get canSendCurrent(): boolean {
    return this.bulkSend.canSendCurrent;
  }

  get isSendingCurrent(): boolean {
    return this.bulkSend.isSendingCurrent;
  }

  send(): void {
    this.bulkSend.sendCurrent();
  }

  pause(): void {
    this.bulkSend.pause();
  }

  resume(): void {
    this.bulkSend.resume();
  }

  skip(): void {
    this.bulkSend.skipCurrent();
  }

  togglePauseResume(): void {
    if (!this.queue) {
      return;
    }

    if (this.queue.isPaused) {
      this.resume();
      return;
    }

    this.pause();
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (!this.queue || this.isMinimized) {
      return;
    }

    if (event.key === 'Escape' && this.isCancelConfirmOpen) {
      event.preventDefault();
      this.dismissCancel();
      return;
    }

    if ((event.key === 'Enter' || event.key === 'NumpadEnter') && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (this.isCancelConfirmOpen || this.queue.isPaused || !this.canSendCurrent || this.isInteractiveShortcutTarget(event.target)) {
        return;
      }

      event.preventDefault();
      this.send();
    }
  }

  cancel(): void {
    if (this.isSendingCurrent) {
      return;
    }
    this.isCancelConfirmOpen = true;
  }

  confirmCancel(): void {
    this.isCancelConfirmOpen = false;
    this.bulkSend.cancel();
  }

  dismissCancel(): void {
    this.isCancelConfirmOpen = false;
  }

  statusIcon(item: BulkItem): string {
    switch (item.status) {
      case 'done':    return 'check_circle';
      case 'current': return 'play_circle';
      case 'skipped': return 'skip_next';
      case 'error':   return 'error';
      default:        return 'circle';
    }
  }

  trackByJid(_: number, item: BulkItem): string {
    return item.jid;
  }

  private updateVisibleItems(queue: BulkQueue | null): void {
    if (!queue) {
      this.visibleItems = [];
      this.hiddenItemCount = 0;
      return;
    }

    if (queue.items.length <= MAX_VISIBLE_ITEMS) {
      this.visibleItems = queue.items;
      this.hiddenItemCount = 0;
      return;
    }

    const currentIndex = queue.items.findIndex(item => item.status === 'current');
    const pendingIndex = queue.items.findIndex(item => item.status === 'pending');
    const anchorIndex = currentIndex >= 0 ? currentIndex : pendingIndex >= 0 ? pendingIndex : queue.items.length - 1;
    const before = 6;

    let start = Math.max(0, anchorIndex - before);
    let end = Math.min(queue.items.length, start + MAX_VISIBLE_ITEMS);
    start = Math.max(0, end - MAX_VISIBLE_ITEMS);

    this.visibleItems = queue.items.slice(start, end);
    this.hiddenItemCount = queue.items.length - this.visibleItems.length;
  }

  private isInteractiveShortcutTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element) {
      return false;
    }

    const tagName = element.tagName;
    return tagName === 'INPUT'
      || tagName === 'TEXTAREA'
      || tagName === 'SELECT'
      || tagName === 'BUTTON'
      || tagName === 'A'
      || element.isContentEditable;
  }
}
