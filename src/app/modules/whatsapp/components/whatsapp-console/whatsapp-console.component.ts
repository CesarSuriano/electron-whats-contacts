import { Component, Input, OnDestroy, OnInit } from '@angular/core';
import { Subject, combineLatest } from 'rxjs';
import { filter, take, takeUntil } from 'rxjs/operators';

import { MessageTemplateEditorConfig, MessageTemplateSaveResult } from '../../../../models/message-template.model';
import { ScheduledContact, ScheduledMessage, ScheduleRecurrence } from '../../../../models/scheduled-message.model';
import { WhatsappContact, WhatsappInstance, WhatsappLabel } from '../../../../models/whatsapp.model';
import { PendingBulkSend, PendingBulkSendService } from '../../../../services/pending-bulk-send.service';
import { MessageTemplateService } from '../../../../services/message-template.service';
import { ScheduleListLauncherService } from '../../../../services/schedule-list-launcher.service';
import { ScheduledMessageService } from '../../../../services/scheduled-message.service';
import { ScheduleResult } from '../../../../components/schedule-modal/schedule-modal.component';
import { ScheduleCreateRequest, ScheduleEditRequest } from '../../../../components/schedule-list-modal/schedule-list-modal.component';
import { extractDigits } from '../../helpers/phone-format.helper';
import { BulkSendService } from '../../services/bulk-send.service';
import { WhatsappStateService } from '../../services/whatsapp-state.service';

const ERROR_AUTO_DISMISS_MS = 4000;

@Component({
  selector: 'app-whatsapp-console',
  templateUrl: './whatsapp-console.component.html',
  styleUrls: ['./whatsapp-console.component.scss'],
  providers: []
})
export class WhatsappConsoleComponent implements OnInit, OnDestroy {
  @Input() whatsappLabels: WhatsappLabel[] = [];

  instances: WhatsappInstance[] = [];
  selectedInstanceName = '';
  errorMessage = '';
  isLoadingInstances = false;
  isLoadingContacts = false;
  isLoadingMessages = false;
  isInitialSyncing = false;
  syncMessage = '';
  syncDetail = '';
  syncCurrentStep = 0;
  syncTotalSteps = 0;
  syncProgressPercent = 0;

  isSelectionMode = false;
  selectedCount = 0;
  totalVisible = 0;
  allSelected = false;

  isTemplateModalOpen = false;
  templateEditorConfig: MessageTemplateEditorConfig = {
    type: 'birthday',
    title: 'Envio para vários contatos',
    description: 'Escreva a mensagem que será pré-preenchida para cada contato selecionado. Use {nome} para incluir o nome do contato.'
  };

  isScheduleModalOpen = false;
  isScheduleListModalOpen = false;
  scheduleTemplateModalOpen = false;
  scheduleContacts: WhatsappContact[] = [];
  pendingScheduleDate = '';
  pendingScheduleRecurrence: ScheduleRecurrence = 'none';
  editingScheduleId: string | null = null;
  schedules: ScheduledMessage[] = [];
  upcomingSchedule: ScheduledMessage | null = null;

  scheduleTemplateConfig: MessageTemplateEditorConfig = {
    type: 'birthday',
    title: 'Mensagem agendada',
    description: 'Escreva a mensagem que será enviada. Use {nome} para incluir o nome do contato.'
  };
  scheduleEditInitialTemplate = '';
  scheduleEditInitialImage: string | undefined;

  allContacts: WhatsappContact[] = [];
  visibleContacts: WhatsappContact[] = [];
  isBulkLabelModalOpen = false;
  bulkLabelJids: string[] = [];
  private selectedJidSet = new Set<string>();
  private destroy$ = new Subject<void>();
  private errorDismissTimerId: number | null = null;

  constructor(
    private state: WhatsappStateService,
    private bulkSend: BulkSendService,
    private pendingBulkSendService: PendingBulkSendService,
    private messageTemplateService: MessageTemplateService,
    private scheduleListLauncher: ScheduleListLauncherService,
    private scheduledMessageService: ScheduledMessageService
  ) {}

  ngOnInit(): void {
    this.state.instances$.pipe(takeUntil(this.destroy$)).subscribe(instances => {
      this.instances = instances;
    });

    this.state.selectedInstance$.pipe(takeUntil(this.destroy$)).subscribe(name => {
      this.selectedInstanceName = name;
    });

    this.state.errorMessage$.pipe(takeUntil(this.destroy$)).subscribe(msg => {
      this.errorMessage = msg;

      if (!msg) {
        this.clearErrorDismissTimer();
        return;
      }

      this.scheduleErrorDismiss();
    });

    this.state.loadingState$.pipe(takeUntil(this.destroy$)).subscribe(state => {
      this.isLoadingInstances = state.instances;
      this.isLoadingContacts = state.contacts;
      this.isLoadingMessages = state.messages;
    });

    this.state.syncStatus$.pipe(takeUntil(this.destroy$)).subscribe(status => {
      this.isInitialSyncing = status.active && status.mode === 'initial';
      this.syncMessage = status.message || '';
      this.syncDetail = status.detail || '';
      this.syncCurrentStep = status.currentStep || 0;
      this.syncTotalSteps = status.totalSteps || 0;
      this.syncProgressPercent = status.progressPercent || 0;
    });

    this.state.selectionMode$.pipe(takeUntil(this.destroy$)).subscribe(mode => {
      this.isSelectionMode = mode;
      if (!mode) {
        this.isTemplateModalOpen = false;
      }
    });

    combineLatest([this.state.contacts$, this.state.selectedJids$])
      .pipe(takeUntil(this.destroy$))
      .subscribe(([contacts, selectedJids]) => {
        this.allContacts = contacts;
        this.selectedJidSet = selectedJids;
        this.selectedCount = selectedJids.size;
        const visible = this.visibleContacts.length ? this.visibleContacts : contacts;
        this.totalVisible = visible.length;
        this.allSelected = visible.length > 0 && visible.every(c => selectedJids.has(c.jid));
      });

    const pending = this.pendingBulkSendService.consume();
    if (pending) {
      const requiresBootstrapCompletion = !this.state.selectedInstance;
      let observedContactsLoading = false;

      combineLatest([this.state.contacts$, this.state.loadingState$, this.state.selectedInstance$])
        .pipe(
          filter(([_, loading, selectedInstance]) => {
            if (!selectedInstance || loading.instances) {
              return false;
            }

            if (loading.contacts) {
              observedContactsLoading = true;
              return false;
            }

            if (!requiresBootstrapCompletion) {
              return true;
            }

            return observedContactsLoading;
          }),
          take(1),
          takeUntil(this.destroy$)
        )
        .subscribe(([contacts]) => {
          this.processPendingBulk(pending, contacts);
        });
    }

    this.scheduledMessageService.schedules$
      .pipe(takeUntil(this.destroy$))
      .subscribe(schedules => (this.schedules = schedules));

    this.scheduledMessageService.upcoming$
      .pipe(takeUntil(this.destroy$))
      .subscribe(upcoming => (this.upcomingSchedule = upcoming));

    this.bulkSend.scheduleLifecycle$
      .pipe(takeUntil(this.destroy$))
      .subscribe(event => {
        if (event.outcome === 'completed') {
          this.scheduledMessageService.completeExecution(event.scheduleId);
          return;
        }

        this.scheduledMessageService.cancelExecution(event.scheduleId);
      });

    this.scheduleListLauncher.openRequests$
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        if (this.scheduleListLauncher.consumePendingOpen()) {
          this.isScheduleListModalOpen = true;
        }
      });

    if (this.scheduleListLauncher.consumePendingOpen()) {
      this.isScheduleListModalOpen = true;
    }

    this.state.loadInstances();
  }

  ngOnDestroy(): void {
    this.clearErrorDismissTimer();
    this.destroy$.next();
    this.destroy$.complete();
  }

  dismissError(): void {
    this.errorMessage = '';
    this.clearErrorDismissTimer();
    this.state.clearErrorMessage();
  }

  onInstanceChange(name: string): void {
    if (this.isUiBlocked) {
      return;
    }
    this.state.selectInstance(name);
  }

  onRefresh(): void {
    if (this.isUiBlocked) {
      return;
    }
    this.state.refresh();
  }

  onSelectAll(): void {
    const toSelect = this.visibleContacts.length ? this.visibleContacts : this.allContacts;
    this.state.selectAll(toSelect.map(c => c.jid));
  }

  onFilteredContactsChange(contacts: WhatsappContact[]): void {
    this.visibleContacts = contacts;
    this.totalVisible = contacts.length;
    this.allSelected = contacts.length > 0 && contacts.every(c => this.selectedJidSet.has(c.jid));
  }

  onClearSelection(): void {
    this.state.selectAll([]);
  }

  onExitSelectionMode(): void {
    this.state.exitSelectionMode();
  }

  onOpenBulkSend(): void {
    if (!this.selectedCount || this.isUiBlocked) {
      return;
    }
    this.isTemplateModalOpen = true;
  }

  onOpenBulkLabels(): void {
    if (!this.selectedCount || this.isUiBlocked) {
      return;
    }
    this.bulkLabelJids = Array.from(this.selectedJidSet);
    this.isBulkLabelModalOpen = true;
  }

  closeBulkLabelModal(): void {
    this.isBulkLabelModalOpen = false;
  }

  get isInitialLoading(): boolean {
    return this.isLoadingInstances || this.isLoadingContacts || this.isInitialSyncing;
  }

  get syncProgress(): number {
    return Math.max(0, Math.min(100, this.syncProgressPercent));
  }

  get isUiBlocked(): boolean {
    return this.isLoadingInstances;
  }

  private scheduleErrorDismiss(): void {
    this.clearErrorDismissTimer();
    this.errorDismissTimerId = window.setTimeout(() => {
      this.errorDismissTimerId = null;
      this.dismissError();
    }, ERROR_AUTO_DISMISS_MS);
  }

  private clearErrorDismissTimer(): void {
    if (this.errorDismissTimerId === null) {
      return;
    }

    window.clearTimeout(this.errorDismissTimerId);
    this.errorDismissTimerId = null;
  }

  onCloseTemplateModal(): void {
    this.isTemplateModalOpen = false;
  }

  onSaveTemplate(result: MessageTemplateSaveResult): void {
    const trimmed = result.text.trim();
    if (!trimmed) {
      return;
    }

    const selectedContacts = this.allContacts.filter(c => this.selectedJidSet.has(c.jid));
    if (!selectedContacts.length) {
      return;
    }

    this.bulkSend.start(selectedContacts, trimmed, result.imageDataUrl);
    this.isTemplateModalOpen = false;
    this.state.exitSelectionMode();
  }

  // --- Scheduling ---

  onScheduleFromContact(contact: WhatsappContact): void {
    this.scheduleContacts = [contact];
    this.editingScheduleId = null;
    this.isScheduleModalOpen = true;
  }

  onScheduleFromSelection(): void {
    if (!this.selectedCount || this.isUiBlocked) return;
    this.scheduleContacts = this.allContacts.filter(c => this.selectedJidSet.has(c.jid));
    this.editingScheduleId = null;
    this.isScheduleModalOpen = true;
  }

  onScheduleDateConfirm(result: ScheduleResult): void {
    this.pendingScheduleDate = result.scheduledAt;
    this.pendingScheduleRecurrence = result.recurrence;
    this.isScheduleModalOpen = false;
    this.scheduleEditInitialTemplate = '';
    this.scheduleEditInitialImage = undefined;
    this.scheduleTemplateModalOpen = true;
  }

  onScheduleTemplateClose(): void {
    this.scheduleTemplateModalOpen = false;
  }

  onScheduleTemplateSave(result: MessageTemplateSaveResult): void {
    const text = result.text.trim();
    if (!text) return;

    const contacts: ScheduledContact[] = this.scheduleContacts.map(c => ({
      jid: c.jid,
      name: c.name || c.phone,
      phone: c.phone
    }));

    if (this.editingScheduleId) {
      this.scheduledMessageService.update(this.editingScheduleId, {
        scheduledAt: this.pendingScheduleDate,
        recurrence: this.pendingScheduleRecurrence,
        template: text,
        imageDataUrl: result.imageDataUrl,
        contacts
      });
    } else {
      this.scheduledMessageService.create({
        scheduledAt: this.pendingScheduleDate,
        recurrence: this.pendingScheduleRecurrence,
        template: text,
        imageDataUrl: result.imageDataUrl,
        contacts
      });
    }

    this.scheduleTemplateModalOpen = false;
    this.state.exitSelectionMode();
    this.editingScheduleId = null;
  }

  onOpenScheduleList(): void {
    this.isScheduleListModalOpen = true;
  }

  onCloseScheduleList(): void {
    this.isScheduleListModalOpen = false;
  }

  onCreateNewSchedule(request: ScheduleCreateRequest): void {
    this.isScheduleListModalOpen = false;
    this.editingScheduleId = null;
    this.pendingScheduleDate = request.scheduledAt;
    this.pendingScheduleRecurrence = request.recurrence;
    this.scheduleContacts = request.contacts
      .map(sc => this.resolveScheduledContact(sc))
      .filter((contact): contact is WhatsappContact => contact !== null);
    this.scheduleEditInitialTemplate = '';
    this.scheduleEditInitialImage = undefined;
    this.scheduleTemplateModalOpen = true;
  }

  onEditSchedule(request: ScheduleEditRequest): void {
    const sch = request.schedule;
    this.editingScheduleId = sch.id;
    this.pendingScheduleDate = sch.scheduledAt;
    this.pendingScheduleRecurrence = sch.recurrence;

    const matchedContacts = sch.contacts
      .map(sc => this.resolveScheduledContact(sc))
      .filter((contact): contact is WhatsappContact => contact !== null);
    this.scheduleContacts = matchedContacts;

    if (request.mode === 'edit-message') {
      this.scheduleEditInitialTemplate = sch.template;
      this.scheduleEditInitialImage = sch.imageDataUrl;
      this.isScheduleListModalOpen = false;
      this.scheduleTemplateModalOpen = true;
    } else {
      this.scheduledMessageService.update(sch.id, {
        scheduledAt: sch.scheduledAt,
        recurrence: sch.recurrence,
        contacts: sch.contacts
      });
    }
  }

  onDeleteSchedule(id: string): void {
    this.scheduledMessageService.remove(id);
  }

  onTriggerSchedule(id: string): void {
    const schedule = this.schedules.find(s => s.id === id);
    if (!schedule) return;

    const matchedContacts = schedule.contacts
      .map(sc => this.resolveScheduledContact(sc))
      .filter((c): c is WhatsappContact => c !== null);

    if (matchedContacts.length) {
      this.scheduledMessageService.beginExecution(schedule.id);
      this.bulkSend.start(matchedContacts, schedule.template, schedule.imageDataUrl, { scheduleId: schedule.id });
    }
    this.isScheduleListModalOpen = false;
  }

  onNotificationAction(schedule: ScheduledMessage): void {
    const matchedContacts = schedule.contacts
      .map(sc => this.resolveScheduledContact(sc))
      .filter((c): c is WhatsappContact => c !== null);

    if (matchedContacts.length) {
      this.scheduledMessageService.beginExecution(schedule.id);
      this.bulkSend.start(matchedContacts, schedule.template, schedule.imageDataUrl, { scheduleId: schedule.id });
    }
  }

  onNotificationDismiss(id: string): void {
    this.scheduledMessageService.dismissNotification(id);
  }

  onNotificationSnooze(id: string): void {
    this.scheduledMessageService.snoozeNotification(id);
  }

  private processPendingBulk(pending: PendingBulkSend, contacts: WhatsappContact[]): void {
    const matchedContacts = pending.clientes
      .map(cliente => (
        this.findContactByPhone(cliente.telefone, contacts)
        ?? this.createSyntheticContactFromCliente(cliente.nome, cliente.telefone)
      ))
      .filter((c): c is WhatsappContact => c !== null);

    const uniqueContacts = Array.from(new Map(matchedContacts.map(contact => [contact.jid, contact])).values());

    if (!uniqueContacts.length) {
      return;
    }

    const template = this.messageTemplateService.getTemplates()[pending.templateType];
    const imageDataUrl = this.messageTemplateService.getTemplateImage(pending.templateType);
    this.bulkSend.start(uniqueContacts, template, imageDataUrl);
  }

  private resolveScheduledContact(contact: ScheduledContact): WhatsappContact | null {
    const exact = this.allContacts.find(candidate => candidate.jid === contact.jid) || null;
    if (exact) {
      return exact;
    }

    const resolvedJid = this.state.resolveConversationJid(contact.jid);
    const equivalent = this.allContacts.find(candidate =>
      candidate.jid === resolvedJid || this.state.resolveConversationJid(candidate.jid) === resolvedJid
    ) || null;
    if (equivalent) {
      return equivalent;
    }

    const fallbackJid = resolvedJid || contact.jid;
    if (!fallbackJid) {
      return null;
    }

    return {
      jid: fallbackJid,
      name: contact.name || contact.phone || fallbackJid,
      phone: contact.phone || '',
      found: false,
      isGroup: fallbackJid.endsWith('@g.us')
    };
  }

  private createSyntheticContactFromCliente(nome: string, telefone: string): WhatsappContact | null {
    const outboundDigits = this.resolveOutboundDigits(telefone);
    if (!outboundDigits) {
      return null;
    }

    const normalizedName = (nome || '').trim();

    return {
      jid: `${outboundDigits}@c.us`,
      phone: outboundDigits,
      name: normalizedName || outboundDigits,
      found: false
    };
  }

  private findContactByPhone(telefone: string, contacts: WhatsappContact[]): WhatsappContact | null {
    const targetCandidates = this.expandPhoneCandidates(telefone);
    if (!targetCandidates.length) {
      return null;
    }

    const candidates = contacts
      .filter(contact => !contact.isGroup)
      .map(contact => ({
        contact,
        phoneCandidates: this.expandPhoneCandidates(contact.phone || contact.jid)
      }))
      .filter(entry => entry.phoneCandidates.length > 0);

    const exactMatches = candidates
      .filter(entry => entry.phoneCandidates.some(candidate => targetCandidates.includes(candidate)))
      .map(entry => entry.contact);

    if (exactMatches.length > 0) {
      return this.pickPreferredContact(exactMatches);
    }

    const suffixMatches = candidates
      .filter(entry => entry.phoneCandidates.some(candidate =>
        targetCandidates.some(target => this.hasStrongSuffixMatch(target, candidate))
      ))
      .map(entry => entry.contact);

    if (suffixMatches.length > 0) {
      return this.pickPreferredContact(suffixMatches);
    }

    return null;
  }

  private pickPreferredContact(contacts: WhatsappContact[]): WhatsappContact | null {
    const unique = Array.from(new Map(contacts.map(contact => [contact.jid, contact])).values());
    if (unique.length === 1) {
      return unique[0];
    }

    const canonical = unique.filter(contact => contact.jid.endsWith('@c.us'));
    if (canonical.length === 1) {
      return canonical[0];
    }

    const found = unique.filter(contact => contact.found);
    if (found.length === 1) {
      return found[0];
    }

    return null;
  }

  private hasStrongSuffixMatch(a: string, b: string): boolean {
    const overlap = Math.min(a.length, b.length);
    return overlap >= 10 && (a.endsWith(b) || b.endsWith(a));
  }

  private expandPhoneCandidates(raw: string): string[] {
    const digits = extractDigits(raw);
    if (!digits) {
      return [];
    }

    const values = new Set<string>();
    const hasCountryCode = digits.startsWith('55') && digits.length > 11;

    const addCandidate = (value: string): void => {
      if (value.length >= 10 && value.length <= 15) {
        values.add(value);
      }
    };

    addCandidate(digits);

    const localDigits = hasCountryCode ? digits.slice(2) : digits;
    addCandidate(localDigits);

    const localAlternative = this.brazilianPhoneAlternative(localDigits);
    if (localAlternative) {
      addCandidate(localAlternative);
      if (hasCountryCode) {
        addCandidate(`55${localAlternative}`);
      }
    }

    return Array.from(values);
  }

  private resolveOutboundDigits(raw: string): string | null {
    const candidates = this.expandPhoneCandidates(raw);
    if (!candidates.length) {
      return null;
    }

    const withCountryCode = candidates.find(candidate => candidate.startsWith('55') && (candidate.length === 12 || candidate.length === 13));
    if (withCountryCode) {
      return withCountryCode;
    }

    const local = candidates.find(candidate => candidate.length === 10 || candidate.length === 11);
    if (local) {
      return `55${local}`;
    }

    return [...candidates].sort((a, b) => b.length - a.length)[0] || null;
  }

  private brazilianPhoneAlternative(phone: string): string | null {
    // 11 digits: DDD(2) + 9 + number(8) -> remove the 9
    if (phone.length === 11 && phone[2] === '9') {
      return phone.slice(0, 2) + phone.slice(3);
    }
    // 10 digits: DDD(2) + number(8) -> add 9
    if (phone.length === 10) {
      return phone.slice(0, 2) + '9' + phone.slice(2);
    }
    return null;
  }
}
