import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { EMPTY, of, throwError } from 'rxjs';

import { ScheduleListLauncherService } from '../../../../services/schedule-list-launcher.service';
import { WhatsappSessionStatus, WhatsappWebjsGatewayService } from '../../../../services/whatsapp-webjs-gateway.service';
import { WhatsappWsService } from '../../../../services/whatsapp-ws.service';
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
  let gatewaySpy: jasmine.SpyObj<WhatsappWebjsGatewayService>;
  let wsSpy: jasmine.SpyObj<WhatsappWsService>;
  let scheduleListLauncherSpy: jasmine.SpyObj<ScheduleListLauncherService>;

  beforeEach(async () => {
    routerSpy = jasmine.createSpyObj('Router', ['navigate']);
    routerSpy.navigate.and.returnValue(Promise.resolve(true));

    gatewaySpy = jasmine.createSpyObj('WhatsappWebjsGatewayService', [
      'loadSessionStatus', 'connectSession', 'disconnectSession'
    ]);
    gatewaySpy.loadSessionStatus.and.returnValue(of(makeStatus('initializing')));

    wsSpy = jasmine.createSpyObj('WhatsappWsService', ['on', 'connect', 'disconnect'], {
      connected$: of(false)
    });
    wsSpy.on.and.returnValue(EMPTY);
    scheduleListLauncherSpy = jasmine.createSpyObj('ScheduleListLauncherService', ['requestOpen']);

    await TestBed.configureTestingModule({
      declarations: [WhatsappPageComponent],
      providers: [
        { provide: Router, useValue: routerSpy },
        { provide: WhatsappWebjsGatewayService, useValue: gatewaySpy },
        { provide: WhatsappWsService, useValue: wsSpy },
        { provide: ScheduleListLauncherService, useValue: scheduleListLauncherSpy }
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

  it('openAboutModal opens modal', () => {
    component.openAboutModal();
    expect(component.isAboutModalOpen).toBeTrue();
  });

  it('openScheduleList requests opening the schedule list', () => {
    component.openScheduleList();
    expect(scheduleListLauncherSpy.requestOpen).toHaveBeenCalled();
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
