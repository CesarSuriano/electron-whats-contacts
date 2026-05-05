import { Component, Input, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Subject, forkJoin, of } from 'rxjs';
import { catchError, map, takeUntil } from 'rxjs/operators';

import { MessageActionEvent } from '../message-list/message-list.component';

import { AgentService } from '../../../../services/agent.service';
import { splitAssistantSuggestionIntoMessages } from '../../../../helpers/assistant-suggestion.helper';
import { WhatsappContact, WhatsappLabel, WhatsappMessage } from '../../../../models/whatsapp.model';
import { BulkSendService } from '../../services/bulk-send.service';
import { AssistantFeedbackService } from '../../services/assistant-feedback.service';
import { WhatsappStateService } from '../../services/whatsapp-state.service';
import { ComposerComponent } from '../composer/composer.component';

const WHATSAPP_AI_FEATURE_ENABLED = false;
const AUTO_SUGGESTION_IDLE_MS = 1800;
const AUTO_SUGGESTION_BURST_IDLE_MS = 2800;
const DRAFT_SYNC_DEBOUNCE_MS = 40;

@Component({
  selector: 'app-chat-view',
  templateUrl: './chat-view.component.html',
  styleUrls: ['./chat-view.component.scss']
})
export class ChatViewComponent implements OnInit, OnDestroy {
  readonly maxForwardRecipients = 4;

  @Input() disabled = false;
  @Input() whatsappLabels: WhatsappLabel[] = [];
  @ViewChild(ComposerComponent) composer?: ComposerComponent;

  contact: WhatsappContact | null = null;
  messages: WhatsappMessage[] = [];
  draftText = '';
  isSending = false;
  isSyncingMessages = false;
  isAgentEnabled = false;
  hasAgentConfiguration = false;
  isAiThinking = false;
  isAiWaitingForCustomerPause = false;
  aiSuggestion = '';
  aiSuggestionError = '';
  aiFeedbackMessage = '';
  readonly isAiFeatureEnabled = WHATSAPP_AI_FEATURE_ENABLED;

  pendingReply: MessageActionEvent | null = null;
  pendingForward: MessageActionEvent | null = null;
  pendingDelete: MessageActionEvent | null = null;
  selectedForwardJids = new Set<string>();
  showForwardDialog = false;
  showDeleteDialog = false;
  forwardSearchQuery = '';
  transientErrorMessage = '';
  isDeletingMessage = false;
  isForwardingMessage = false;

  private transientErrorTimer: number | null = null;
  private bulkImagesWereSet = false;
  private lastRequestedAiContextKey = '';
  private suggestionTimerId: number | null = null;
  private queuedAiSuggestionParts: string[] = [];
  private aiSuggestionSequenceTotal = 0;
  private aiSuggestionSequenceIndex = 0;
  private pendingAiSuggestionPromotion = false;
  private acceptedAiSuggestionDraft = '';
  private pendingDraftSyncTimer: number | null = null;
  private pendingDraftSyncJid = '';
  private pendingDraftSyncValue = '';
  private bulkQueueWasActive = false;
  private pendingComposerFocusTimer: number | null = null;
  private shouldRestoreComposerFocus = false;

  private readonly destroy$ = new Subject<void>();

  constructor(
    private state: WhatsappStateService,
    private bulkSend: BulkSendService,
    private agentService: AgentService,
    private assistantFeedback: AssistantFeedbackService
  ) {}

  ngOnInit(): void {
    if (!this.isAiFeatureEnabled) {
      this.disableAiFeature();
    }

    this.state.selectedContact$.pipe(takeUntil(this.destroy$)).subscribe(contact => {
      const previousContactJid = this.resolveContactJid(this.contact);
      const nextContactJid = this.resolveContactJid(contact);

      if (nextContactJid !== previousContactJid) {
        this.flushPendingDraftSync();
        this.resetSuggestionState();
        this.clearSuggestionProviders();
      }

      this.contact = contact;
      this.draftText = nextContactJid ? this.state.getDraftTextForJid(nextContactJid) : '';

      if (!contact) {
        this.clearComposerFocusRequest();
        this.clearSuggestionProviders();
      }

      if (this.isAiFeatureEnabled) {
        this.scheduleAiSuggestion();
      }
    });

    this.state.selectedMessages$.pipe(takeUntil(this.destroy$)).subscribe(messages => {
      this.messages = messages;
      if (this.isAiFeatureEnabled) {
        this.scheduleAiSuggestion();
      }
    });

    this.state.selectedContactJid$
      .pipe(takeUntil(this.destroy$))
      .subscribe(jid => {
        if (!jid) {
          return;
        }

        this.scheduleComposerFocus();
      });

    this.state.loadingState$.pipe(takeUntil(this.destroy$)).subscribe(state => {
      this.isSending = state.sending;
      this.isSyncingMessages = state.messages;

      if (!this.isSyncingMessages) {
        this.applyComposerFocus();
      }

      if (this.isAiFeatureEnabled) {
        this.scheduleAiSuggestion();
      }
    });

    this.bulkSend.queue$.pipe(takeUntil(this.destroy$)).subscribe(queue => {
      const hasActiveQueue = Boolean(queue);

      if (this.bulkQueueWasActive && !hasActiveQueue && this.contact && !this.disabled) {
        this.scheduleComposerFocus();
      }

      this.bulkQueueWasActive = hasActiveQueue;
    });

    this.state.draftText$.pipe(takeUntil(this.destroy$)).subscribe(text => {
      if (this.pendingDraftSyncJid && this.pendingDraftSyncJid === this.resolveActiveContactJid() && text !== this.pendingDraftSyncValue) {
        this.clearPendingDraftSync();
      }

      if (text !== this.draftText) {
        this.draftText = text;
      }

      if (this.isAiFeatureEnabled) {
        this.scheduleAiSuggestion();
      }
    });

    this.state.draftImageDataUrls$.pipe(takeUntil(this.destroy$)).subscribe(dataUrls => {
      if (dataUrls.length) {
        this.bulkImagesWereSet = true;
        const nextDataUrls = [...dataUrls];
        setTimeout(() => this.composer?.setAttachmentsFromDataUrls(nextDataUrls, 'imagem-template'), 0);
      } else if (this.bulkImagesWereSet) {
        this.bulkImagesWereSet = false;
        setTimeout(() => this.composer?.forceResetAttachment(), 0);
      }
    });

    if (this.isAiFeatureEnabled) {
      this.agentService.settings$.pipe(takeUntil(this.destroy$)).subscribe(settings => {
        const nextEnabled = settings.enabled;
        const nextConfigured = settings.gemUrl.trim().length > 0;

        if (nextEnabled !== this.isAgentEnabled || nextConfigured !== this.hasAgentConfiguration) {
          this.resetSuggestionState();
          this.clearSuggestionProviders();
        }

        this.isAgentEnabled = nextEnabled;
        this.hasAgentConfiguration = nextConfigured;
        this.scheduleAiSuggestion();
      });

      this.agentService.suggestion$.pipe(takeUntil(this.destroy$)).subscribe(snapshot => {
        this.applySuggestionSnapshot(snapshot);
      });
    }
  }

  ngOnDestroy(): void {
    if (this.suggestionTimerId !== null) {
      window.clearTimeout(this.suggestionTimerId);
    }

    if (this.transientErrorTimer !== null) {
      window.clearTimeout(this.transientErrorTimer);
    }

    this.flushPendingDraftSync();
    this.clearComposerFocusRequest();

    this.destroy$.next();
    this.destroy$.complete();
  }

  onDraftChange(value: string): void {
    this.draftText = value;

    if (
      this.isAiFeatureEnabled
      &&
      this.acceptedAiSuggestionDraft
      && this.normalizeSuggestionComparableText(value) !== this.acceptedAiSuggestionDraft
    ) {
      this.pendingAiSuggestionPromotion = false;
      this.acceptedAiSuggestionDraft = '';
      this.discardCurrentSuggestionSequence();
    }

    this.scheduleDraftSync(value);
  }

  onAcceptAiSuggestion(value: string): void {
    if (!this.isAiFeatureEnabled) {
      return;
    }

    this.aiSuggestion = '';
    this.aiSuggestionError = '';
    this.acceptedAiSuggestionDraft = this.normalizeSuggestionComparableText(value);
    this.pendingAiSuggestionPromotion = this.queuedAiSuggestionParts.length > 0;
    if (!this.queuedAiSuggestionParts.length) {
      this.resetSuggestionSequence();
    }
    this.clearSuggestionProviders();
  }

  onRefreshAiSuggestion(): void {
    if (!this.isAiFeatureEnabled) {
      return;
    }

    this.scheduleAiSuggestion(true);
  }

  onGuidedAiSuggestion(instruction: string): void {
    if (!this.isAiFeatureEnabled) {
      return;
    }

    this.requestAiSuggestionNow(instruction);
  }

  onRateAiSuggestion(rating: 'up' | 'down'): void {
    if (!this.isAiFeatureEnabled || !this.contact || !this.aiSuggestion.trim()) {
      return;
    }

    this.assistantFeedback.record({
      provider: 'gem',
      rating,
      contactJid: this.contact.jid,
      contactName: this.contact.name || this.contact.phone || this.contact.jid,
      contextKey: this.lastRequestedAiContextKey || this.buildAiContextKey(),
      suggestion: this.aiSuggestion,
      suggestionIndex: this.aiSuggestionSequenceIndex || 1,
      suggestionTotal: this.aiSuggestionSequenceTotal || 1,
      messages: this.messages
    });

    this.aiFeedbackMessage = rating === 'up'
      ? 'Feedback positivo salvo para esta sugestão.'
      : 'Feedback negativo salvo. Se quiser, peça outra sugestão.';
  }

  onSendText(text: string): void {
    if (!this.contact || this.disabled) {
      return;
    }

    const contactJid = this.resolveActiveContactJid();
    const quotedReply = this.pendingReply;

    const shouldPromoteQueuedSuggestion = this.shouldPromoteQueuedSuggestionAfterSend(text);
    if (!shouldPromoteQueuedSuggestion) {
      this.discardCurrentSuggestionSequence();
    }

    const send$ = quotedReply
      ? this.state.sendReply(contactJid, text, quotedReply.messageId, quotedReply.text, quotedReply.isFromMe)
      : this.state.sendText(contactJid, text);

    if (this.bulkSend.hasActiveQueue) {
      this.bulkSend.trackCurrentSend(contactJid, 1);
    }

    this.pendingReply = null;

    send$.subscribe({
      next: () => {
        if (!this.bulkSend.hasActiveQueue) {
          this.clearPendingDraftSync();
          this.composer?.resetAfterSend();
          this.draftText = '';
          this.state.setDraftTextForJid(contactJid, '');
          this.clearSuggestionProviders();

          if (!shouldPromoteQueuedSuggestion || !this.promoteQueuedSuggestion()) {
            this.discardCurrentSuggestionSequence();
            this.lastRequestedAiContextKey = '';
          }

          this.pendingAiSuggestionPromotion = false;
          this.acceptedAiSuggestionDraft = '';
        }
      },
      error: () => {
        if (this.bulkSend.hasActiveQueue) {
          this.bulkSend.clearTrackedCurrentSend(contactJid);
        }
      }
    });
  }

  onSendMedia(payload: { files: File[]; caption: string }): void {
    if (!this.contact || this.disabled || !payload.files.length) {
      return;
    }

    const contactJid = this.resolveActiveContactJid();

    this.discardCurrentSuggestionSequence();
    this.pendingAiSuggestionPromotion = false;
    this.acceptedAiSuggestionDraft = '';

    const total = payload.files.length;
    const isBulkQueueActive = this.bulkSend.hasActiveQueue;
    let remaining = total;
    let okCount = 0;
    let errorCount = 0;

    if (isBulkQueueActive) {
      this.bulkSend.trackCurrentSend(contactJid, total);
    }

    const onFileDone = (success: boolean) => {
      if (success) okCount++; else errorCount++;
      remaining--;
      if (remaining > 0) return;

      if (errorCount > 0) {
        if (isBulkQueueActive) {
          this.bulkSend.clearTrackedCurrentSend(contactJid);
        }

        const partial = okCount > 0
          ? `Enviei ${okCount} de ${total} arquivos. ${errorCount} falhou${errorCount > 1 ? 'ram' : ''}.`
          : `Não foi possível enviar ${errorCount > 1 ? 'os arquivos' : 'o arquivo'}.`;
        this.showTransientError(partial);
      }

      // Só reseta o composer se ao menos um arquivo foi enviado, pra preservar
      // anexos/legenda quando todos falharem (usuário pode reenviar).
      if (okCount > 0 && !this.bulkSend.hasActiveQueue) {
        this.clearPendingDraftSync();
        this.composer?.resetAfterSend();
        this.draftText = '';
        this.state.setDraftTextForJid(contactJid, '');
        this.clearSuggestionProviders();
        this.lastRequestedAiContextKey = '';
      }
    };

    payload.files.forEach((file, index) => {
      this.state.sendMedia(contactJid, file, index === 0 ? payload.caption : '').subscribe({
        next: () => onFileDone(true),
        error: () => onFileDone(false)
      });
    });
  }

  onReplySelected(event: MessageActionEvent): void {
    this.pendingReply = event;
    setTimeout(() => this.composer?.focus(), 0);
  }

  cancelReply(): void {
    this.pendingReply = null;
  }

  onForwardSelected(event: MessageActionEvent): void {
    this.pendingForward = event;
    this.selectedForwardJids = new Set<string>();
    this.forwardSearchQuery = '';
    this.showForwardDialog = true;
  }

  closeForwardDialog(): void {
    if (this.isForwardingMessage) {
      return;
    }

    this.pendingForward = null;
    this.selectedForwardJids = new Set<string>();
    this.showForwardDialog = false;
    this.forwardSearchQuery = '';
  }

  toggleForwardRecipient(jid: string): void {
    if (!jid || this.isForwardingMessage) {
      return;
    }

    const next = new Set(this.selectedForwardJids);
    if (next.has(jid)) {
      next.delete(jid);
    } else {
      next.add(jid);
    }

    this.selectedForwardJids = next;
  }

  isForwardRecipientSelected(jid: string): boolean {
    return this.selectedForwardJids.has(jid);
  }

  confirmForward(): void {
    if (!this.pendingForward || this.isForwardingMessage || !this.forwardSelectionCount || this.isForwardLimitExceeded) {
      return;
    }

    const messageId = this.pendingForward.messageId;
    const recipientJids = Array.from(this.selectedForwardJids);
    this.isForwardingMessage = true;

    // Encaminhar é irreversível — não usamos forkJoin direto porque ele falha
    // o conjunto inteiro se UM destinatário falhar, o que esconderia os que
    // já foram entregues e levaria o usuário a duplicar o envio. Captura
    // erro por destinatário e relata o resultado consolidado.
    const perRecipient$ = recipientJids.map(jid =>
      this.state.forwardMessage(messageId, jid).pipe(
        map(() => ({ jid, ok: true })),
        catchError(() => of({ jid, ok: false }))
      )
    );

    forkJoin(perRecipient$).subscribe(results => {
      this.isForwardingMessage = false;

      const okCount = results.filter(r => r.ok).length;
      const errorCount = results.length - okCount;

      if (errorCount === 0) {
        this.pendingForward = null;
        this.selectedForwardJids = new Set<string>();
        this.showForwardDialog = false;
        this.forwardSearchQuery = '';
        return;
      }

      if (okCount === 0) {
        this.showTransientError('Não foi possível encaminhar a mensagem.');
        return;
      }

      // Sucesso parcial: mantém o diálogo aberto e desmarca quem já recebeu,
      // pra usuário poder retentar somente os que falharam sem duplicar.
      const failedJids = new Set(results.filter(r => !r.ok).map(r => r.jid));
      this.selectedForwardJids = new Set(Array.from(this.selectedForwardJids).filter(jid => failedJids.has(jid)));
      this.showTransientError(`Encaminhei para ${okCount} de ${results.length} contatos. ${errorCount} falhou${errorCount > 1 ? 'ram' : ''} — tente novamente.`);
    });
  }

  get forwardSelectionCount(): number {
    return this.selectedForwardJids.size;
  }

  get isForwardLimitExceeded(): boolean {
    return this.forwardSelectionCount > this.maxForwardRecipients;
  }

  get forwardSelectionWarning(): string {
    if (!this.isForwardLimitExceeded) {
      return '';
    }

    return `Você pode encaminhar para no máximo ${this.maxForwardRecipients} contatos por vez.`;
  }

  get filteredForwardContacts(): WhatsappContact[] {
    const query = this.forwardSearchQuery.trim().toLowerCase();
    return this.state.contacts.filter(c => {
      if (!query) return true;
      return (c.name || '').toLowerCase().includes(query)
        || (c.phone || '').includes(query);
    });
  }

  onDeleteSelected(event: MessageActionEvent): void {
    this.pendingDelete = event;
    this.showDeleteDialog = true;
  }

  closeDeleteDialog(): void {
    if (this.isDeletingMessage) {
      return;
    }

    this.pendingDelete = null;
    this.showDeleteDialog = false;
  }

  confirmDelete(): void {
    if (!this.pendingDelete || this.isDeletingMessage) {
      return;
    }

    const event = this.pendingDelete;
    this.isDeletingMessage = true;

    this.state.deleteMessage(event.messageId, event.isFromMe).subscribe({
      next: () => {
        this.isDeletingMessage = false;
        this.pendingDelete = null;
        this.showDeleteDialog = false;
      },
      error: err => {
        this.isDeletingMessage = false;
        this.pendingDelete = null;
        this.showDeleteDialog = false;
        const details = (err?.error?.details as string) || (err?.message as string) || '';
        this.showTransientError(details
          ? `Não foi possível apagar: ${details}`
          : 'Não foi possível apagar a mensagem. O tempo limite pode ter expirado.');
      }
    });
  }

  get deleteConfirmationText(): string {
    if (this.pendingDelete?.isFromMe) {
      return 'Essa mensagem será apagada para todos quando o WhatsApp ainda permitir a ação.';
    }

    return 'Essa mensagem será removida desta conversa no app.';
  }

  private showTransientError(message: string): void {
    this.transientErrorMessage = message;
    if (this.transientErrorTimer !== null) {
      window.clearTimeout(this.transientErrorTimer);
    }
    this.transientErrorTimer = window.setTimeout(() => {
      this.transientErrorMessage = '';
      this.transientErrorTimer = null;
    }, 6000);
  }

  get aiStatusMessage(): string {
    if (!this.isSuggestionToggleOn) {
      return '';
    }

    if (!this.hasAgentConfiguration) {
      return 'Configure o link do agente na tela do agente para liberar as sugestões.';
    }

    if (this.isSyncingMessages) {
      return `${this.assistantDisplayName} aguarda a sincronização das mensagens para ler o contexto certo.`;
    }

    if (this.isAiWaitingForCustomerPause) {
      return `${this.assistantDisplayName} está aguardando alguns segundos para juntar as últimas mensagens do cliente e economizar sugestões.`;
    }

    if (this.draftText.trim() && this.hasSuggestionSequence) {
      return this.remainingQueuedSuggestionCount > 0
        ? `Essa é a mensagem ${this.aiSuggestionSequenceIndex} de ${this.aiSuggestionSequenceTotal}. Depois do envio, a próxima fica pronta para revisão.`
        : 'Revise a mensagem e envie quando estiver pronta.';
    }

    if (this.draftText.trim()) {
      return 'A sugestão reaparece quando o campo volta a ficar vazio.';
    }

    if (this.aiSuggestionError) {
      return this.aiSuggestionError;
    }

    if (this.aiFeedbackMessage) {
      return this.aiFeedbackMessage;
    }

    if (this.isAiThinking) {
      return `${this.assistantDisplayName} está lendo o contexto da conversa e preparando a resposta…`;
    }

    if (this.aiSuggestion) {
      if (this.hasSuggestionSequence) {
        return `Pressione Tab ou clique no botão para usar a mensagem ${this.aiSuggestionSequenceIndex} de ${this.aiSuggestionSequenceTotal}.`;
      }

      return `Pressione Tab ou clique no botão para transformar a sugestão do ${this.assistantDisplayName} em mensagem real.`;
    }

    if (this.remainingQueuedSuggestionCount > 0) {
      return `Ainda restam ${this.remainingQueuedSuggestionCount} mensagens sugeridas para esta conversa.`;
    }

    if (!this.hasInboundTurnToAnswer) {
      return `${this.assistantDisplayName} espera a próxima mensagem do cliente antes de sugerir a resposta.`;
    }

    return `Clique no ícone do ${this.assistantDisplayName} para pedir uma nova sugestão.`;
  }

  get assistantDisplayName(): string {
    return 'Agente';
  }

  get assistantIcon(): string {
    return 'smart_toy';
  }

  get isSuggestionToggleOn(): boolean {
    return this.isAiFeatureEnabled && this.isAgentEnabled;
  }

  private scheduleAiSuggestion(force = false): void {
    if (!this.isAiFeatureEnabled) {
      return;
    }

    if (this.suggestionTimerId !== null) {
      window.clearTimeout(this.suggestionTimerId);
      this.suggestionTimerId = null;
    }

    const contextKey = this.buildAiContextKey();

    if (
      !force
      && contextKey
      && this.lastRequestedAiContextKey
      && contextKey !== this.lastRequestedAiContextKey
      && !this.pendingAiSuggestionPromotion
    ) {
      this.resetSuggestionState();
      this.clearSuggestionProviders();
    }

    if (!this.shouldGenerateAiSuggestion()) {
      this.isAiWaitingForCustomerPause = false;

      if (!this.draftText.trim() && !this.shouldPreserveCurrentSuggestion()) {
        this.aiSuggestion = '';
        this.aiSuggestionError = '';
        this.aiFeedbackMessage = '';
        this.isAiThinking = false;
        this.clearSuggestionProviders();
      }

      return;
    }

    if (!contextKey) {
      return;
    }

    if (!force && contextKey === this.lastRequestedAiContextKey && (this.aiSuggestion || this.isAiThinking)) {
      return;
    }

    if (!force && contextKey !== this.lastRequestedAiContextKey) {
      this.aiSuggestion = '';
      this.aiSuggestionError = '';
      this.aiFeedbackMessage = '';
      this.isAiThinking = false;
      this.clearSuggestionProviders();
    }

    this.isAiWaitingForCustomerPause = !force;

    this.suggestionTimerId = window.setTimeout(() => {
      if (!this.contact) {
        return;
      }

      this.isAiWaitingForCustomerPause = false;

      const currentContextKey = this.buildAiContextKey();
      if (!currentContextKey) {
        return;
      }

      this.lastRequestedAiContextKey = currentContextKey;

      void this.agentService.generateSuggestion({
        contact: this.contact,
        messages: this.messages,
        contextKey: currentContextKey
      });
    }, force ? 0 : this.autoSuggestionDelayMs);
  }

  private requestAiSuggestionNow(operatorInstruction: string): void {
    if (!this.isAiFeatureEnabled) {
      return;
    }

    const trimmedInstruction = operatorInstruction.trim();
    if (!trimmedInstruction || !this.contact || !this.canGenerateWithActiveMode || this.disabled || this.isSyncingMessages) {
      return;
    }

    if (this.suggestionTimerId !== null) {
      window.clearTimeout(this.suggestionTimerId);
      this.suggestionTimerId = null;
    }

    const currentContextKey = this.buildAiContextKey();
    if (!currentContextKey) {
      return;
    }

    this.resetSuggestionState();
    this.clearSuggestionProviders();
    this.lastRequestedAiContextKey = currentContextKey;

    void this.agentService.generateSuggestion({
      contact: this.contact,
      messages: this.messages,
      contextKey: currentContextKey,
      operatorInstruction: trimmedInstruction
    });
  }

  private shouldGenerateAiSuggestion(): boolean {
    return Boolean(
      this.contact
      && this.canGenerateWithActiveMode
      && !this.disabled
      && !this.isSyncingMessages
      && !this.draftText.trim()
      && !this.hasSuggestionSequence
      && this.hasInboundTurnToAnswer
    );
  }

  private buildAiContextKey(): string {
    if (!this.contact) {
      return '';
    }

    const recentIds = this.messages.slice(-8).map(message => message.id).join('|');
    return `${this.contact.jid}::${recentIds || 'sem-mensagens'}`;
  }

  private get canGenerateWithActiveMode(): boolean {
    return this.isAiFeatureEnabled && this.isAgentEnabled && this.hasAgentConfiguration;
  }

  private disableAiFeature(): void {
    if (this.suggestionTimerId !== null) {
      window.clearTimeout(this.suggestionTimerId);
      this.suggestionTimerId = null;
    }

    this.isAgentEnabled = false;
    this.hasAgentConfiguration = false;
    this.resetSuggestionState();
    this.clearSuggestionProviders();
  }

  private scheduleDraftSync(value: string): void {
    const jid = this.resolveActiveContactJid();
    if (!jid) {
      return;
    }

    this.pendingDraftSyncJid = jid;
    this.pendingDraftSyncValue = value;

    if (this.pendingDraftSyncTimer !== null) {
      window.clearTimeout(this.pendingDraftSyncTimer);
    }

    this.pendingDraftSyncTimer = window.setTimeout(() => {
      this.flushPendingDraftSync();
    }, DRAFT_SYNC_DEBOUNCE_MS);
  }

  private flushPendingDraftSync(): void {
    if (!this.pendingDraftSyncJid) {
      this.clearPendingDraftSync();
      return;
    }

    const jid = this.pendingDraftSyncJid;
    const value = this.pendingDraftSyncValue;
    this.clearPendingDraftSync();
    this.state.setDraftTextForJid(jid, value);
  }

  private clearPendingDraftSync(): void {
    if (this.pendingDraftSyncTimer !== null) {
      window.clearTimeout(this.pendingDraftSyncTimer);
      this.pendingDraftSyncTimer = null;
    }

    this.pendingDraftSyncJid = '';
    this.pendingDraftSyncValue = '';
  }

  private resolveActiveContactJid(): string {
    return this.resolveContactJid(this.contact);
  }

  private resolveContactJid(contact: WhatsappContact | null): string {
    if (!contact) {
      return '';
    }

    return this.state.resolveConversationJid(contact.jid);
  }

  private scheduleComposerFocus(): void {
    if (!this.contact) {
      return;
    }

    this.shouldRestoreComposerFocus = true;

    if (this.pendingComposerFocusTimer !== null) {
      window.clearTimeout(this.pendingComposerFocusTimer);
    }

    this.pendingComposerFocusTimer = window.setTimeout(() => {
      this.pendingComposerFocusTimer = null;
      this.applyComposerFocus();
    }, 0);
  }

  private applyComposerFocus(): void {
    if (!this.shouldRestoreComposerFocus || !this.contact || this.disabled || this.isSyncingMessages) {
      return;
    }

    const composer = this.composer;
    if (!composer) {
      return;
    }

    this.shouldRestoreComposerFocus = false;
    composer.focus();
  }

  private clearComposerFocusRequest(): void {
    if (this.pendingComposerFocusTimer !== null) {
      window.clearTimeout(this.pendingComposerFocusTimer);
      this.pendingComposerFocusTimer = null;
    }

    this.shouldRestoreComposerFocus = false;
  }

  private get hasInboundTurnToAnswer(): boolean {
    const meaningfulMessages = this.messages.filter(message => Boolean(message.text?.trim()));
    const lastMessage = meaningfulMessages[meaningfulMessages.length - 1];
    return Boolean(lastMessage && !lastMessage.isFromMe);
  }

  private get autoSuggestionDelayMs(): number {
    const meaningfulMessages = this.messages.filter(message => Boolean(message.text?.trim()));
    let trailingInboundCount = 0;

    for (let index = meaningfulMessages.length - 1; index >= 0; index -= 1) {
      if (meaningfulMessages[index].isFromMe) {
        break;
      }

      trailingInboundCount += 1;
    }

    return trailingInboundCount >= 2 ? AUTO_SUGGESTION_BURST_IDLE_MS : AUTO_SUGGESTION_IDLE_MS;
  }

  private resetSuggestionState(): void {
    this.lastRequestedAiContextKey = '';
    this.aiSuggestion = '';
    this.aiSuggestionError = '';
    this.aiFeedbackMessage = '';
    this.isAiThinking = false;
    this.isAiWaitingForCustomerPause = false;
    this.pendingAiSuggestionPromotion = false;
    this.acceptedAiSuggestionDraft = '';
    this.resetSuggestionSequence();
  }

  private clearSuggestionProviders(): void {
    this.agentService.clearSuggestion();
  }

  private applySuggestionSnapshot(snapshot: { status: string; contactJid: string; contextKey?: string; suggestion: string; errorMessage: string }): void {
    const isCurrentContact = !snapshot.contactJid || snapshot.contactJid === (this.contact?.jid || '');
    const currentContextKey = this.buildAiContextKey();
    const isCurrentContext = !snapshot.contextKey || snapshot.contextKey === currentContextKey;

    if (snapshot.status !== 'idle' && (!isCurrentContact || !isCurrentContext)) {
      return;
    }

    if (snapshot.status === 'idle' && snapshot.contactJid && !isCurrentContact) {
      return;
    }

    this.isAiThinking = snapshot.status === 'thinking' && isCurrentContact && isCurrentContext;
    if (snapshot.status === 'thinking' || snapshot.status === 'ready' || snapshot.status === 'error' || snapshot.status === 'idle') {
      this.isAiWaitingForCustomerPause = false;
    }

    if (snapshot.status === 'idle' && this.hasSuggestionSequence) {
      this.aiSuggestionError = '';
      this.isAiThinking = false;
      return;
    }

    if (snapshot.status === 'ready' && isCurrentContact && isCurrentContext) {
      const parts = splitAssistantSuggestionIntoMessages(snapshot.suggestion);
      this.aiSuggestion = parts[0] || '';
      this.queuedAiSuggestionParts = parts.slice(1);
      this.aiSuggestionSequenceTotal = parts.length;
      this.aiSuggestionSequenceIndex = parts.length ? 1 : 0;
      this.aiSuggestionError = '';
      this.aiFeedbackMessage = '';
      return;
    }

    this.aiSuggestion = '';
    this.aiSuggestionError = snapshot.status === 'error' && isCurrentContact && isCurrentContext ? snapshot.errorMessage : '';
    this.aiFeedbackMessage = snapshot.status === 'error' ? '' : this.aiFeedbackMessage;

    if (snapshot.status !== 'ready') {
      this.resetSuggestionSequence();
    }
  }

  private promoteQueuedSuggestion(): boolean {
    const nextSuggestion = this.queuedAiSuggestionParts.shift();
    if (!nextSuggestion) {
      this.resetSuggestionSequence();
      return false;
    }

    this.aiSuggestion = nextSuggestion;
    this.aiSuggestionError = '';
    this.aiFeedbackMessage = '';
    this.isAiThinking = false;
    this.isAiWaitingForCustomerPause = false;
    this.aiSuggestionSequenceIndex = Math.min(this.aiSuggestionSequenceIndex + 1, this.aiSuggestionSequenceTotal);
    return true;
  }

  private resetSuggestionSequence(): void {
    this.queuedAiSuggestionParts = [];
    this.aiSuggestionSequenceTotal = 0;
    this.aiSuggestionSequenceIndex = 0;
  }

  private discardCurrentSuggestionSequence(): void {
    this.aiSuggestion = '';
    this.aiSuggestionError = '';
    this.aiFeedbackMessage = '';
    this.isAiThinking = false;
    this.isAiWaitingForCustomerPause = false;
    this.resetSuggestionSequence();
  }

  private shouldPromoteQueuedSuggestionAfterSend(text: string): boolean {
    return Boolean(
      this.pendingAiSuggestionPromotion
      && this.acceptedAiSuggestionDraft
      && this.normalizeSuggestionComparableText(text) === this.acceptedAiSuggestionDraft
    );
  }

  private normalizeSuggestionComparableText(text: string): string {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private shouldPreserveCurrentSuggestion(): boolean {
    return this.hasSuggestionSequence;
  }

  private get hasSuggestionSequence(): boolean {
    return this.aiSuggestionSequenceTotal > 1 && (Boolean(this.aiSuggestion.trim()) || this.queuedAiSuggestionParts.length > 0);
  }

  private get remainingQueuedSuggestionCount(): number {
    return this.queuedAiSuggestionParts.length;
  }
}
