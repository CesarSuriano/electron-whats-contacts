import { Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { BulkItem, BulkQueue, BulkSendService } from '../../services/bulk-send.service';

@Component({
  selector: 'app-bulk-task-panel',
  templateUrl: './bulk-task-panel.component.html',
  styleUrls: ['./bulk-task-panel.component.scss']
})
export class BulkTaskPanelComponent implements OnInit, OnDestroy {
  queue: BulkQueue | null = null;
  isMinimized = false;

  private destroy$ = new Subject<void>();

  constructor(private bulkSend: BulkSendService) {}

  ngOnInit(): void {
    this.bulkSend.queue$.pipe(takeUntil(this.destroy$)).subscribe(queue => {
      this.queue = queue;
      if (!queue) {
        this.isMinimized = false;
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

  pause(): void {
    this.bulkSend.pause();
  }

  resume(): void {
    this.bulkSend.resume();
  }

  skip(): void {
    this.bulkSend.skipCurrent();
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (!this.queue || this.queue.isPaused || this.isMinimized) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.skip();
    }
  }

  cancel(): void {
    const confirmed = window.confirm('Cancelar o envio em massa? O progresso atual será descartado.');
    if (confirmed) {
      this.bulkSend.cancel();
    }
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
}
