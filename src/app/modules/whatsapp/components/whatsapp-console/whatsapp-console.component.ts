import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subject, combineLatest } from 'rxjs';
import { filter, take, takeUntil } from 'rxjs/operators';

import { MessageTemplateEditorConfig, MessageTemplateSaveResult } from '../../../../models/message-template.model';
import { WhatsappContact, WhatsappInstance } from '../../../../models/whatsapp.model';
import { PendingBulkSend, PendingBulkSendService } from '../../../../services/pending-bulk-send.service';
import { MessageTemplateService } from '../../../../services/message-template.service';
import { BulkSendService } from '../../services/bulk-send.service';
import { WhatsappStateService } from '../../services/whatsapp-state.service';

@Component({
  selector: 'app-whatsapp-console',
  templateUrl: './whatsapp-console.component.html',
  styleUrls: ['./whatsapp-console.component.scss'],
  providers: []
})
export class WhatsappConsoleComponent implements OnInit, OnDestroy {
  instances: WhatsappInstance[] = [];
  selectedInstanceName = '';
  errorMessage = '';
  isLoadingInstances = false;
  isLoadingContacts = false;
  isLoadingMessages = false;
  isInitialSyncing = false;
  syncMessage = 'Conectando ao WhatsApp...';
  syncDetail = '';
  syncCurrentStep = 0;
  syncTotalSteps = 0;

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

  private contacts: WhatsappContact[] = [];
  private selectedJidSet = new Set<string>();
  private destroy$ = new Subject<void>();

  constructor(
    private state: WhatsappStateService,
    private bulkSend: BulkSendService,
    private pendingBulkSendService: PendingBulkSendService,
    private messageTemplateService: MessageTemplateService
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
    });

    this.state.loadingState$.pipe(takeUntil(this.destroy$)).subscribe(state => {
      this.isLoadingInstances = state.instances;
      this.isLoadingContacts = state.contacts;
      this.isLoadingMessages = state.messages;
    });

    this.state.syncStatus$.pipe(takeUntil(this.destroy$)).subscribe(status => {
      this.isInitialSyncing = status.active && status.mode === 'initial';
      this.syncMessage = status.message || 'Conectando ao WhatsApp...';
      this.syncDetail = status.detail || '';
      this.syncCurrentStep = status.currentStep || 0;
      this.syncTotalSteps = status.totalSteps || 0;
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
        this.contacts = contacts;
        this.selectedJidSet = selectedJids;
        this.selectedCount = selectedJids.size;
        this.totalVisible = contacts.length;
        this.allSelected = contacts.length > 0 && contacts.every(c => selectedJids.has(c.jid));
      });

    const pending = this.pendingBulkSendService.consume();
    if (pending) {
      this.state.contacts$
        .pipe(
          filter(contacts => contacts.length > 0),
          take(1),
          takeUntil(this.destroy$)
        )
        .subscribe(contacts => {
          this.processPendingBulk(pending, contacts);
        });
    }

    this.state.loadInstances();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
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
    this.state.selectAll(this.contacts.map(c => c.jid));
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

  get isInitialLoading(): boolean {
    return this.isLoadingInstances || this.isLoadingContacts || this.isInitialSyncing;
  }

  get syncProgress(): number {
    if (!this.syncTotalSteps) {
      return 0;
    }

    return Math.max(0, Math.min(100, (this.syncCurrentStep / this.syncTotalSteps) * 100));
  }

  get isUiBlocked(): boolean {
    return this.isLoadingInstances;
  }

  onCloseTemplateModal(): void {
    this.isTemplateModalOpen = false;
  }

  onSaveTemplate(result: MessageTemplateSaveResult): void {
    const trimmed = result.text.trim();
    if (!trimmed) {
      return;
    }

    const selectedContacts = this.contacts.filter(c => this.selectedJidSet.has(c.jid));
    if (!selectedContacts.length) {
      return;
    }

    this.bulkSend.start(selectedContacts, trimmed, result.imageDataUrl);
    this.isTemplateModalOpen = false;
    this.state.exitSelectionMode();
  }

  private processPendingBulk(pending: PendingBulkSend, contacts: WhatsappContact[]): void {
    const matchedContacts = pending.clientes
      .map(cliente => this.findContactByPhone(cliente.telefone, contacts))
      .filter((c): c is WhatsappContact => c !== null);

    if (!matchedContacts.length) {
      return;
    }

    const template = this.messageTemplateService.getTemplates()[pending.templateType];
    const imageDataUrl = this.messageTemplateService.getTemplateImage(pending.templateType);
    this.bulkSend.start(matchedContacts, template, imageDataUrl);
  }

  private findContactByPhone(telefone: string, contacts: WhatsappContact[]): WhatsappContact | null {
    const phone = telefone.replace(/\D/g, '');
    if (!phone) return null;

    const match = contacts.find(c => c.phone.endsWith(phone) || phone.endsWith(c.phone));
    if (match) return match;

    // Brazilian mobile: try toggling the 9th digit
    const alt = this.brazilianPhoneAlternative(phone);
    if (!alt) return null;

    return contacts.find(c => c.phone.endsWith(alt) || alt.endsWith(c.phone)) ?? null;
  }

  private brazilianPhoneAlternative(phone: string): string | null {
    // 11 digits: DDD(2) + 9 + number(8) → remove the 9
    if (phone.length === 11 && phone[2] === '9') {
      return phone.slice(0, 2) + phone.slice(3);
    }
    // 10 digits: DDD(2) + number(8) → add 9
    if (phone.length === 10) {
      return phone.slice(0, 2) + '9' + phone.slice(2);
    }
    return null;
  }
}
