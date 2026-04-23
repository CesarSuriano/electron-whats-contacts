import { Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { AppShellSection } from '../../../../models/shell.model';
import { AgentGoogleAccountProfile, AgentResponseMode, AgentSettings } from '../../../../models/agent.model';
import { AgentService } from '../../../../services/agent.service';

interface ResponseModeOption {
  value: AgentResponseMode;
  label: string;
  description: string;
}

interface FlowStep {
  title: string;
  description: string;
}

@Component({
  selector: 'app-agent-page',
  templateUrl: './agent-page.component.html',
  styleUrls: ['./agent-page.component.scss']
})
export class AgentPageComponent implements OnInit, OnDestroy {
  draftSettings: AgentSettings;
  feedbackMessage = '';
  feedbackVariant: 'success' | 'error' = 'success';
  isSavingSettings = false;
  isOpeningWindow = false;

  readonly responseModeOptions: ResponseModeOption[] = [
    {
      value: 'fast',
      label: 'Respostas rápidas',
      description: 'Prioriza agilidade para devolver a sugestão o quanto antes.'
    },
    {
      value: 'reasoning',
      label: 'Raciocínio',
      description: 'Usa mais análise antes de responder.'
    },
    {
      value: 'pro',
      label: 'Pro',
      description: 'Usa o modo mais forte disponível no agente.'
    }
  ];

  readonly flowSteps: FlowStep[] = [
    {
      title: 'Cole o link do agente',
      description: 'Aqui entra apenas a URL do agente que já está configurado no Google.'
    },
    {
      title: 'Faça login com Google',
      description: 'Faça login uma única vez na conta Google do agente. O app reaproveita essa autenticação nesta máquina.'
    },
    {
      title: 'Use no WhatsApp',
      description: 'Depois é só voltar para o WhatsApp e ligar o agente no header da conversa.'
    }
  ];

  private readonly destroy$ = new Subject<void>();

  constructor(private agentService: AgentService, private router: Router) {
    this.draftSettings = this.cloneSettings(this.agentService.settings);
  }

  ngOnInit(): void {
    this.agentService.settings$.pipe(takeUntil(this.destroy$)).subscribe(settings => {
      this.draftSettings = this.cloneSettings(settings);
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  onShellSectionSelect(section: AppShellSection): void {
    if (section === 'agent') {
      return;
    }

    if (section === 'whatsapp') {
      void this.router.navigate(['/whatsapp']);
      return;
    }

    void this.router.navigate(['/'], {
      queryParams: { view: section }
    });
  }

  async saveSettings(showFeedback = true): Promise<boolean> {
    this.isSavingSettings = true;

    try {
      this.agentService.updateSettings(this.cloneSettings(this.draftSettings));

      if (showFeedback) {
        this.showFeedback('Configuração salva.', 'success');
      }

      return true;
    } catch (error) {
      this.showFeedback(
        error instanceof Error && error.message.trim()
          ? error.message
          : 'Não foi possível salvar a configuração do agente.',
        'error'
      );
      return false;
    } finally {
      this.isSavingSettings = false;
    }
  }

  async openAgentWindow(): Promise<void> {
    const saved = await this.saveSettings(false);
    if (!saved) {
      return;
    }

    this.isOpeningWindow = true;

    try {
      const result = await this.agentService.openAgentWindow();
      this.showFeedback(result.message, result.ok ? 'success' : 'error');
    } finally {
      this.isOpeningWindow = false;
    }
  }

  async authenticateGoogleAccount(): Promise<void> {
    await this.openAgentWindow();
  }

  goToWhatsapp(): void {
    void this.router.navigate(['/whatsapp']);
  }

  goToDashboard(): void {
    void this.router.navigate(['/']);
  }

  get activeGoogleAccount(): AgentGoogleAccountProfile | null {
    return this.draftSettings.googleAccounts.find(account => account.id === this.draftSettings.activeGoogleAccountId)
      || this.draftSettings.googleAccounts[0]
      || null;
  }

  get activeGoogleAccountLabel(): string {
    return this.getGoogleAccountLabel(this.getAuthenticatedGoogleAccount());
  }

  get activeGoogleAccountMeta(): string {
    return this.getGoogleAccountMeta(this.getAuthenticatedGoogleAccount());
  }

  get hasAuthenticatedGoogleAccount(): boolean {
    return Boolean(this.getAuthenticatedGoogleAccount());
  }

  get isAgentConfigured(): boolean {
    return this.draftSettings.gemUrl.trim().length > 0;
  }

  private cloneSettings(settings: AgentSettings): AgentSettings {
    return {
      ...settings,
      googleAccounts: settings.googleAccounts.map(account => ({ ...account }))
    };
  }

  private showFeedback(message: string, variant: 'success' | 'error'): void {
    this.feedbackMessage = message;
    this.feedbackVariant = variant;
  }

  getGoogleAccountLabel(account: AgentGoogleAccountProfile | null): string {
    if (!account) {
      return 'Nenhuma conta autenticada';
    }

    const normalizedLabel = account.label.trim();
    if (!normalizedLabel || this.isGeneratedGoogleAccountLabel(normalizedLabel.toLowerCase())) {
      return 'Conta Google ainda não identificada';
    }

    return normalizedLabel;
  }

  getGoogleAccountMeta(account: AgentGoogleAccountProfile | null): string {
    if (!account) {
      return 'Clique em Autenticar conta Google para fazer login uma vez e salvar a sessão nesta máquina.';
    }

    if (account.lastUsedAt) {
      return `Usada por último em ${new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(account.lastUsedAt))}`;
    }

    return 'Abra a autenticação e faça login na conta Google que deve ficar salva neste computador.';
  }

  private getAuthenticatedGoogleAccount(): AgentGoogleAccountProfile | null {
    const activeAccount = this.activeGoogleAccount;
    return activeAccount && this.isKnownGoogleAccount(activeAccount) ? activeAccount : null;
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
}
