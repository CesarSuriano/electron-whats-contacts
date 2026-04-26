import { Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Subject, Subscription } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import * as QRCode from 'qrcode';

import { AppShellSection } from '../../../../models/shell.model';
import { APP_VERSION, APP_WHATS_NEW } from '../../../../helpers/app-info.helper';
import { WhatsappLabel } from '../../../../models/whatsapp.model';
import { AgentService } from '../../../../services/agent.service';
import { ManagerLaunchService } from '../../../../services/manager-launch.service';
import { ScheduleListLauncherService } from '../../../../services/schedule-list-launcher.service';
import { ScheduledMessageService } from '../../../../services/scheduled-message.service';
import { WhatsappSessionStatus, WhatsappWebjsGatewayService } from '../../../../services/whatsapp-webjs-gateway.service';
import { WhatsappWsService } from '../../../../services/whatsapp-ws.service';

const BRIDGE_STARTUP_GRACE_PERIOD_MS = 10_000;
const SESSION_STATUS_RETRY_INTERVAL_MS = 1_000;
const SESSION_CONNECT_RETRY_INTERVAL_MS = 1_500;
const WHATSAPP_LABELS_RETRY_INTERVAL_MS = 2_500;

@Component({
  selector: 'app-whatsapp-page',
  templateUrl: './whatsapp-page.component.html',
  styleUrls: ['./whatsapp-page.component.scss']
})
export class WhatsappPageComponent implements OnInit, OnDestroy {
  isCheckingSession = true;
  isSessionReady = false;
  isAboutModalOpen = false;
  isDisconnectModalOpen = false;
  isQuickReplyManagerOpen = false;
  isLabelManagerOpen = false;
  isSessionActionLoading = false;
  currentSessionStatus = 'initializing';
  sessionStatusText = 'Verificando sessão do WhatsApp...';
  qrCodeDataUrl = '';
  sessionErrorMessage = '';
  isAgentEnabled = false;
  hasAgentConfiguration = false;
  schedulesBadgeCount = 0;
  whatsappInitLabels: WhatsappLabel[] = [];
  isLoadingWhatsappLabels = false;
  whatsappLabelsStatusText = 'Tentando carregar etiquetas do WhatsApp durante a inicialização...';
  whatsappLabelsError = '';
  readonly appVersion = APP_VERSION;
  readonly appWhatsNew = APP_WHATS_NEW;

  private sessionStatusRetryTimerId: number | null = null;
  private connectRetryTimerId: number | null = null;
  private labelsRetryTimerId: number | null = null;
  private labelsLoadSubscription: Subscription | null = null;
  private hasLoadedLabelsAfterReady = false;
  private sessionStatusErrorGraceUntil = 0;
  private readonly destroy$ = new Subject<void>();

  constructor(
    private router: Router,
    private agentService: AgentService,
    private whatsappGatewayService: WhatsappWebjsGatewayService,
    private ws: WhatsappWsService,
    private scheduleListLauncher: ScheduleListLauncherService,
    private scheduledMessageService: ScheduledMessageService,
    private managerLaunch: ManagerLaunchService
  ) {}

  ngOnInit(): void {
    this.ws.connect();
    this.startInitialSessionCheck();

    // Real-time session state via WebSocket
    this.ws.on<WhatsappSessionStatus>('session_state').pipe(takeUntil(this.destroy$)).subscribe(status => {
      if (status && status.status) {
        this.stopSessionStatusRetry();
        this.isCheckingSession = false;
        this.sessionErrorMessage = '';
        this.updateSessionState(status);
      }
    });

    // Real-time labels via WebSocket (muda no celular → refletido aqui sem recarregar)
    this.ws.on<{ labels: WhatsappLabel[] }>('labels_updated').pipe(takeUntil(this.destroy$)).subscribe(payload => {
      const labels = Array.isArray(payload?.labels) ? payload.labels : [];
      this.applyWhatsappLabels(labels, { fromWebSocket: true });
    });

    this.agentService.settings$.pipe(takeUntil(this.destroy$)).subscribe(settings => {
      this.isAgentEnabled = settings.enabled;
      this.hasAgentConfiguration = settings.gemUrl.trim().length > 0;
    });

    this.managerLaunch.openQuickReplyManager$
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => (this.isQuickReplyManagerOpen = true));

    this.managerLaunch.openLabelManager$
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => (this.isLabelManagerOpen = true));

    this.scheduledMessageService.schedules$
      .pipe(takeUntil(this.destroy$))
      .subscribe(list => {
        this.schedulesBadgeCount = list.filter(schedule =>
          schedule.status === 'pending' || schedule.status === 'notified'
        ).length;
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.stopSessionStatusRetry();
    this.stopConnectRetry();
    this.cancelWhatsappLabelsLoad();
    this.stopWhatsappLabelsRetry();
  }

  trackByWhatsappLabelId(_index: number, label: WhatsappLabel): string {
    return label.id;
  }

  getWhatsappLabelColor(label: WhatsappLabel): string {
    const raw = (label.hexColor || '').trim();
    if (!raw) {
      return '#128c7e';
    }
    return raw.startsWith('#') ? raw : `#${raw}`;
  }

  goToHome(): void {
    void this.router.navigate(['/']);
  }

  onShellSectionSelect(section: AppShellSection): void {
    if (section === 'whatsapp') {
      return;
    }

    if (section === 'agent') {
      void this.router.navigate(['/agente']);
      return;
    }

    void this.router.navigate(['/'], {
      queryParams: { view: section }
    });
  }

  goToAgent(): void {
    void this.router.navigate(['/agente']);
  }

  toggleAgent(): void {
    if (!this.hasAgentConfiguration) {
      this.goToAgent();
      return;
    }

    const nextEnabled = !this.isAgentEnabled;
    this.agentService.toggleEnabled(nextEnabled);
  }

  get agentToggleLabel(): string {
    if (this.isAgentEnabled) {
      return 'Desativar agente';
    }

    return this.hasAgentConfiguration ? 'Ativar agente' : 'Configurar agente';
  }

  get agentToggleStateLabel(): string {
    if (this.isAgentEnabled) {
      return 'Ligado';
    }

    return this.hasAgentConfiguration ? 'Desligado' : 'Configurar';
  }

  openAboutModal(): void {
    this.isAboutModalOpen = true;
  }

  openScheduleList(): void {
    this.scheduleListLauncher.requestOpen();
  }

  closeAboutModal(): void {
    this.isAboutModalOpen = false;
  }

  openQuickReplyManager(): void {
    this.isQuickReplyManagerOpen = true;
  }

  closeQuickReplyManager(): void {
    this.isQuickReplyManagerOpen = false;
  }

  openLabelManager(): void {
    this.isLabelManagerOpen = true;
  }

  closeLabelManager(): void {
    this.isLabelManagerOpen = false;
  }

  get connectActionLabel(): string {
    return this.shouldShowDisconnectAction ? 'Desconectar do WhatsApp' : 'Conectar ao WhatsApp';
  }

  get shouldShowDisconnectAction(): boolean {
    return this.currentSessionStatus === 'ready'
      || this.currentSessionStatus === 'authenticated'
      || this.currentSessionStatus === 'qr_required';
  }

  onToggleSessionConnection(): void {
    if (this.isSessionActionLoading) {
      return;
    }

    if (this.shouldShowDisconnectAction) {
      this.isDisconnectModalOpen = true;
      return;
    }

    this.connectSession();
  }

  closeDisconnectModal(): void {
    if (this.isSessionActionLoading) {
      return;
    }
    this.isDisconnectModalOpen = false;
  }

  confirmDisconnect(): void {
    if (this.isSessionActionLoading) {
      return;
    }

    this.isSessionActionLoading = true;
    this.whatsappGatewayService.disconnectSession().subscribe({
      next: status => {
        this.isSessionActionLoading = false;
        this.isDisconnectModalOpen = false;
        this.updateSessionState(status);
      },
      error: () => {
        this.isSessionActionLoading = false;
        this.isDisconnectModalOpen = false;
        this.sessionErrorMessage = 'Não foi possível desconectar o WhatsApp agora.';
      }
    });
  }

  retrySession(): void {
    this.startInitialSessionCheck();
  }

  private startInitialSessionCheck(): void {
    this.stopSessionStatusRetry();
    this.stopConnectRetry();
    this.isCheckingSession = true;
    this.sessionErrorMessage = '';
    this.sessionStatusText = 'Verificando sessão do WhatsApp...';
    this.sessionStatusErrorGraceUntil = Date.now() + BRIDGE_STARTUP_GRACE_PERIOD_MS;
    this.checkSession();
  }

  private scheduleSessionStatusRetry(): void {
    if (this.sessionStatusRetryTimerId !== null) {
      return;
    }

    this.sessionStatusRetryTimerId = window.setTimeout(() => {
      this.sessionStatusRetryTimerId = null;
      this.checkSession();
    }, SESSION_STATUS_RETRY_INTERVAL_MS);
  }

  private stopSessionStatusRetry(): void {
    if (this.sessionStatusRetryTimerId !== null) {
      window.clearTimeout(this.sessionStatusRetryTimerId);
      this.sessionStatusRetryTimerId = null;
    }
  }

  private scheduleConnectRetry(): void {
    if (this.connectRetryTimerId !== null || this.isSessionActionLoading || this.isSessionReady) {
      return;
    }

    this.connectRetryTimerId = window.setTimeout(() => {
      this.connectRetryTimerId = null;
      if (!this.isSessionReady && !this.isSessionActionLoading) {
        this.connectSession();
      }
    }, SESSION_CONNECT_RETRY_INTERVAL_MS);
  }

  private stopConnectRetry(): void {
    if (this.connectRetryTimerId !== null) {
      window.clearTimeout(this.connectRetryTimerId);
      this.connectRetryTimerId = null;
    }
  }

  private checkSession(): void {
    this.whatsappGatewayService.loadSessionStatus().subscribe({
      next: status => {
        this.stopSessionStatusRetry();
        this.isCheckingSession = false;
        this.sessionErrorMessage = '';
        this.updateSessionState(status);
      },
      error: () => {
        if (Date.now() < this.sessionStatusErrorGraceUntil) {
          this.isSessionReady = false;
          this.qrCodeDataUrl = '';
          this.isCheckingSession = true;
          this.sessionStatusText = 'Aguardando a bridge do WhatsApp iniciar...';
          this.sessionErrorMessage = '';
          this.scheduleSessionStatusRetry();
          return;
        }

        this.isSessionReady = false;
        this.qrCodeDataUrl = '';
        this.isCheckingSession = false;
        this.sessionStatusText = 'Não foi possível validar a sessão do WhatsApp.';
        this.sessionErrorMessage = 'Verifique se a bridge está rodando e tente novamente.';
      }
    });
  }

  private connectSession(): void {
    if (this.isSessionActionLoading) {
      return;
    }

    this.isSessionActionLoading = true;
    this.sessionErrorMessage = '';

    this.whatsappGatewayService.connectSession().subscribe({
      next: status => {
        this.isSessionActionLoading = false;
        this.updateSessionState(status);
      },
      error: () => {
        this.isSessionActionLoading = false;
        this.sessionErrorMessage = 'Não foi possível iniciar a conexão do WhatsApp.';
        this.scheduleConnectRetry();
      }
    });
  }

  private updateSessionState(status: WhatsappSessionStatus): void {
    this.currentSessionStatus = status.status;
    this.isSessionReady = status.status === 'ready';
    this.syncLabelsLoadWithSessionState(status.status);

    if (this.isSessionReady) {
      this.stopConnectRetry();
      this.qrCodeDataUrl = '';
      this.sessionStatusText = 'Sessão ativa. Carregando console...';
      return;
    }

    if (status.status === 'qr_required' && status.qr) {
      this.stopConnectRetry();
      this.sessionStatusText = 'Escaneie o QR code para autenticar o WhatsApp.';
      void this.updateQrCode(status.qr);
      return;
    }

    if (status.status === 'authenticated') {
      this.stopConnectRetry();
      this.sessionStatusText = 'Sessão autenticada. Aguardando WhatsApp ficar pronto...';
      this.qrCodeDataUrl = '';
      return;
    }

    if (status.status === 'disconnected') {
      this.sessionStatusText = 'WhatsApp desconectado. Aguardando novo QR code...';
      this.qrCodeDataUrl = '';
      this.stopConnectRetry();
      return;
    }

    if (status.status === 'auth_failure') {
      this.sessionStatusText = 'Falha de autenticação. Aguarde um novo QR code.';
      this.qrCodeDataUrl = '';
      this.scheduleConnectRetry();
      return;
    }

    if (status.status === 'init_error') {
      this.sessionStatusText = 'Erro ao inicializar sessão. Tentando reconectar...';
      this.qrCodeDataUrl = '';
      this.scheduleConnectRetry();
      return;
    }

    this.sessionStatusText = 'Inicializando sessão do WhatsApp...';
    this.qrCodeDataUrl = '';
    this.scheduleSessionStatusRetry();
  }

  private async updateQrCode(qrText: string): Promise<void> {
    try {
      this.qrCodeDataUrl = await QRCode.toDataURL(qrText, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 280
      });
    } catch {
      this.qrCodeDataUrl = '';
      this.sessionErrorMessage = 'Não foi possível renderizar o QR code. Use o QR do terminal.';
    }
  }

  private syncLabelsLoadWithSessionState(status: string): void {
    if (status === 'disconnected' || status === 'auth_failure' || status === 'init_error') {
      this.hasLoadedLabelsAfterReady = false;
      this.cancelWhatsappLabelsLoad();
      this.stopWhatsappLabelsRetry();
      this.whatsappInitLabels = [];
      this.whatsappLabelsError = '';
      this.whatsappLabelsStatusText = status === 'disconnected'
        ? 'Sessão desconectada. As etiquetas serão recarregadas quando o WhatsApp voltar.'
        : 'Aguardando sessão pronta para listar etiquetas...';
      return;
    }

    if (status === 'ready') {
      if (this.whatsappInitLabels.length) {
        this.hasLoadedLabelsAfterReady = true;
        this.whatsappLabelsError = '';
        this.whatsappLabelsStatusText = `${this.whatsappInitLabels.length} etiqueta(s) carregada(s) do WhatsApp.`;
        this.stopWhatsappLabelsRetry();
        return;
      }

      this.requestWhatsappLabelsLoad(true);
      return;
    }

    this.cancelWhatsappLabelsLoad();
    this.stopWhatsappLabelsRetry();
  }

  private requestWhatsappLabelsLoad(immediate = false): void {
    if (this.isLoadingWhatsappLabels) {
      return;
    }

    if (immediate) {
      this.stopWhatsappLabelsRetry();
      this.loadWhatsappLabels();
      return;
    }

    if (this.labelsRetryTimerId !== null) {
      return;
    }

    this.labelsRetryTimerId = window.setTimeout(() => {
      this.labelsRetryTimerId = null;
      this.loadWhatsappLabels();
    }, WHATSAPP_LABELS_RETRY_INTERVAL_MS);
  }

  private stopWhatsappLabelsRetry(): void {
    if (this.labelsRetryTimerId !== null) {
      window.clearTimeout(this.labelsRetryTimerId);
      this.labelsRetryTimerId = null;
    }
  }

  private cancelWhatsappLabelsLoad(): void {
    this.labelsLoadSubscription?.unsubscribe();
    this.labelsLoadSubscription = null;
    this.isLoadingWhatsappLabels = false;
  }

  private loadWhatsappLabels(): void {
    this.cancelWhatsappLabelsLoad();
    this.isLoadingWhatsappLabels = true;
    this.whatsappLabelsError = '';

    this.labelsLoadSubscription = this.whatsappGatewayService.loadLabels().subscribe({
      next: labels => {
        this.labelsLoadSubscription = null;
        this.isLoadingWhatsappLabels = false;
        this.applyWhatsappLabels(labels, { fromWebSocket: false });
      },
      error: () => {
        this.labelsLoadSubscription = null;
        this.isLoadingWhatsappLabels = false;
        this.whatsappLabelsError = 'Não foi possível buscar etiquetas agora. Tentando novamente...';

        if (this.currentSessionStatus === 'ready' && this.hasLoadedLabelsAfterReady) {
          return;
        }

        this.requestWhatsappLabelsLoad();
      }
    });
  }

  private applyWhatsappLabels(labels: WhatsappLabel[], options: { fromWebSocket: boolean }): void {
    this.whatsappInitLabels = [...labels].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

    if (this.currentSessionStatus === 'ready') {
      if (this.whatsappInitLabels.length) {
        this.hasLoadedLabelsAfterReady = true;
        this.whatsappLabelsStatusText = `${this.whatsappInitLabels.length} etiqueta(s) carregada(s) do WhatsApp.`;
        this.stopWhatsappLabelsRetry();
        return;
      }

      this.whatsappLabelsStatusText = 'Sessão pronta. Aguardando etiquetas do WhatsApp...';
      return;
    }

    this.whatsappLabelsStatusText = this.whatsappInitLabels.length
      ? `${this.whatsappInitLabels.length} etiqueta(s) encontrada(s) durante a inicialização.`
      : 'Inicializando WhatsApp. Aguardando sessão pronta para listar etiquetas...';
  }
}
