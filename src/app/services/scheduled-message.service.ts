import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { ScheduledMessage, ScheduleRecurrence } from '../models/scheduled-message.model';

const STORAGE_KEY = 'uniq-system.scheduled-messages';
const CHECK_INTERVAL_MS = 60_000;
const NOTIFY_BEFORE_MS = 30 * 60_000;

@Injectable({ providedIn: 'root' })
export class ScheduledMessageService implements OnDestroy {
  private readonly schedulesSubject = new BehaviorSubject<ScheduledMessage[]>([]);
  private checkTimer: number | null = null;
  private readonly upcomingSubject = new BehaviorSubject<ScheduledMessage | null>(null);
  private readonly executingScheduleIds = new Set<string>();

  schedules$: Observable<ScheduledMessage[]> = this.schedulesSubject.asObservable();

  pending$: Observable<ScheduledMessage[]> = this.schedulesSubject.pipe(
    map(list => list.filter(s => s.status === 'pending'))
  );

  upcoming$: Observable<ScheduledMessage | null> = this.upcomingSubject.asObservable();

  constructor() {
    this.restore();
    this.startChecking();
  }

  ngOnDestroy(): void {
    this.stopChecking();
  }

  getAll(): ScheduledMessage[] {
    return this.schedulesSubject.value;
  }

  getById(id: string): ScheduledMessage | null {
    return this.schedulesSubject.value.find(s => s.id === id) ?? null;
  }

  create(schedule: Omit<ScheduledMessage, 'id' | 'createdAt' | 'status'>): ScheduledMessage {
    const entry: ScheduledMessage = {
      ...schedule,
      id: this.generateId(),
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    const list = [...this.schedulesSubject.value, entry];
    this.setSchedules(list);
    return entry;
  }

  update(id: string, patch: Partial<Pick<ScheduledMessage, 'scheduledAt' | 'recurrence' | 'template' | 'imageDataUrl' | 'contacts'>>): void {
    const list = this.schedulesSubject.value.map(s =>
      s.id === id ? { ...s, ...patch } : s
    );
    this.setSchedules(list);
  }

  remove(id: string): void {
    this.executingScheduleIds.delete(id);
    this.setSchedules(this.schedulesSubject.value.filter(s => s.id !== id));
    if (this.upcomingSubject.value?.id === id) {
      this.upcomingSubject.next(null);
    }
  }

  beginExecution(id: string): void {
    const schedule = this.getById(id);
    if (!schedule) {
      return;
    }

    this.executingScheduleIds.add(id);

    if (schedule.status === 'notified') {
      const list = this.schedulesSubject.value.map(s =>
        s.id === id ? { ...s, status: 'pending' as const } : s
      );
      this.setSchedules(list);
    }

    if (this.upcomingSubject.value?.id === id) {
      this.upcomingSubject.next(null);
    }
  }

  completeExecution(id: string): void {
    this.executingScheduleIds.delete(id);
    this.markDone(id);
  }

  cancelExecution(id: string): void {
    this.executingScheduleIds.delete(id);

    if (this.upcomingSubject.value?.id === id) {
      this.upcomingSubject.next(null);
    }
  }

  markDone(id: string): void {
    const schedule = this.getById(id);
    if (!schedule) return;

    if (schedule.recurrence === 'none') {
      const list = this.schedulesSubject.value.map(s =>
        s.id === id ? { ...s, status: 'done' as const, lastTriggeredAt: new Date().toISOString() } : s
      );
      this.setSchedules(list);
    } else {
      const nextDate = this.computeNextOccurrence(schedule.scheduledAt, schedule.recurrence);
      const list = this.schedulesSubject.value.map(s =>
        s.id === id ? { ...s, scheduledAt: nextDate, status: 'pending' as const, lastTriggeredAt: new Date().toISOString() } : s
      );
      this.setSchedules(list);
    }

    if (this.upcomingSubject.value?.id === id) {
      this.upcomingSubject.next(null);
    }
  }

  dismissNotification(id: string): void {
    const list = this.schedulesSubject.value.map(s =>
      s.id === id && s.status === 'notified' ? { ...s, status: 'pending' as const } : s
    );
    this.setSchedules(list);
    if (this.upcomingSubject.value?.id === id) {
      this.upcomingSubject.next(null);
    }
  }

  snoozeNotification(id: string, snoozeMs = 5 * 60_000): void {
    const now = new Date(Date.now() + snoozeMs).toISOString();
    const list = this.schedulesSubject.value.map(s =>
      s.id === id ? { ...s, scheduledAt: now, status: 'pending' as const } : s
    );
    this.setSchedules(list);
    if (this.upcomingSubject.value?.id === id) {
      this.upcomingSubject.next(null);
    }
  }

  private checkUpcoming(): void {
    const now = Date.now();
    const schedules = this.schedulesSubject.value;

    for (const schedule of schedules) {
      if (schedule.status !== 'pending' || this.executingScheduleIds.has(schedule.id)) continue;

      const targetMs = new Date(schedule.scheduledAt).getTime();
      if (!Number.isFinite(targetMs)) continue;

      const diff = targetMs - now;
      if (diff <= NOTIFY_BEFORE_MS && diff > -CHECK_INTERVAL_MS) {
        const list = schedules.map(s =>
          s.id === schedule.id ? { ...s, status: 'notified' as const } : s
        );
        this.setSchedules(list);
        this.upcomingSubject.next({ ...schedule, status: 'notified' });
        return;
      }
    }

    if (this.upcomingSubject.value) {
      const still = this.schedulesSubject.value.find(s => s.id === this.upcomingSubject.value!.id && s.status === 'notified');
      if (!still) {
        this.upcomingSubject.next(null);
      }
    }
  }

  private computeNextOccurrence(currentIso: string, recurrence: ScheduleRecurrence): string {
    const date = new Date(currentIso);
    switch (recurrence) {
      case 'daily':
        date.setDate(date.getDate() + 1);
        break;
      case 'weekly':
        date.setDate(date.getDate() + 7);
        break;
      case 'monthly':
        date.setMonth(date.getMonth() + 1);
        break;
      case 'yearly':
        date.setFullYear(date.getFullYear() + 1);
        break;
    }
    return date.toISOString();
  }

  private generateId(): string {
    return `sch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private setSchedules(list: ScheduledMessage[]): void {
    this.schedulesSubject.next(list);
    this.persist(list);
  }

  private persist(list: ScheduledMessage[]): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch { /* ignore */ }
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as ScheduledMessage[];
      if (Array.isArray(parsed)) {
        const restored = parsed.map(s =>
          s.status === 'notified' ? { ...s, status: 'pending' as const } : s
        );
        this.schedulesSubject.next(restored);
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  private startChecking(): void {
    this.checkUpcoming();
    this.checkTimer = window.setInterval(() => this.checkUpcoming(), CHECK_INTERVAL_MS);
  }

  private stopChecking(): void {
    if (this.checkTimer !== null) {
      window.clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }
}
