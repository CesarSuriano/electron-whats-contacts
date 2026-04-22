import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

import {
  createAgentGoogleAccountProfile,
  DEFAULT_AGENT_SETTINGS,
  AgentGoogleAccountProfile,
  AgentResponseMode,
  AgentSettings,
  AgentSuggestionSnapshot,
  AgentWindowActionResult,
  IDLE_AGENT_SUGGESTION
} from '../models/agent.model';
import {
  getSensitiveDataRefusalSuggestion,
  hasSensitiveThirdPartyRequest,
  hasUnsafeSensitiveDisclosure,
  leaksSensitiveDataOutsideConversation,
  selectRecentConversationMessages,
  splitAssistantSuggestionIntoMessages
} from '../helpers/assistant-suggestion.helper';
import { WhatsappContact, WhatsappMessage } from '../models/whatsapp.model';

const SETTINGS_STORAGE_KEY = 'uniq.agent.settings.v2';
const RESPONSE_MODES: AgentResponseMode[] = ['fast', 'reasoning', 'pro'];

interface SuggestionRequest {
  contact: WhatsappContact;
  messages: WhatsappMessage[];
  contextKey: string;
  operatorInstruction?: string;
}

@Injectable({
  providedIn: 'root'
})
export class AgentService {
  private readonly settingsSubject = new BehaviorSubject<AgentSettings>(this.readStoredSettings());
  private readonly suggestionSubject = new BehaviorSubject<AgentSuggestionSnapshot>(IDLE_AGENT_SUGGESTION);
  private suggestionRunId = 0;

  constructor() {
    this.persistSettings(this.settingsSubject.value);
  }

  readonly settings$ = this.settingsSubject.asObservable();
  readonly suggestion$ = this.suggestionSubject.asObservable();

  get settings(): AgentSettings {
    return this.settingsSubject.value;
  }

  get hasConfiguration(): boolean {
    return this.settings.gemUrl.trim().length > 0;
  }

  get activeGoogleAccount(): AgentGoogleAccountProfile | null {
    return this.settings.googleAccounts.find(account => account.id === this.settings.activeGoogleAccountId) || this.settings.googleAccounts[0] || null;
  }

  updateSettings(patch: Partial<AgentSettings>): AgentSettings {
    const nextSettings = this.normalizeSettings({
      ...this.settings,
      ...patch
    });

    this.settingsSubject.next(nextSettings);
    this.persistSettings(nextSettings);
    return nextSettings;
  }

  toggleEnabled(forceValue?: boolean): AgentSettings {
    const enabled = typeof forceValue === 'boolean' ? forceValue : !this.settings.enabled;
    return this.updateSettings({ enabled });
  }

  resetSettings(): void {
    const nextSettings = this.normalizeSettings({ ...DEFAULT_AGENT_SETTINGS });
    this.settingsSubject.next(nextSettings);
    this.persistSettings(nextSettings);
    this.clearSuggestion();
  }

  createGoogleAccount(label: string): AgentGoogleAccountProfile {
    const normalizedLabel = label.trim() || 'Conta Google principal';
    const account = createAgentGoogleAccountProfile(normalizedLabel, this.generateAccountId());

    this.updateSettings({
      googleAccounts: [account],
      activeGoogleAccountId: account.id
    });

    return account;
  }

  renameGoogleAccount(accountId: string, label: string): AgentSettings {
    const normalizedLabel = label.trim();
    if (!normalizedLabel) {
      return this.settings;
    }

    return this.updateSettings({
      googleAccounts: this.settings.googleAccounts.map(account =>
        account.id === accountId ? { ...account, label: normalizedLabel } : account
      )
    });
  }

  setActiveGoogleAccount(accountId: string): AgentSettings {
    const exists = this.settings.googleAccounts.some(account => account.id === accountId);
    if (!exists) {
      return this.settings;
    }

    return this.updateSettings({ activeGoogleAccountId: accountId });
  }

  removeGoogleAccount(accountId: string): AgentSettings {
    if (!this.settings.googleAccounts.some(account => account.id === accountId)) {
      return this.settings;
    }

    return this.updateSettings({
      googleAccounts: [createAgentGoogleAccountProfile()],
      activeGoogleAccountId: DEFAULT_AGENT_SETTINGS.activeGoogleAccountId
    });
  }

  clearSuggestion(): void {
    this.suggestionRunId += 1;
    this.suggestionSubject.next(IDLE_AGENT_SUGGESTION);
  }

  async openAgentWindow(): Promise<AgentWindowActionResult> {
    const activeAccountId = this.activeGoogleAccount?.id || DEFAULT_AGENT_SETTINGS.activeGoogleAccountId;
    return this.openAgentWindowForAccount(activeAccountId);
  }

  async generateSuggestion(request: SuggestionRequest): Promise<AgentSuggestionSnapshot> {
    const settings = this.settings;
    const gemUrl = settings.gemUrl.trim();

    if (!settings.enabled) {
      this.clearSuggestion();
      return IDLE_AGENT_SUGGESTION;
    }

    if (!gemUrl) {
      const errorSnapshot = this.toSuggestionError(request, 'Configure o link do agente na tela de configuração para ativar as sugestões.');
      this.suggestionSubject.next(errorSnapshot);
      return errorSnapshot;
    }

    if (!window.electronAPI?.generateAgentSuggestion) {
      const errorSnapshot = this.toSuggestionError(request, 'A ponte Electron do agente não está disponível neste ambiente.');
      this.suggestionSubject.next(errorSnapshot);
      return errorSnapshot;
    }

    const currentRunId = ++this.suggestionRunId;
    const thinkingSnapshot: AgentSuggestionSnapshot = {
      status: 'thinking',
      contactJid: request.contact.jid,
      contextKey: request.contextKey,
      suggestion: '',
      errorMessage: '',
      source: 'none',
      updatedAt: new Date().toISOString()
    };
    this.suggestionSubject.next(thinkingSnapshot);

    const hasThirdPartySensitiveRequest = hasSensitiveThirdPartyRequest(request.contact, request.messages);

    try {
      const activeAccount = this.activeGoogleAccount || createAgentGoogleAccountProfile();
      const prompt = this.buildSuggestionPrompt(request.contact, request.messages, request.operatorInstruction || '');
      const result = await window.electronAPI.generateAgentSuggestion({
        gemUrl,
        googleAccountId: activeAccount.id,
        responseMode: settings.responseMode,
        prompt,
        keepVisible: false
      });

      if (currentRunId !== this.suggestionRunId) {
        return this.suggestionSubject.value;
      }

      if (!result.ok) {
        const errorSnapshot = this.toSuggestionError(request, result.message || 'Não foi possível gerar a sugestão pelo agente agora.');
        this.suggestionSubject.next(errorSnapshot);
        return errorSnapshot;
      }

      this.markGoogleAccountUsed(activeAccount.id);

      const suggestion = this.sanitizeSuggestion(result.text);
      if (!suggestion) {
        const errorSnapshot = this.toSuggestionError(request, 'O agente respondeu sem texto aproveitável para preencher a mensagem.');
        this.suggestionSubject.next(errorSnapshot);
        return errorSnapshot;
      }

      if (this.shouldBlockSensitiveSuggestion(request.messages, suggestion, hasThirdPartySensitiveRequest)) {
        const safeSnapshot = this.toReadySuggestion(request, getSensitiveDataRefusalSuggestion(), result.generatedAt);
        this.suggestionSubject.next(safeSnapshot);
        return safeSnapshot;
      }

      const readySnapshot = this.toReadySuggestion(request, suggestion, result.generatedAt);

      this.suggestionSubject.next(readySnapshot);
      return readySnapshot;
    } catch (error) {
      if (currentRunId !== this.suggestionRunId) {
        return this.suggestionSubject.value;
      }

      const errorSnapshot = this.toSuggestionError(
        request,
        error instanceof Error ? error.message : 'Falha inesperada ao gerar a sugestão com o agente.'
      );
      this.suggestionSubject.next(errorSnapshot);
      return errorSnapshot;
    }
  }

  private readStoredSettings(): AgentSettings {
    if (typeof localStorage === 'undefined') {
      return this.normalizeSettings({ ...DEFAULT_AGENT_SETTINGS });
    }

    try {
      const rawSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!rawSettings) {
        return this.normalizeSettings({ ...DEFAULT_AGENT_SETTINGS });
      }

      const parsedSettings = JSON.parse(rawSettings) as Partial<AgentSettings> & Record<string, unknown>;
      return this.normalizeSettings({
        ...DEFAULT_AGENT_SETTINGS,
        ...parsedSettings
      });
    } catch {
      return this.normalizeSettings({ ...DEFAULT_AGENT_SETTINGS });
    }
  }

  private persistSettings(settings: AgentSettings): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }

  private normalizeSettings(settings: Partial<AgentSettings> & Record<string, unknown>): AgentSettings {
    const normalizedAccount = this.normalizeGoogleAccount(
      settings.googleAccounts,
      typeof settings.activeGoogleAccountId === 'string' ? settings.activeGoogleAccountId : ''
    );
    const responseMode = typeof settings.responseMode === 'string' && RESPONSE_MODES.includes(settings.responseMode as AgentResponseMode)
      ? settings.responseMode as AgentResponseMode
      : DEFAULT_AGENT_SETTINGS.responseMode;

    return {
      enabled: Boolean(settings.enabled),
      gemUrl: String(settings.gemUrl || '').trim(),
      responseMode,
      googleAccounts: [normalizedAccount],
      activeGoogleAccountId: normalizedAccount.id
    };
  }

  private normalizeGoogleAccount(value: unknown, preferredId: string): AgentGoogleAccountProfile {
    const accounts = Array.isArray(value) ? value : [];
    const normalized = accounts
      .map((entry) => {
        const candidate = entry as Partial<AgentGoogleAccountProfile> | null;
        if (!candidate || typeof candidate.id !== 'string') {
          return null;
        }

        const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
        return {
          id: candidate.id.trim(),
          label: label || `Conta Google ${candidate.id.trim()}`,
          createdAt: typeof candidate.createdAt === 'string' && candidate.createdAt.trim() ? candidate.createdAt : new Date().toISOString(),
          lastUsedAt: typeof candidate.lastUsedAt === 'string' && candidate.lastUsedAt.trim() ? candidate.lastUsedAt : null
        };
      })
      .filter((account): account is AgentGoogleAccountProfile => Boolean(account?.id));

    if (!normalized.length) {
      return createAgentGoogleAccountProfile();
    }

    const preferredAccount = normalized.find(account => account.id === preferredId) || null;
    if (preferredAccount && this.isKnownGoogleAccount(preferredAccount)) {
      return preferredAccount;
    }

    return normalized.find(account => this.isKnownGoogleAccount(account)) || createAgentGoogleAccountProfile();
  }

  private async openAgentWindowForAccount(accountId: string): Promise<AgentWindowActionResult> {
    const gemUrl = this.settings.gemUrl.trim();

    if (!gemUrl) {
      return {
        ok: false,
        message: 'Informe o link do agente antes de abrir a autenticação do Google.'
      };
    }

    if (!window.electronAPI?.openAgentWindow) {
      return {
        ok: false,
        message: 'A ponte Electron do agente não está disponível neste ambiente.'
      };
    }

    const existingAccount = this.activeGoogleAccount || createAgentGoogleAccountProfile();

    try {
      const result = await window.electronAPI.openAgentWindow({
        gemUrl,
        googleAccountId: accountId,
        keepVisible: true
      });
      const detectedAccountLabel = result.detectedAccountLabel?.trim() || '';

      if (result.ok && detectedAccountLabel) {
        this.storeAuthenticatedGoogleAccount(accountId, detectedAccountLabel, existingAccount.createdAt);
        return result;
      }

      if (result.ok && this.isKnownGoogleAccount(existingAccount)) {
        this.markGoogleAccountUsed(accountId);
        return result;
      }

      if (result.ok) {
        return {
          ...result,
          message: 'Janela aberta. Faça login na conta Google nessa aba para que a autenticação fique salva nesta máquina.'
        };
      }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Não foi possível abrir a janela do agente agora.'
      };
    }

    return {
      ok: false,
      message: 'Não foi possível abrir a janela do agente agora.'
    };
  }

  private storeAuthenticatedGoogleAccount(accountId: string, label: string, createdAt: string): AgentGoogleAccountProfile {
    const normalizedLabel = label.trim();
    const usedAt = new Date().toISOString();
    const detectedAccount: AgentGoogleAccountProfile = {
      id: accountId,
      label: normalizedLabel,
      createdAt,
      lastUsedAt: usedAt
    };
    const nextSettings = this.updateSettings({
      googleAccounts: [detectedAccount],
      activeGoogleAccountId: accountId
    });

    return nextSettings.googleAccounts.find(account => account.id === accountId) || nextSettings.googleAccounts[0];
  }

  private markGoogleAccountUsed(accountId: string): AgentGoogleAccountProfile | null {
    const existingAccount = this.settings.googleAccounts.find(account => account.id === accountId) || null;
    if (!existingAccount) {
      return null;
    }

    const usedAt = new Date().toISOString();
    const nextSettings = this.updateSettings({
      googleAccounts: this.settings.googleAccounts.map(account =>
        account.id === accountId
          ? { ...account, lastUsedAt: usedAt }
          : account
      ),
      activeGoogleAccountId: accountId
    });

    return nextSettings.googleAccounts.find(account => account.id === accountId) || nextSettings.googleAccounts[0];
  }

  private isKnownGoogleAccount(account: AgentGoogleAccountProfile): boolean {
    const normalizedLabel = account.label.trim().toLowerCase();
    if (!normalizedLabel) {
      return false;
    }

    if (this.isGeneratedGoogleAccountLabel(normalizedLabel)) {
      return false;
    }

    return Boolean(account.lastUsedAt || normalizedLabel);
  }

  private isGeneratedGoogleAccountLabel(normalizedLabel: string): boolean {
    return normalizedLabel === 'conta google principal'
      || normalizedLabel === 'conta principal'
      || normalizedLabel === 'primary'
      || /^conta\s+\d+$/.test(normalizedLabel)
      || /^conta google\s+.+$/.test(normalizedLabel);
  }

  private buildSuggestionPrompt(contact: WhatsappContact, messages: WhatsappMessage[], operatorInstruction = ''): string {
    const recentMessages = selectRecentConversationMessages(messages);
    const fullConversation = recentMessages
      .filter(message => Boolean(message.text?.trim()))
      .map(message => `${message.isFromMe ? 'Vendedora' : 'Cliente'}: ${message.text.trim()}`)
      .join('\n');
    const normalizedOperatorInstruction = String(operatorInstruction || '').trim();

    return [
      'Contexto recente da conversa atual para o agente já configurado no Google:',
      normalizedOperatorInstruction
        ? `Pedido pontual do operador para esta resposta:\n${normalizedOperatorInstruction}`
        : '',
      `Contato atual: ${contact.name || contact.phone || contact.jid}`,
      `Mensagens recentes da conversa:\n${fullConversation || 'Sem mensagens textuais recentes na conversa.'}`
    ].filter(Boolean).join('\n\n');
  }

  private sanitizeSuggestion(text: string): string {
    const normalizedText = text
      .normalize('NFC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/^```[\w-]*\s*/g, '')
      .replace(/```$/g, '')
      .replace(/^"|"$/g, '')
      .replace(/^'|'$/g, '')
      .replace(/^Mensagem:\s*/i, '')
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/[ ]{2,}/g, ' ')
      .replace(/\s+([!?.,:;])/g, '$1')
      .trim();

    const parts = splitAssistantSuggestionIntoMessages(normalizedText);
    return parts.length ? parts.join(' ||| ') : normalizedText;
  }

  private toSuggestionError(request: SuggestionRequest, message: string): AgentSuggestionSnapshot {
    return {
      status: 'error',
      contactJid: request.contact.jid,
      contextKey: request.contextKey,
      suggestion: '',
      errorMessage: message,
      source: 'none',
      updatedAt: new Date().toISOString()
    };
  }

  private toReadySuggestion(request: SuggestionRequest, suggestion: string, updatedAt: string): AgentSuggestionSnapshot {
    return {
      status: 'ready',
      contactJid: request.contact.jid,
      contextKey: request.contextKey,
      suggestion,
      errorMessage: '',
      source: 'gem',
      updatedAt
    };
  }

  private shouldBlockSensitiveSuggestion(messages: WhatsappMessage[], suggestion: string, hasThirdPartySensitiveRequest: boolean): boolean {
    if (hasThirdPartySensitiveRequest && hasUnsafeSensitiveDisclosure(suggestion)) {
      return true;
    }

    if (hasThirdPartySensitiveRequest && leaksSensitiveDataOutsideConversation(suggestion, messages)) {
      return true;
    }

    return leaksSensitiveDataOutsideConversation(suggestion, messages);
  }

  private generateAccountId(): string {
    return `google-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}