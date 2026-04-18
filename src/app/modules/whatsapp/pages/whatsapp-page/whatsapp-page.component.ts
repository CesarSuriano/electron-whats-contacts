import { Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import * as QRCode from 'qrcode';

import { APP_VERSION, APP_WHATS_NEW } from '../../../../helpers/app-info.helper';
import { ScheduleListLauncherService } from '../../../../services/schedule-list-launcher.service';
import { WhatsappSessionStatus, WhatsappWebjsGatewayService } from '../../../../services/whatsapp-webjs-gateway.service';
import { WhatsappWsService } from '../../../../services/whatsapp-ws.service';

const BRIDGE_STARTUP_GRACE_PERIOD_MS = 10_000;
const SESSION_STATUS_RETRY_INTERVAL_MS = 1_000;
const SESSION_CONNECT_RETRY_INTERVAL_MS = 1_500;

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
  isSessionActionLoading = false;
  currentSessionStatus = 'initializing';
  sessionStatusText = 'Verificando sessão do WhatsApp...';
  qrCodeDataUrl = '';
  sessionErrorMessage = '';
  readonly appVersion = APP_VERSION;
  readonly appWhatsNew = APP_WHATS_NEW;

  private sessionStatusRetryTimerId: number | null = null;
  private connectRetryTimerId: number | null = null;
  private sessionStatusErrorGraceUntil = 0;
  private readonly destroy$ = new Subject<void>();

  constructor(
    private router: Router,
    private whatsappGatewayService: WhatsappWebjsGatewayService,
    private ws: WhatsappWsService,
    private scheduleListLauncher: ScheduleListLauncherService
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
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.stopSessionStatusRetry();
    this.stopConnectRetry();
  }

  goToHome(): void {
    void this.router.navigate(['/']);
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
      this.scheduleConnectRetry();
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
}
