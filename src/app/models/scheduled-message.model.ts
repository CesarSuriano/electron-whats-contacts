export type ScheduleRecurrence = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface ScheduledContact {
  jid: string;
  name: string;
  phone: string;
}

// Progresso de um envio em massa que foi substituído por outro antes de terminar.
// `contacts` do agendamento guarda apenas quem ainda falta receber.
export interface InterruptedBulkInfo {
  interruptedAt: string;
  sentCount: number;
  totalCount: number;
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
  interruptedBulk?: InterruptedBulkInfo;
}

export interface InterruptedBulkInput {
  template: string;
  imageDataUrls?: string[];
  remainingContacts: ScheduledContact[];
  processedCount: number;
  totalCount: number;
  // Agendamento que originou a fila interrompida, se houver.
  sourceScheduleId?: string;
}

export function isInterruptedBulk(schedule: ScheduledMessage): boolean {
  return Boolean(schedule.interruptedBulk);
}

export const RECURRENCE_LABELS: Record<ScheduleRecurrence, string> = {
  none: 'Não repetir',
  daily: 'Diariamente',
  weekly: 'Semanalmente',
  monthly: 'Mensalmente',
  yearly: 'Anualmente'
};
