import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, fakeAsync, TestBed, tick } from '@angular/core/testing';
import { BehaviorSubject, Subject } from 'rxjs';

import { MessageTemplateEditorConfig, MessageTemplateSaveResult } from '../../../../models/message-template.model';
import { ScheduledMessage } from '../../../../models/scheduled-message.model';
import { WhatsappContact, WhatsappInstance } from '../../../../models/whatsapp.model';
import { Cliente } from '../../../../models/cliente.model';
import { MessageTemplateService } from '../../../../services/message-template.service';
import { PendingBulkSendService } from '../../../../services/pending-bulk-send.service';
import { ScheduleListLauncherService } from '../../../../services/schedule-list-launcher.service';
import { ScheduledMessageService } from '../../../../services/scheduled-message.service';
import { BulkSendService } from '../../services/bulk-send.service';
import { WhatsappStateService, WhatsappSyncStatus } from '../../services/whatsapp-state.service';
import { WhatsappConsoleComponent } from './whatsapp-console.component';

const makeContact = (jid: string): WhatsappContact => ({
  jid, phone: jid.replace('@c.us', ''), name: 'User', found: true
});

const makeCliente = (id: number, nome: string, telefone: string): Cliente => ({
  id,
  nome,
  cpf: '',
  telefone,
  dataCadastro: '',
  dataNascimento: '',
  birthdayStatus: 'none'
});

describe('WhatsappConsoleComponent', () => {
  let fixture: ComponentFixture<WhatsappConsoleComponent>;
  let component: WhatsappConsoleComponent;
  let stateSpy: jasmine.SpyObj<WhatsappStateService>;
  let bulkSpy: jasmine.SpyObj<BulkSendService>;
  let pendingBulkSpy: jasmine.SpyObj<PendingBulkSendService>;
  let templateServiceSpy: jasmine.SpyObj<MessageTemplateService>;
  let scheduleListLauncherSpy: jasmine.SpyObj<ScheduleListLauncherService>;
  let scheduledMessageServiceSpy: jasmine.SpyObj<ScheduledMessageService>;

  const instances$ = new BehaviorSubject<WhatsappInstance[]>([]);
  const selectedInstance$ = new BehaviorSubject<string>('');
  const errorMessage$ = new BehaviorSubject<string>('');
  const loadingState$ = new BehaviorSubject({ instances: false, contacts: false, messages: false, sending: false });
  const syncStatus$ = new BehaviorSubject<WhatsappSyncStatus>({
    active: false,
    mode: 'idle',
    message: '',
    detail: '',
    currentStep: 0,
    totalSteps: 0,
    progressPercent: 0
  });
  const selectionMode$ = new BehaviorSubject<boolean>(false);
  const contacts$ = new BehaviorSubject<WhatsappContact[]>([]);
  const selectedJids$ = new BehaviorSubject<Set<string>>(new Set());
  const schedules$ = new BehaviorSubject([]);
  const upcoming$ = new BehaviorSubject(null);
  const openRequests$ = new BehaviorSubject<void>(undefined);
  const scheduleLifecycle$ = new Subject<any>();

  beforeEach(async () => {
    instances$.next([]);
    selectedInstance$.next('');
    errorMessage$.next('');
    loadingState$.next({ instances: false, contacts: false, messages: false, sending: false });
    syncStatus$.next({
      active: false,
      mode: 'idle',
      message: '',
      detail: '',
      currentStep: 0,
      totalSteps: 0,
      progressPercent: 0
    });
    selectionMode$.next(false);
    contacts$.next([]);
    selectedJids$.next(new Set());
    schedules$.next([]);
    upcoming$.next(null);
    openRequests$.next(undefined);

    stateSpy = jasmine.createSpyObj('WhatsappStateService', [
      'loadInstances', 'selectInstance', 'refresh', 'selectAll', 'exitSelectionMode', 'clearErrorMessage', 'resolveConversationJid'
    ], {
      instances$: instances$.asObservable(),
      selectedInstance$: selectedInstance$.asObservable(),
      errorMessage$: errorMessage$.asObservable(),
      loadingState$: loadingState$.asObservable(),
      syncStatus$: syncStatus$.asObservable(),
      selectionMode$: selectionMode$.asObservable(),
      contacts$: contacts$.asObservable(),
      selectedJids$: selectedJids$.asObservable()
    });
    Object.defineProperty(stateSpy, 'selectedInstance', {
      get: () => selectedInstance$.value
    });
    stateSpy.resolveConversationJid.and.callFake((jid: string) => jid);

    bulkSpy = jasmine.createSpyObj('BulkSendService', ['start'], {
      scheduleLifecycle$: scheduleLifecycle$.asObservable()
    });
    pendingBulkSpy = jasmine.createSpyObj('PendingBulkSendService', ['consume']);
    pendingBulkSpy.consume.and.returnValue(null);
    templateServiceSpy = jasmine.createSpyObj('MessageTemplateService', ['getTemplate', 'getTemplates', 'getTemplateImage']);
    templateServiceSpy.getTemplate.and.returnValue('');
    templateServiceSpy.getTemplates.and.returnValue({
      birthday: 'Feliz aniversario, {nome}!',
      review: 'Oi {nome}, pode avaliar nosso atendimento?'
    });
    templateServiceSpy.getTemplateImage.and.returnValue(undefined);
    scheduleListLauncherSpy = jasmine.createSpyObj('ScheduleListLauncherService', ['consumePendingOpen']);
    scheduleListLauncherSpy.consumePendingOpen.and.returnValue(false);
    Object.defineProperty(scheduleListLauncherSpy, 'openRequests$', {
      value: openRequests$.asObservable()
    });
    scheduledMessageServiceSpy = jasmine.createSpyObj('ScheduledMessageService', ['beginExecution', 'completeExecution', 'cancelExecution'], {
      schedules$: schedules$.asObservable(),
      upcoming$: upcoming$.asObservable()
    });

    await TestBed.configureTestingModule({
      declarations: [WhatsappConsoleComponent],
      providers: [
        { provide: WhatsappStateService, useValue: stateSpy },
        { provide: BulkSendService, useValue: bulkSpy },
        { provide: PendingBulkSendService, useValue: pendingBulkSpy },
        { provide: MessageTemplateService, useValue: templateServiceSpy },
        { provide: ScheduleListLauncherService, useValue: scheduleListLauncherSpy },
        { provide: ScheduledMessageService, useValue: scheduledMessageServiceSpy }
      ],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(WhatsappConsoleComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  it('calls loadInstances on init', () => {
    expect(stateSpy.loadInstances).toHaveBeenCalled();
  });

  it('dismisses the error banner when the user clicks close', () => {
    errorMessage$.next('Não foi possível enviar a mensagem.');
    fixture.detectChanges();

    const dismissButton = fixture.nativeElement.querySelector('.whatsapp-console__error-dismiss') as HTMLButtonElement;
    dismissButton.click();

    expect(component.errorMessage).toBe('');
    expect(stateSpy.clearErrorMessage).toHaveBeenCalled();
  });

  it('auto-dismisses the error banner after four seconds', fakeAsync(() => {
    errorMessage$.next('Não foi possível enviar a mensagem.');
    fixture.detectChanges();

    expect(component.errorMessage).toBe('Não foi possível enviar a mensagem.');

    tick(4000);

    expect(component.errorMessage).toBe('');
    expect(stateSpy.clearErrorMessage).toHaveBeenCalled();
  }));

  it('templateEditorConfig title is correct', () => {
    expect(component.templateEditorConfig.title).toBe('Envio para vários contatos');
  });

  describe('isInitialLoading', () => {
    it('is true when instances are loading', () => {
      component.isLoadingInstances = true;
      component.isLoadingContacts = false;
      expect(component.isInitialLoading).toBeTrue();
    });

    it('is true when contacts are loading', () => {
      component.isLoadingInstances = false;
      component.isLoadingContacts = true;
      expect(component.isInitialLoading).toBeTrue();
    });

    it('is false when neither is loading', () => {
      component.isLoadingInstances = false;
      component.isLoadingContacts = false;
      component.isInitialSyncing = false;
      expect(component.isInitialLoading).toBeFalse();
    });

    it('is true when the initial sync is active', () => {
      component.isLoadingInstances = false;
      component.isLoadingContacts = false;
      component.isInitialSyncing = true;
      expect(component.isInitialLoading).toBeTrue();
    });
  });

  describe('isUiBlocked', () => {
    it('is true when loading instances', () => {
      component.isLoadingInstances = true;
      expect(component.isUiBlocked).toBeTrue();
    });

    it('is false when instances are not loading', () => {
      component.isLoadingInstances = false;
      expect(component.isUiBlocked).toBeFalse();
    });
  });

  describe('syncProgress', () => {
    it('uses the progress percent provided by sync status', () => {
      syncStatus$.next({
        active: true,
        mode: 'initial',
        message: 'Carregando contatos',
        detail: '',
        currentStep: 1,
        totalSteps: 2,
        progressPercent: 37
      });

      expect(component.syncProgress).toBe(37);
      expect(component.syncMessage).toBe('Carregando contatos');
      expect(component.syncCurrentStep).toBe(1);
      expect(component.syncTotalSteps).toBe(2);
    });
  });

  describe('onInstanceChange', () => {
    it('calls state.selectInstance', () => {
      component.isLoadingInstances = false;
      component.onInstanceChange('instance-1');
      expect(stateSpy.selectInstance).toHaveBeenCalledWith('instance-1');
    });

    it('does nothing when UI is blocked', () => {
      component.isLoadingInstances = true;
      component.onInstanceChange('instance-1');
      expect(stateSpy.selectInstance).not.toHaveBeenCalled();
    });
  });

  describe('onRefresh', () => {
    it('calls state.refresh', () => {
      component.isLoadingInstances = false;
      component.onRefresh();
      expect(stateSpy.refresh).toHaveBeenCalled();
    });
  });

  describe('onOpenBulkSend', () => {
    it('opens template modal when contacts are selected', () => {
      component.selectedCount = 2;
      component.isLoadingInstances = false;
      component.onOpenBulkSend();
      expect(component.isTemplateModalOpen).toBeTrue();
    });

    it('does nothing when no contacts selected', () => {
      component.selectedCount = 0;
      component.onOpenBulkSend();
      expect(component.isTemplateModalOpen).toBeFalse();
    });
  });

  describe('onCloseTemplateModal', () => {
    it('closes the modal', () => {
      component.isTemplateModalOpen = true;
      component.onCloseTemplateModal();
      expect(component.isTemplateModalOpen).toBeFalse();
    });
  });

  describe('onSaveTemplate', () => {
    it('does not start bulk if text is empty', () => {
      const result: MessageTemplateSaveResult = { text: '   ' };
      component.onSaveTemplate(result);
      expect(bulkSpy.start).not.toHaveBeenCalled();
    });

    it('does not start bulk if no contacts selected', () => {
      component.selectedCount = 0;
      const result: MessageTemplateSaveResult = { text: 'Hello {nome}' };
      component.onSaveTemplate(result);
      expect(bulkSpy.start).not.toHaveBeenCalled();
    });
  });

  it('starts a schedule execution through bulk send and suppresses its notification', () => {
    const schedule: ScheduledMessage = {
      id: 'sch-1',
      scheduledAt: '2026-04-24T12:00:00.000Z',
      recurrence: 'none',
      template: 'Oi {nome}',
      contacts: [{ jid: '5511@c.us', name: 'User', phone: '5511' }],
      status: 'pending',
      createdAt: '2026-04-24T10:00:00.000Z'
    };

    component.schedules = [schedule];
    component.allContacts = [makeContact('5511@c.us')];

    component.onTriggerSchedule(schedule.id);

    expect(scheduledMessageServiceSpy.beginExecution).toHaveBeenCalledWith(schedule.id);
    expect(bulkSpy.start).toHaveBeenCalledWith(component.allContacts, schedule.template, schedule.imageDataUrl, { scheduleId: schedule.id });
  });

  it('resolves equivalent scheduled contacts before starting a schedule execution', () => {
    const schedule: ScheduledMessage = {
      id: 'sch-2',
      scheduledAt: '2026-04-24T12:00:00.000Z',
      recurrence: 'none',
      template: 'Oi {nome}',
      contacts: [{ jid: '120363999999999999@lid', name: 'Ana', phone: '5511987654321' }],
      status: 'pending',
      createdAt: '2026-04-24T10:00:00.000Z'
    };
    const canonical: WhatsappContact = {
      jid: '5511987654321@c.us',
      phone: '5511987654321',
      name: 'Ana Silva',
      found: true
    };

    stateSpy.resolveConversationJid.and.callFake((jid: string) =>
      jid === '120363999999999999@lid' ? '5511987654321@c.us' : jid
    );
    component.schedules = [schedule];
    component.allContacts = [canonical];

    component.onTriggerSchedule(schedule.id);

    expect(scheduledMessageServiceSpy.beginExecution).toHaveBeenCalledWith(schedule.id);
    expect(bulkSpy.start).toHaveBeenCalledWith([canonical], schedule.template, schedule.imageDataUrl, { scheduleId: schedule.id });
  });

  it('completes the schedule when the scheduled bulk finishes', () => {
    scheduleLifecycle$.next({ scheduleId: 'sch-1', outcome: 'completed' });

    expect(scheduledMessageServiceSpy.completeExecution).toHaveBeenCalledWith('sch-1');
  });

  it('releases the schedule execution when the scheduled bulk is cancelled', () => {
    scheduleLifecycle$.next({ scheduleId: 'sch-1', outcome: 'cancelled' });

    expect(scheduledMessageServiceSpy.cancelExecution).toHaveBeenCalledWith('sch-1');
  });

  it('maps pending clientes to the correct contacts and includes selected clients not in contacts', () => {
    contacts$.next([]);
    fixture.destroy();

    pendingBulkSpy.consume.and.returnValue({
      templateType: 'birthday',
      clientes: [
        makeCliente(1, 'Ana', '(11) 98765-4321'),
        makeCliente(2, 'Bia', '(11) 98888-7777'),
        makeCliente(3, 'Clara', '(11) 97777-6666')
      ]
    });

    const wrongGroup: WhatsappContact = {
      jid: '123@g.us',
      phone: '',
      name: 'Grupo errado',
      found: true,
      isGroup: true
    };
    const anaContact: WhatsappContact = {
      jid: '5511987654321@c.us',
      phone: '5511987654321',
      name: 'Ana Silva',
      found: true
    };
    const biaContact: WhatsappContact = {
      jid: '5511988887777@c.us',
      phone: '5511988887777',
      name: 'Bia Souza',
      found: true
    };

    contacts$.next([wrongGroup, anaContact, biaContact]);
    selectedInstance$.next('inst-1');

    fixture = TestBed.createComponent(WhatsappConsoleComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();

    expect(bulkSpy.start).toHaveBeenCalled();
    const [mappedContacts, template, imageDataUrl] = bulkSpy.start.calls.mostRecent().args;
    expect(mappedContacts).toEqual([
      anaContact,
      biaContact,
      {
        jid: '5511977776666@c.us',
        phone: '5511977776666',
        name: 'Clara',
        found: false
      }
    ]);
    expect(template).toBe('Feliz aniversario, {nome}!');
    expect(imageDataUrl).toBeUndefined();
  });

  it('starts pending bulk even when contacts stream is initially empty', () => {
    contacts$.next([]);
    loadingState$.next({ instances: false, contacts: false, messages: false, sending: false });
    fixture.destroy();

    pendingBulkSpy.consume.and.returnValue({
      templateType: 'birthday',
      clientes: [
        makeCliente(1, 'Ana', '(11) 98765-4321'),
        makeCliente(2, 'Bia', '(11) 98888-7777')
      ]
    });

    fixture = TestBed.createComponent(WhatsappConsoleComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();

    expect(bulkSpy.start).not.toHaveBeenCalled();

    selectedInstance$.next('inst-1');
    loadingState$.next({ instances: false, contacts: true, messages: false, sending: false });
    loadingState$.next({ instances: false, contacts: false, messages: false, sending: false });

    expect(bulkSpy.start).toHaveBeenCalled();
    const [mappedContacts] = bulkSpy.start.calls.mostRecent().args;
    expect(mappedContacts).toEqual([
      {
        jid: '5511987654321@c.us',
        phone: '5511987654321',
        name: 'Ana',
        found: false
      },
      {
        jid: '5511988887777@c.us',
        phone: '5511988887777',
        name: 'Bia',
        found: false
      }
    ]);
  });

  it('waits for bootstrap completion instead of starting from stale pre-load contacts', () => {
    contacts$.next([
      {
        jid: '5599999999999@c.us',
        phone: '5599999999999',
        name: 'Conversa antiga',
        found: true
      }
    ]);
    selectedInstance$.next('');
    loadingState$.next({ instances: false, contacts: false, messages: false, sending: false });
    fixture.destroy();

    pendingBulkSpy.consume.and.returnValue({
      templateType: 'birthday',
      clientes: [makeCliente(1, 'Ana', '(11) 98765-4321')]
    });

    fixture = TestBed.createComponent(WhatsappConsoleComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();

    expect(bulkSpy.start).not.toHaveBeenCalled();

    selectedInstance$.next('inst-1');
    expect(bulkSpy.start).not.toHaveBeenCalled();

    loadingState$.next({ instances: false, contacts: true, messages: false, sending: false });
    contacts$.next([
      {
        jid: '5511987654321@c.us',
        phone: '5511987654321',
        name: 'Ana Silva',
        found: true
      }
    ]);
    expect(bulkSpy.start).not.toHaveBeenCalled();

    loadingState$.next({ instances: false, contacts: false, messages: false, sending: false });

    expect(bulkSpy.start).toHaveBeenCalled();
    const [mappedContacts] = bulkSpy.start.calls.mostRecent().args;
    expect(mappedContacts).toEqual([
      {
        jid: '5511987654321@c.us',
        phone: '5511987654321',
        name: 'Ana Silva',
        found: true
      }
    ]);
  });

  it('does not enqueue duplicated jid when multiple clientes map to the same contact', () => {
    contacts$.next([]);
    fixture.destroy();

    pendingBulkSpy.consume.and.returnValue({
      templateType: 'birthday',
      clientes: [
        makeCliente(1, 'Ana', '(11) 98765-4321'),
        makeCliente(2, 'Ana duplicada', '11 98765-4321')
      ]
    });

    const anaContact: WhatsappContact = {
      jid: '5511987654321@c.us',
      phone: '5511987654321',
      name: 'Ana Silva',
      found: true
    };

    contacts$.next([anaContact]);
    selectedInstance$.next('inst-1');

    fixture = TestBed.createComponent(WhatsappConsoleComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();

    expect(bulkSpy.start).toHaveBeenCalled();
    const [mappedContacts] = bulkSpy.start.calls.mostRecent().args;
    expect(mappedContacts).toEqual([anaContact]);
  });
});
