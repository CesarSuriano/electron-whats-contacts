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
  imageDataUrls?: string[];
  // Compatibilidade com agendamentos antigos salvos antes do suporte a múltiplas imagens.
  imageDataUrl?: string;
  contacts: ScheduledContact[];
  status: 'pending' | 'notified' | 'done' | 'cancelled';
  createdAt: string;
  lastTriggeredAt?: string;
  reminderDismissedForScheduledAt?: string;
}

export const RECURRENCE_LABELS: Record<ScheduleRecurrence, string> = {
  none: 'Não repetir',
  daily: 'Diariamente',
  weekly: 'Semanalmente',
  monthly: 'Mensalmente',
  yearly: 'Anualmente'
};
