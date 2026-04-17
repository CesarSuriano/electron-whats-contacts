import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';

import { ScheduledMessage } from '../../models/scheduled-message.model';

@Component({
  selector: 'app-schedule-notification',
  templateUrl: './schedule-notification.component.html',
  styleUrls: ['./schedule-notification.component.scss']
})
export class ScheduleNotificationComponent implements OnChanges {
  @Input() schedule: ScheduledMessage | null = null;
  @Output() action = new EventEmitter<ScheduledMessage>();
  @Output() dismiss = new EventEmitter<string>();
  @Output() snooze = new EventEmitter<string>();

  showConfirm = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['schedule']) {
      this.showConfirm = false;
    }
  }

  get timeLabel(): string {
    if (!this.schedule) return '';
    const d = new Date(this.schedule.scheduledAt);
    return d.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  get contactCount(): number {
    return this.schedule?.contacts?.length || 0;
  }

  onAction(): void {
    if (this.schedule) {
      this.action.emit(this.schedule);
    }
  }

  onDismiss(): void {
    if (this.schedule) {
      this.showConfirm = false;
      this.dismiss.emit(this.schedule.id);
    }
  }

  onSnooze(): void {
    if (this.schedule) {
      this.showConfirm = false;
      this.snooze.emit(this.schedule.id);
    }
  }
}
