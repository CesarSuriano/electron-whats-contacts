import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { BehaviorSubject, EMPTY, Subject, of, throwError } from 'rxjs';

import { WhatsappLabel } from '../../../../models/whatsapp.model';
import { AgentService } from '../../../../services/agent.service';
import { ScheduleListLauncherService } from '../../../../services/schedule-list-launcher.service';
import { ScheduledMessageService } from '../../../../services/scheduled-message.service';
import { WhatsappSessionStatus, WhatsappWebjsGatewayService } from '../../../../services/whatsapp-webjs-gateway.service';
import { WhatsappWsService } from '../../../../services/whatsapp-ws.service';
import { ScheduledMessage } from '../../../../models/scheduled-message.model';
import { WhatsappPageComponent } from './whatsapp-page.component';

const makeStatus = (status: string): WhatsappSessionStatus => ({
  instanceName: 'inst',
  status,
  hasQr: status === 'qr_required',
  qr: status === 'qr_required' ? 'some-qr' : null,
  lastError: ''
});

describe('WhatsappPageComponent', () => {
  let fixture: ComponentFixture<WhatsappPageComponent>;
  let component: WhatsappPageComponent;
  let routerSpy: jasmine.SpyObj<Router>;
  let agentSpy: jasmine.SpyObj<AgentService>;
  let gatewaySpy: jasmine.SpyObj<WhatsappWebjsGatewayService>;
  let wsSpy: jasmine.SpyObj<WhatsappWsService>;
  let scheduleListLauncherSpy: jasmine.SpyObj<ScheduleListLauncherService>;
  let gemSettingsSubject: BehaviorSubject<any>;
  let schedulesSubject: BehaviorSubject<ScheduledMessage[]>;

  beforeEach(async () => {
    routerSpy = jasmine.createSpyObj('Router', ['navigate']);
    routerSpy.navigate.and.returnValue(Promise.resolve(true));

    gatewaySpy = jasmine.createSpyObj('WhatsappWebjsGatewayService', [
      'loadSessionStatus', 'connectSession', 'disconnectSession', 'loadLabels'
    ]);
    gatewaySpy.loadSessionStatus.and.returnValue(of(makeStatus('initializing')));
    gatewaySpy.loadLabels.and.returnValue(of([]));

    wsSpy = jasmine.createSpyObj('WhatsappWsService', ['on', 'connect', 'disconnect'], {
      connected$: of(false)
    });
    wsSpy.on.and.returnValue(EMPTY);

    gemSettingsSubject = new BehaviorSubject({
      enabled: false,
      gemUrl: '',
      responseMode: 'fast',
      googleAccounts: [{ id: 'primary', label: 'Conta principal', createdAt: new Date().toISOString(), lastUsedAt: null }],
      activeGoogleAccountId: 'primary'
    });
    agentSpy = jasmine.createSpyObj('AgentService', ['toggleEnabled', 'openAgentWindow'], {
      settings$: gemSettingsSubject.asObservable()
    });
    agentSpy.openAgentWindow.and.returnValue(Promise.resolve({ ok: true, message: 'Janela aberta.' }));
    scheduleListLauncherSpy = jasmine.createSpyObj('ScheduleListLauncherService', ['requestOpen']);
    schedulesSubject = new BehaviorSubject<ScheduledMessage[]>([]);

    await TestBed.configureTestingModule({
      declarations: [WhatsappPageComponent],
      providers: [
        { provide: Router, useValue: routerSpy },
        { provide: AgentService, useValue: agentSpy },
        { provide: WhatsappWebjsGatewayService, useValue: gatewaySpy },
        { provide: WhatsappWsService, useValue: wsSpy },
        { provide: ScheduleListLauncherService, useValue: scheduleListLauncherSpy },
        { provide: ScheduledMessageService, useValue: { schedules$: schedulesSubject.asObservable() } }
      ],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(WhatsappPageComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    component.ngOnDestroy();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  it('calls loadSessionStatus on init', () => {
    expect(gatewaySpy.loadSessionStatus).toHaveBeenCalled();
  });

  it('connects the websocket on init', () => {
    expect(wsSpy.connect).toHaveBeenCalled();
  });

  it('goToHome navigates to root', () => {
    component.goToHome();
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/']);
  });

  it('redirects to the agent page when the agent is not configured', () => {
    component.toggleAgent();
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/agente']);
    expect(agentSpy.toggleEnabled).not.toHaveBeenCalled();
  });

  it('enables the official agent when the configuration exists', () => {
    gemSettingsSubject.next({
      enabled: false,
      gemUrl: 'https://gemini.google.com/gem/teste',
      responseMode: 'fast',
      googleAccounts: [{ id: 'primary', label: 'Conta principal', createdAt: new Date().toISOString(), lastUsedAt: null }],
      activeGoogleAccountId: 'primary'
    });
    fixture.detectChanges();

    component.toggleAgent();

    expect(agentSpy.toggleEnabled).toHaveBeenCalledWith(true);
  });

  it('openAboutModal opens modal', () => {
    component.openAboutModal();
    expect(component.isAboutModalOpen).toBeTrue();
  });

  it('openScheduleList requests opening the schedule list', () => {
    component.openScheduleList();
    expect(scheduleListLauncherSpy.requestOpen).toHaveBeenCalled();
  });

  it('keeps the schedules badge count synced with pending and notified schedules', () => {
    schedulesSubject.next([
      {
        id: 'pending-1',
        scheduledAt: '2026-04-24T10:00:00.000Z',
        recurrence: 'none',
        template: 'Mensagem',
        contacts: [],
        status: 'pending',
        createdAt: '2026-04-24T09:00:00.000Z'
      },
      {
        id: 'notified-1',
        scheduledAt: '2026-04-24T10:30:00.000Z',
        recurrence: 'daily',
        template: 'Mensagem',
        contacts: [],
        status: 'notified',
        createdAt: '2026-04-24T09:00:00.000Z'
      },
      {
        id: 'done-1',
        scheduledAt: '2026-04-24T11:00:00.000Z',
        recurrence: 'weekly',
        template: 'Mensagem',
        contacts: [],
        status: 'done',
        createdAt: '2026-04-24T09:00:00.000Z'
      }
    ]);

    expect(component.schedulesBadgeCount).toBe(2);
  });

  it('opens the quick reply manager from the header action', () => {
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('.config-menu-item')) as HTMLButtonElement[];
    const quickReplyButton = buttons.find(button => button.textContent?.includes('Mensagens rápidas'));

    quickReplyButton?.click();

    expect(quickReplyButton).toBeTruthy();
    expect(component.isQuickReplyManagerOpen).toBeTrue();
  });

  it('opens the label manager from the header action', () => {
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('.config-menu-item')) as HTMLButtonElement[];
    const labelButton = buttons.find(button => button.textContent?.includes('Etiquetas'));

    labelButton?.click();

    expect(labelButton).toBeTruthy();
    expect(component.isLabelManagerOpen).toBeTrue();
  });

  it('closeAboutModal closes the modal', () => {
    component.isAboutModalOpen = true;
    component.closeAboutModal();
    expect(component.isAboutModalOpen).toBeFalse();
  });

  describe('connectActionLabel', () => {
    it('shows disconnect label when status is ready', () => {
      component.currentSessionStatus = 'ready';
      expect(component.connectActionLabel).toBe('Desconectar do WhatsApp');
    });

    it('shows connect label when status is initializing', () => {
      component.currentSessionStatus = 'initializing';
      expect(component.connectActionLabel).toBe('Conectar ao WhatsApp');
    });
  });

  describe('shouldShowDisconnectAction', () => {
    it('is true for ready status', () => {
      component.currentSessionStatus = 'ready';
      expect(component.shouldShowDisconnectAction).toBeTrue();
    });

    it('is true for authenticated status', () => {
      component.currentSessionStatus = 'authenticated';
      expect(component.shouldShowDisconnectAction).toBeTrue();
    });

    it('is true for qr_required status', () => {
      component.currentSessionStatus = 'qr_required';
      expect(component.shouldShowDisconnectAction).toBeTrue();
    });

    it('is false for initializing status', () => {
      component.currentSessionStatus = 'initializing';
      expect(component.shouldShowDisconnectAction).toBeFalse();
    });
  });

  describe('closeDisconnectModal', () => {
    it('closes the modal when not loading', () => {
      component.isDisconnectModalOpen = true;
      component.isSessionActionLoading = false;
      component.closeDisconnectModal();
      expect(component.isDisconnectModalOpen).toBeFalse();
    });

    it('does nothing when action is loading', () => {
      component.isDisconnectModalOpen = true;
      component.isSessionActionLoading = true;
      component.closeDisconnectModal();
      expect(component.isDisconnectModalOpen).toBeTrue();
    });
  });

  describe('confirmDisconnect', () => {
    it('calls disconnectSession and closes modal on success', () => {
      gatewaySpy.disconnectSession.and.returnValue(of(makeStatus('disconnected')));
      component.isDisconnectModalOpen = true;
      component.confirmDisconnect();
      expect(gatewaySpy.disconnectSession).toHaveBeenCalled();
      expect(component.isDisconnectModalOpen).toBeFalse();
      expect(component.isSessionActionLoading).toBeFalse();
    });

    it('sets error message on disconnect failure', () => {
      gatewaySpy.disconnectSession.and.returnValue(throwError(() => new Error('fail')));
      component.confirmDisconnect();
      expect(component.sessionErrorMessage).toContain('desconectar');
      expect(component.isSessionActionLoading).toBeFalse();
    });
  });

  it('clears loaded WhatsApp labels and ignores stale responses after disconnect', () => {
    const labelsSubject = new Subject<WhatsappLabel[]>();
    gatewaySpy.loadLabels.and.returnValue(labelsSubject.asObservable());

    component.whatsappInitLabels = [{ id: 'lab-old', name: 'Cliente antigo', hexColor: '#16a34a' }];
    component.currentSessionStatus = 'ready';

    (component as any).loadWhatsappLabels();
    expect(component.isLoadingWhatsappLabels).toBeTrue();

    (component as any).syncLabelsLoadWithSessionState('disconnected');

    expect(component.whatsappInitLabels).toEqual([]);
    expect(component.isLoadingWhatsappLabels).toBeFalse();

    labelsSubject.next([{ id: 'lab-new', name: 'Novo', hexColor: '#25D366' }]);
    labelsSubject.complete();

    expect(component.whatsappInitLabels).toEqual([]);
  });

  describe('onToggleSessionConnection', () => {
    it('opens the disconnect modal when the session is connected', () => {
      component.currentSessionStatus = 'ready';
      component.onToggleSessionConnection();
      expect(component.isDisconnectModalOpen).toBeTrue();
    });

    it('starts a connection when the session is disconnected', () => {
      gatewaySpy.connectSession.and.returnValue(of(makeStatus('authenticated')));
      component.currentSessionStatus = 'disconnected';

      component.onToggleSessionConnection();

      expect(gatewaySpy.connectSession).toHaveBeenCalled();
      expect(component.isSessionActionLoading).toBeFalse();
      expect(component.currentSessionStatus).toBe('authenticated');
    });
  });
});
