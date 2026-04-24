import { Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild } from '@angular/core';

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

interface SearchableContact {
  contact: WhatsappContact;
  nameLower: string;
  phoneDigits: string;
  phoneDigitsNoCountry: string;
}

@Component({
  selector: 'app-schedule-list-modal',
  templateUrl: './schedule-list-modal.component.html',
  styleUrls: ['./schedule-list-modal.component.scss']
})
export class ScheduleListModalComponent implements OnChanges, OnDestroy {
  @ViewChild('contactSearchInput') contactSearchInput?: ElementRef<HTMLInputElement>;

  @Input() isOpen = false;
  @Input() schedules: ScheduledMessage[] = [];
  @Input() availableContacts: WhatsappContact[] = [];
  @Input() contactsLoading = false;
  @Output() close = new EventEmitter<void>();
  @Output() createNew = new EventEmitter<ScheduleCreateRequest>();
  @Output() editSchedule = new EventEmitter<ScheduleEditRequest>();
  @Output() deleteSchedule = new EventEmitter<string>();
  @Output() triggerSchedule = new EventEmitter<string>();

  view: 'list' | 'edit' = 'list';
  editingSchedule: ScheduledMessage | null = null;

  contactSearch = '';
  editDate = '';
  editTime = '';
  editRecurrence: ScheduleRecurrence = 'none';
  editSelectedJids = new Set<string>();
  contactInputFocused = false;
  autocompleteResults: WhatsappContact[] = [];
  autocompleteMessage = '';
  highlightedAutocompleteIndex = -1;

  private contactBlurTimer: number | null = null;
  private autocompleteUpdateTimer: number | null = null;
  private availableContactsByJid = new Map<string, WhatsappContact>();
  private indexedContactsSource: WhatsappContact[] | null = null;
  private searchableContacts: SearchableContact[] = [];

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
      this.resetAutocompleteState();
    }

    if (changes['availableContacts']) {
      this.rebuildContactIndexes();
    }

    if (changes['availableContacts'] || changes['contactsLoading']) {
      this.scheduleAutocompleteUpdate({ preserveHighlight: true });
    }
  }

  ngOnDestroy(): void {
    this.clearContactBlurTimer();
    this.clearAutocompleteUpdateTimer();
  }

  get showAutocomplete(): boolean {
    return this.contactInputFocused && !!this.contactSearch.trim() && (!!this.autocompleteResults.length || !!this.autocompleteMessage);
  }

  onContactInputFocus(): void {
    this.clearContactBlurTimer();
    this.contactInputFocused = true;
    this.scheduleAutocompleteUpdate({ preserveHighlight: true });
  }

  onContactInputBlur(): void {
    this.clearContactBlurTimer();
    this.contactBlurTimer = window.setTimeout(() => {
      this.contactInputFocused = false;
      this.contactBlurTimer = null;
    }, 120);
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

  get selectedContactsList(): { jid: string; name: string; phone: string }[] {
    this.ensureContactIndexes();

    const result: { jid: string; name: string; phone: string }[] = [];
    for (const jid of this.editSelectedJids) {
      const found = this.availableContactsByJid.get(jid);
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
    this.resetAutocompleteState();
  }

  onEdit(schedule: ScheduledMessage): void {
    this.editingSchedule = schedule;
    this.view = 'edit';

    const d = new Date(schedule.scheduledAt);
    this.editDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    this.editTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    this.editRecurrence = schedule.recurrence;
    this.editSelectedJids = new Set(schedule.contacts.map(c => c.jid));
    this.resetAutocompleteState();
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

  onContactSearchChange(value: string): void {
    this.contactSearch = value;
    this.contactInputFocused = true;
    this.scheduleAutocompleteUpdate();
  }

  onContactSearchKeydown(event: KeyboardEvent): void {
    this.flushAutocompleteUpdate();

    if (!this.contactSearch.trim()) {
      if (event.key === 'Escape') {
        this.contactInputFocused = false;
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      if (!this.autocompleteResults.length) {
        return;
      }

      event.preventDefault();
      this.highlightedAutocompleteIndex = Math.min(
        this.highlightedAutocompleteIndex + 1,
        this.autocompleteResults.length - 1
      );
      return;
    }

    if (event.key === 'ArrowUp') {
      if (!this.autocompleteResults.length) {
        return;
      }

      event.preventDefault();
      this.highlightedAutocompleteIndex = Math.max(this.highlightedAutocompleteIndex - 1, 0);
      return;
    }

    if (event.key === 'Enter') {
      if (!this.autocompleteResults.length) {
        return;
      }

      event.preventDefault();
      const selectedIndex = this.highlightedAutocompleteIndex >= 0 ? this.highlightedAutocompleteIndex : 0;
      this.onSelectAutocomplete(this.autocompleteResults[selectedIndex]);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      this.contactInputFocused = false;
    }
  }

  onAutocompleteItemMouseDown(contact: WhatsappContact, event: MouseEvent): void {
    event.preventDefault();
    this.onSelectAutocomplete(contact);
  }

  onAutocompleteItemMouseEnter(index: number): void {
    this.highlightedAutocompleteIndex = index;
  }

  onSelectAutocomplete(contact: WhatsappContact): void {
    const next = new Set(this.editSelectedJids);
    next.add(contact.jid);
    this.editSelectedJids = next;
    this.contactSearch = '';
    this.contactInputFocused = true;
    this.clearAutocompleteUpdateTimer();
    this.updateAutocompleteState();
    this.focusContactSearchInput();
  }

  toggleContact(jid: string): void {
    const next = new Set(this.editSelectedJids);
    if (next.has(jid)) {
      next.delete(jid);
    } else {
      next.add(jid);
    }
    this.editSelectedJids = next;
    this.scheduleAutocompleteUpdate({ preserveHighlight: true });
  }

  isContactSelected(jid: string): boolean {
    return this.editSelectedJids.has(jid);
  }

  onBackToList(): void {
    this.view = 'list';
    this.editingSchedule = null;
    this.resetAutocompleteState();
  }

  trackAutocompleteContact(_index: number, contact: WhatsappContact): string {
    return contact.jid;
  }

  onTriggerNow(id: string): void {
    this.triggerSchedule.emit(id);
    this.close.emit();
  }

  onDelete(id: string): void {
    const confirmed = window.confirm('Excluir este agendamento? Esta ação não pode ser desfeita.');
    if (!confirmed) {
      return;
    }

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

  private updateAutocompleteState(options: { preserveHighlight?: boolean } = {}): void {
    this.ensureContactIndexes();

    const term = this.contactSearch.trim().toLowerCase();
    const previousHighlightedJid = options.preserveHighlight && this.highlightedAutocompleteIndex >= 0
      ? this.autocompleteResults[this.highlightedAutocompleteIndex]?.jid || ''
      : '';

    if (!term) {
      this.autocompleteResults = [];
      this.autocompleteMessage = '';
      this.highlightedAutocompleteIndex = -1;
      return;
    }

    const digits = term.replace(/\D/g, '');
    const results = this.searchableContacts
      .filter(({ contact }) => !contact.isGroup && !this.editSelectedJids.has(contact.jid))
      .filter(({ nameLower, phoneDigits, phoneDigitsNoCountry }) => {
        if (nameLower.includes(term)) {
          return true;
        }

        return !!digits && (phoneDigits.includes(digits) || phoneDigitsNoCountry.includes(digits));
      })
      .map(({ contact }) => contact)
      .slice(0, 10);

    this.autocompleteResults = results;

    if (this.contactsLoading && this.availableContacts.length === 0) {
      this.autocompleteMessage = 'Carregando contatos do WhatsApp...';
    } else if (!results.length && this.availableContacts.length === 0) {
      this.autocompleteMessage = 'Nenhum contato do WhatsApp foi carregado ainda.';
    } else if (!results.length) {
      this.autocompleteMessage = 'Nenhum contato encontrado.';
    } else {
      this.autocompleteMessage = '';
    }

    if (!results.length) {
      this.highlightedAutocompleteIndex = -1;
      return;
    }

    if (previousHighlightedJid) {
      const nextIndex = results.findIndex(contact => contact.jid === previousHighlightedJid);
      if (nextIndex >= 0) {
        this.highlightedAutocompleteIndex = nextIndex;
        return;
      }
    }

    this.highlightedAutocompleteIndex = 0;
  }

  private resetAutocompleteState(): void {
    this.clearContactBlurTimer();
    this.clearAutocompleteUpdateTimer();
    this.contactSearch = '';
    this.contactInputFocused = false;
    this.autocompleteResults = [];
    this.autocompleteMessage = '';
    this.highlightedAutocompleteIndex = -1;
  }

  private clearContactBlurTimer(): void {
    if (this.contactBlurTimer !== null) {
      window.clearTimeout(this.contactBlurTimer);
      this.contactBlurTimer = null;
    }
  }

  private scheduleAutocompleteUpdate(options: { preserveHighlight?: boolean } = {}): void {
    this.clearAutocompleteUpdateTimer();
    this.autocompleteUpdateTimer = window.setTimeout(() => {
      this.autocompleteUpdateTimer = null;
      this.updateAutocompleteState(options);
    }, 50);
  }

  private flushAutocompleteUpdate(): void {
    if (this.autocompleteUpdateTimer === null) {
      return;
    }

    window.clearTimeout(this.autocompleteUpdateTimer);
    this.autocompleteUpdateTimer = null;
    this.updateAutocompleteState();
  }

  private clearAutocompleteUpdateTimer(): void {
    if (this.autocompleteUpdateTimer !== null) {
      window.clearTimeout(this.autocompleteUpdateTimer);
      this.autocompleteUpdateTimer = null;
    }
  }

  private rebuildContactIndexes(): void {
    this.indexedContactsSource = this.availableContacts;
    this.availableContactsByJid = new Map(this.availableContacts.map(contact => [contact.jid, contact]));
    this.searchableContacts = this.availableContacts.map(contact => {
      const phoneDigits = (contact.phone || '').replace(/\D/g, '');
      return {
        contact,
        nameLower: (contact.name || '').toLowerCase(),
        phoneDigits,
        phoneDigitsNoCountry: phoneDigits.replace(/^55/, '')
      };
    });
  }

  private ensureContactIndexes(): void {
    if (this.indexedContactsSource === this.availableContacts) {
      return;
    }

    this.rebuildContactIndexes();
  }

  private focusContactSearchInput(): void {
    this.clearContactBlurTimer();
    window.setTimeout(() => {
      this.contactSearchInput?.nativeElement.focus();
    }, 0);
  }
}
