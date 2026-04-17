import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';

import { ScheduleRecurrence, RECURRENCE_LABELS } from '../../models/scheduled-message.model';

export interface ScheduleResult {
  scheduledAt: string;
  recurrence: ScheduleRecurrence;
}

@Component({
  selector: 'app-schedule-modal',
  templateUrl: './schedule-modal.component.html',
  styleUrls: ['./schedule-modal.component.scss']
})
export class ScheduleModalComponent implements OnChanges {
  @Input() isOpen = false;
  @Input() initialDate = '';
  @Input() initialRecurrence: ScheduleRecurrence = 'none';
  @Output() close = new EventEmitter<void>();
  @Output() confirm = new EventEmitter<ScheduleResult>();

  dateValue = '';
  timeValue = '';
  recurrence: ScheduleRecurrence = 'none';
  minDate = '';

  recurrenceOptions: { value: ScheduleRecurrence; label: string }[] = [
    { value: 'none', label: RECURRENCE_LABELS.none },
    { value: 'daily', label: RECURRENCE_LABELS.daily },
    { value: 'weekly', label: RECURRENCE_LABELS.weekly },
    { value: 'monthly', label: RECURRENCE_LABELS.monthly },
    { value: 'yearly', label: RECURRENCE_LABELS.yearly }
  ];

  ngOnChanges(): void {
    if (this.isOpen) {
      const now = new Date();
      this.minDate = this.toDateString(now);

      if (this.initialDate) {
        const d = new Date(this.initialDate);
        this.dateValue = this.toDateString(d);
        this.timeValue = this.toTimeString(d);
      } else {
        now.setHours(now.getHours() + 1, 0, 0, 0);
        this.dateValue = this.toDateString(now);
        this.timeValue = this.toTimeString(now);
      }

      this.recurrence = this.initialRecurrence || 'none';
    }
  }

  get isValid(): boolean {
    return Boolean(this.dateValue && this.timeValue);
  }

  get scheduledAtPreview(): string {
    if (!this.dateValue || !this.timeValue) return '';
    const d = this.buildDate();
    return d.toLocaleString('pt-BR', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  onConfirm(): void {
    if (!this.isValid) return;
    const d = this.buildDate();
    this.confirm.emit({
      scheduledAt: d.toISOString(),
      recurrence: this.recurrence
    });
  }

  private buildDate(): Date {
    const [y, m, d] = this.dateValue.split('-').map(Number);
    const [h, min] = this.timeValue.split(':').map(Number);
    return new Date(y, m - 1, d, h, min);
  }

  private toDateString(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private toTimeString(d: Date): string {
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }
}
