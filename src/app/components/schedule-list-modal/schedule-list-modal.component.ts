import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';

import {
  ScheduledMessage,
  ScheduledContact,
  ScheduleRecurrence,
  RECURRENCE_LABELS
} from '../../models/scheduled-message.model';
import { WhatsappContact } from '../../models/whatsapp.model';

export interface ScheduleEditRequest {
  schedule: ScheduledMessage;
  mode: 'edit-message' | 'edit-schedule';
}

export interface ScheduleCreateRequest {
  scheduledAt: string;
  recurrence: ScheduleRecurrence;
  contacts: ScheduledContact[];
}

@Component({
  selector: 'app-schedule-list-modal',
  templateUrl: './schedule-list-modal.component.html',
  styleUrls: ['./schedule-list-modal.component.scss']
})
export class ScheduleListModalComponent implements OnChanges {
  @Input() isOpen = false;
  @Input() schedules: ScheduledMessage[] = [];
  @Input() availableContacts: WhatsappContact[] = [];
  @Input() contactsLoading = false;
  @Output() close = new EventEmitter<void>();
  @Output() createNew = new EventEmitter<ScheduleCreateRequest>();
  @Output() editSchedule = new EventEmitter<ScheduleEditRequest>();
  @Output() deleteSchedule = new EventEmitter<string>();

  view: 'list' | 'edit' = 'list';
  editingSchedule: ScheduledMessage | null = null;

  contactSearch = '';
  editDate = '';
  editTime = '';
  editRecurrence: ScheduleRecurrence = 'none';
  editSelectedJids = new Set<string>();
  contactInputFocused = false;

  recurrenceOptions: { value: ScheduleRecurrence; label: string }[] = [
    { value: 'none', label: RECURRENCE_LABELS.none },
    { value: 'daily', label: RECURRENCE_LABELS.daily },
    { value: 'weekly', label: RECURRENCE_LABELS.weekly },
    { value: 'monthly', label: RECURRENCE_LABELS.monthly },
    { value: 'yearly', label: RECURRENCE_LABELS.yearly }
  ];

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isOpen'] && this.isOpen) {
      this.view = 'list';
      this.editingSchedule = null;
    }
  }

  get showAutocomplete(): boolean {
    return this.contactInputFocused && !!this.contactSearch.trim() && (!!this.autocompleteResults.length || !!this.autocompleteMessage);
  }

  get autocompleteMessage(): string {
    const term = this.contactSearch.trim();
    if (!term) {
      return '';
    }

    if (this.contactsLoading && this.availableContacts.length === 0) {
      return 'Carregando contatos do WhatsApp...';
    }

    if (!this.autocompleteResults.length && this.availableContacts.length === 0) {
      return 'Nenhum contato do WhatsApp foi carregado ainda.';
    }

    if (!this.autocompleteResults.length) {
      return 'Nenhum contato encontrado.';
    }

    return '';
  }

  onContactInputFocus(): void {
    this.contactInputFocused = true;
  }

  onContactInputBlur(): void {
    setTimeout(() => { this.contactInputFocused = false; }, 200);
  }

  get pendingSchedules(): ScheduledMessage[] {
    return this.schedules
      .filter(s => s.status === 'pending' || s.status === 'notified')
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  }

  get doneSchedules(): ScheduledMessage[] {
    return this.schedules
      .filter(s => s.status === 'done' || s.status === 'cancelled')
      .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))
      .slice(0, 20);
  }

  get autocompleteResults(): WhatsappContact[] {
    const term = this.contactSearch.trim().toLowerCase();
    if (!term) return [];
    const digits = term.replace(/\D/g, '');
    return this.availableContacts
      .filter(c => !c.isGroup && !this.editSelectedJids.has(c.jid))
      .filter(c => {
        if ((c.name || '').toLowerCase().includes(term)) return true;
        const phone = (c.phone || '').replace(/\D/g, '');
        if (digits && (phone.includes(digits) || phone.replace(/^55/, '').includes(digits))) return true;
        return false;
      })
      .slice(0, 10);
  }

  get selectedContactsList(): { jid: string; name: string; phone: string }[] {
    const result: { jid: string; name: string; phone: string }[] = [];
    for (const jid of this.editSelectedJids) {
      const found = this.availableContacts.find(c => c.jid === jid);
      if (found) {
        result.push({ jid: found.jid, name: found.name, phone: found.phone });
      } else if (this.editingSchedule) {
        const sc = this.editingSchedule.contacts.find(c => c.jid === jid);
        if (sc) {
          result.push({ jid: sc.jid, name: sc.name, phone: sc.phone });
        } else {
          result.push({ jid, name: '', phone: this.phoneFromJid(jid) });
        }
      } else {
        result.push({ jid, name: '', phone: this.phoneFromJid(jid) });
      }
    }
    return result;
  }

  formatPhone(phone: string): string {
    let p = phone.replace(/@c\.us$/, '').replace(/\D/g, '');
    if (p.startsWith('55') && p.length >= 12) {
      p = p.slice(2);
    }
    if (p.length === 11) {
      return `(${p.slice(0, 2)}) ${p.slice(2, 7)}-${p.slice(7)}`;
    }
    if (p.length === 10) {
      return `(${p.slice(0, 2)}) ${p.slice(2, 6)}-${p.slice(6)}`;
    }
    return p;
  }

  private phoneFromJid(jid: string): string {
    return jid.replace(/@c\.us$/, '');
  }

  get editSelectedCount(): number {
    return this.editSelectedJids.size;
  }

  formatDate(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  recurrenceLabel(r: ScheduleRecurrence): string {
    return RECURRENCE_LABELS[r] || r;
  }

  previewTemplate(template: string): string {
    const text = template.replace(/\\n/g, ' ').replace(/\{nome\}/g, 'Nome');
    return text.length > 60 ? text.slice(0, 57) + '...' : text;
  }

  onStartCreate(): void {
    this.editingSchedule = null;
    this.view = 'edit';
    const now = new Date();
    now.setHours(now.getHours() + 1, 0, 0, 0);
    this.editDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    this.editTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    this.editRecurrence = 'none';
    this.editSelectedJids = new Set();
    this.contactSearch = '';
    this.contactInputFocused = false;
  }

  onEdit(schedule: ScheduledMessage): void {
    this.editingSchedule = schedule;
    this.view = 'edit';

    const d = new Date(schedule.scheduledAt);
    this.editDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    this.editTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    this.editRecurrence = schedule.recurrence;
    this.editSelectedJids = new Set(schedule.contacts.map(c => c.jid));
    this.contactSearch = '';
    this.contactInputFocused = false;
  }

  onEditMessage(): void {
    if (!this.editingSchedule) return;

    const updated = this.applyEditFields();
    this.editSchedule.emit({ schedule: updated, mode: 'edit-message' });
  }

  onSaveEdit(): void {
    if (this.editingSchedule) {
      const updated = this.applyEditFields();
      this.editSchedule.emit({ schedule: updated, mode: 'edit-schedule' });
      this.view = 'list';
      this.editingSchedule = null;
    } else {
      const built = this.applyEditFields();
      this.createNew.emit({
        scheduledAt: built.scheduledAt,
        recurrence: built.recurrence,
        contacts: built.contacts
      });
    }
  }

  onSelectAutocomplete(contact: WhatsappContact): void {
    const next = new Set(this.editSelectedJids);
    next.add(contact.jid);
    this.editSelectedJids = next;
    this.contactSearch = '';
    this.contactInputFocused = false;
  }

  toggleContact(jid: string): void {
    const next = new Set(this.editSelectedJids);
    if (next.has(jid)) {
      next.delete(jid);
    } else {
      next.add(jid);
    }
    this.editSelectedJids = next;
  }

  isContactSelected(jid: string): boolean {
    return this.editSelectedJids.has(jid);
  }

  onBackToList(): void {
    this.view = 'list';
    this.editingSchedule = null;
  }

  onDelete(id: string): void {
    this.deleteSchedule.emit(id);
    if (this.editingSchedule?.id === id) {
      this.view = 'list';
      this.editingSchedule = null;
    }
  }

  private applyEditFields(): ScheduledMessage {
    const [y, m, d] = this.editDate.split('-').map(Number);
    const [h, min] = this.editTime.split(':').map(Number);
    const scheduledAt = new Date(y, m - 1, d, h, min).toISOString();

    const contacts: ScheduledContact[] = [];
    for (const jid of this.editSelectedJids) {
      const c = this.availableContacts.find(ac => ac.jid === jid);
      if (c) {
        contacts.push({ jid: c.jid, name: c.name, phone: c.phone });
        continue;
      }

      const existing = this.editingSchedule?.contacts.find(contact => contact.jid === jid);
      if (existing) {
        contacts.push(existing);
        continue;
      }

      contacts.push({ jid, name: '', phone: this.phoneFromJid(jid) });
    }

    if (this.editingSchedule) {
      return {
        ...this.editingSchedule,
        scheduledAt,
        recurrence: this.editRecurrence,
        contacts
      };
    }

    return {
      id: '',
      scheduledAt,
      recurrence: this.editRecurrence,
      template: '',
      contacts,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
  }
}
