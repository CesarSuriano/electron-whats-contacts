import { Component, Input, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { AgentService } from '../../../../services/agent.service';
import { splitAssistantSuggestionIntoMessages } from '../../../../helpers/assistant-suggestion.helper';
import { WhatsappContact, WhatsappMessage } from '../../../../models/whatsapp.model';
import { BulkSendService } from '../../services/bulk-send.service';
import { AssistantFeedbackService } from '../../services/assistant-feedback.service';
import { WhatsappStateService } from '../../services/whatsapp-state.service';
import { ComposerComponent } from '../composer/composer.component';

const AUTO_SUGGESTION_IDLE_MS = 1800;
const AUTO_SUGGESTION_BURST_IDLE_MS = 2800;

@Component({
  selector: 'app-chat-view',
  templateUrl: './chat-view.component.html',
  styleUrls: ['./chat-view.component.scss']
})
export class ChatViewComponent implements OnInit, OnDestroy {
  @Input() disabled = false;
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

  private lastRequestedAiContextKey = '';
  private suggestionTimerId: number | null = null;
  private queuedAiSuggestionParts: string[] = [];
  private aiSuggestionSequenceTotal = 0;
  private aiSuggestionSequenceIndex = 0;
  private pendingAiSuggestionPromotion = false;
  private acceptedAiSuggestionDraft = '';

  private readonly destroy$ = new Subject<void>();

  constructor(
    private state: WhatsappStateService,
    private bulkSend: BulkSendService,
    private agentService: AgentService,
    private assistantFeedback: AssistantFeedbackService
  ) {}

  ngOnInit(): void {
    this.state.selectedContact$.pipe(takeUntil(this.destroy$)).subscribe(contact => {
      if (contact?.jid !== this.contact?.jid) {
        this.resetSuggestionState();
        this.clearSuggestionProviders();
      }

      this.contact = contact;

      if (!contact) {
        this.clearSuggestionProviders();
      }

      this.scheduleAiSuggestion();
    });

    this.state.selectedMessages$.pipe(takeUntil(this.destroy$)).subscribe(messages => {
      this.messages = messages;
      this.scheduleAiSuggestion();
    });

    this.state.selectedContactJid$
      .pipe(takeUntil(this.destroy$))
      .subscribe(jid => {
        if (!jid) {
          return;
        }

        setTimeout(() => this.composer?.focus(), 0);
      });

    this.state.loadingState$.pipe(takeUntil(this.destroy$)).subscribe(state => {
      this.isSending = state.sending;
      this.isSyncingMessages = state.messages;
      this.scheduleAiSuggestion();
    });

    this.state.draftText$.pipe(takeUntil(this.destroy$)).subscribe(text => {
      if (text !== this.draftText) {
        this.draftText = text;
      }

      this.scheduleAiSuggestion();
    });

    this.state.draftImageDataUrl$.pipe(takeUntil(this.destroy$)).subscribe(dataUrl => {
      if (dataUrl) {
        setTimeout(() => this.composer?.setAttachmentFromDataUrl(dataUrl, 'imagem-template.jpg'), 0);
      }
    });

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

  ngOnDestroy(): void {
    if (this.suggestionTimerId !== null) {
      window.clearTimeout(this.suggestionTimerId);
    }

    this.destroy$.next();
    this.destroy$.complete();
  }

  onDraftChange(value: string): void {
    this.draftText = value;

    if (
      this.acceptedAiSuggestionDraft
      && this.normalizeSuggestionComparableText(value) !== this.acceptedAiSuggestionDraft
    ) {
      this.pendingAiSuggestionPromotion = false;
      this.acceptedAiSuggestionDraft = '';
      this.discardCurrentSuggestionSequence();
    }

    this.state.setDraftText(value);
  }

  onAcceptAiSuggestion(value: string): void {
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
    this.scheduleAiSuggestion(true);
  }

  onGuidedAiSuggestion(instruction: string): void {
    this.requestAiSuggestionNow(instruction);
  }

  onRateAiSuggestion(rating: 'up' | 'down'): void {
    if (!this.contact || !this.aiSuggestion.trim()) {
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
    if (!this.contact || this.disabled || this.isSyncingMessages) {
      return;
    }

    const shouldPromoteQueuedSuggestion = this.shouldPromoteQueuedSuggestionAfterSend(text);
    if (!shouldPromoteQueuedSuggestion) {
      this.discardCurrentSuggestionSequence();
    }

    this.state.sendText(this.contact.jid, text).subscribe({
      next: () => {
        if (!this.bulkSend.hasActiveQueue) {
          this.composer?.resetAfterSend();
          this.draftText = '';
          this.state.setDraftText('');
          this.clearSuggestionProviders();

          if (!shouldPromoteQueuedSuggestion || !this.promoteQueuedSuggestion()) {
            this.discardCurrentSuggestionSequence();
            this.lastRequestedAiContextKey = '';
          }

          this.pendingAiSuggestionPromotion = false;
          this.acceptedAiSuggestionDraft = '';
        }
      },
      error: () => {}
    });
  }

  onSendMedia(payload: { file: File; caption: string }): void {
    if (!this.contact || this.disabled || this.isSyncingMessages) {
      return;
    }

    this.discardCurrentSuggestionSequence();
    this.pendingAiSuggestionPromotion = false;
    this.acceptedAiSuggestionDraft = '';

    this.state.sendMedia(this.contact.jid, payload.file, payload.caption).subscribe({
      next: () => {
        if (!this.bulkSend.hasActiveQueue) {
          this.composer?.resetAfterSend();
          this.draftText = '';
          this.state.setDraftText('');
          this.clearSuggestionProviders();

          this.lastRequestedAiContextKey = '';
        }
      },
      error: () => {}
    });
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
    return this.isAgentEnabled;
  }

  private scheduleAiSuggestion(force = false): void {
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
    return this.isAgentEnabled && this.hasAgentConfiguration;
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
