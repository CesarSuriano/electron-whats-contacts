import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

import { Cliente } from '../../../../models/cliente.model';
import { RECURRENCE_LABELS, ScheduledMessage } from '../../../../models/scheduled-message.model';

@Component({
  selector: 'app-home-dashboard-section',
  templateUrl: './home-dashboard-section.component.html',
  styleUrls: ['./home-dashboard-section.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class HomeDashboardSectionComponent {
  @Input() greetingLabel = '';
  @Input() greetingDateLabel = '';
  @Input() birthdaysToday: Cliente[] = [];
  @Input() pendingSchedules: ScheduledMessage[] = [];
  @Input() unreadConversations = 0;
  @Input() clientesCount = 0;
  @Input() clientesAddedThisWeek = 0;

  @Output() openClients = new EventEmitter<void>();
  @Output() openBirthday = new EventEmitter<Cliente>();
  @Output() openScheduleList = new EventEmitter<void>();
  @Output() goToWhatsapp = new EventEmitter<void>();
  @Output() openMessages = new EventEmitter<void>();

  get clientesCountLabel(): string {
    return this.clientesCount.toLocaleString('pt-BR');
  }

  formatScheduleTimestamp(isoDate: string): string {
    const date = new Date(isoDate);

    if (!Number.isFinite(date.getTime())) {
      return 'Horario indefinido';
    }

    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }

  formatScheduleContacts(schedule: ScheduledMessage): string {
    const count = schedule.contacts.length;
    return `${count} contato${count === 1 ? '' : 's'} • ${RECURRENCE_LABELS[schedule.recurrence]}`;
  }

  getClienteInitials(name: string): string {
    const tokens = name
      .split(' ')
      .map(token => token.trim())
      .filter(Boolean)
      .slice(0, 2);

    return tokens.map(token => token[0]?.toUpperCase() ?? '').join('');
  }

  emitOpenClients(): void {
    this.openClients.emit();
  }

  emitOpenBirthday(cliente: Cliente): void {
    this.openBirthday.emit(cliente);
  }

  emitOpenScheduleList(): void {
    this.openScheduleList.emit();
  }

  emitGoToWhatsapp(): void {
    this.goToWhatsapp.emit();
  }

  emitOpenMessages(): void {
    this.openMessages.emit();
  }
}