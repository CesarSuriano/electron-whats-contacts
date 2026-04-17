export type ScheduleRecurrence = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface ScheduledContact {
  jid: string;
  name: string;
  phone: string;
}

export interface ScheduledMessage {
  id: string;
  scheduledAt: string;
  recurrence: ScheduleRecurrence;
  template: string;
  imageDataUrl?: string;
  contacts: ScheduledContact[];
  status: 'pending' | 'notified' | 'done' | 'cancelled';
  createdAt: string;
  lastTriggeredAt?: string;
}

export const RECURRENCE_LABELS: Record<ScheduleRecurrence, string> = {
  none: 'Não repetir',
  daily: 'Diariamente',
  weekly: 'Semanalmente',
  monthly: 'Mensalmente',
  yearly: 'Anualmente'
};
