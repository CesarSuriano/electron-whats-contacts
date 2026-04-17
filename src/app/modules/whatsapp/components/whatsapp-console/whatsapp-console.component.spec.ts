import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { MessageTemplateEditorConfig, MessageTemplateSaveResult } from '../../../../models/message-template.model';
import { WhatsappContact, WhatsappInstance } from '../../../../models/whatsapp.model';
import { MessageTemplateService } from '../../../../services/message-template.service';
import { PendingBulkSendService } from '../../../../services/pending-bulk-send.service';
import { BulkSendService } from '../../services/bulk-send.service';
import { WhatsappStateService } from '../../services/whatsapp-state.service';
import { WhatsappConsoleComponent } from './whatsapp-console.component';

const makeContact = (jid: string): WhatsappContact => ({
  jid, phone: jid.replace('@c.us', ''), name: 'User', found: true
});

describe('WhatsappConsoleComponent', () => {
  let fixture: ComponentFixture<WhatsappConsoleComponent>;
  let component: WhatsappConsoleComponent;
  let stateSpy: jasmine.SpyObj<WhatsappStateService>;
  let bulkSpy: jasmine.SpyObj<BulkSendService>;
  let pendingBulkSpy: jasmine.SpyObj<PendingBulkSendService>;
  let templateServiceSpy: jasmine.SpyObj<MessageTemplateService>;

  const instances$ = new BehaviorSubject<WhatsappInstance[]>([]);
  const selectedInstance$ = new BehaviorSubject<string>('');
  const errorMessage$ = new BehaviorSubject<string>('');
  const loadingState$ = new BehaviorSubject({ instances: false, contacts: false, messages: false, sending: false });
  const syncStatus$ = new BehaviorSubject({
    active: false,
    mode: 'idle' as const,
    message: '',
    detail: '',
    currentStep: 0,
    totalSteps: 0
  });
  const selectionMode$ = new BehaviorSubject<boolean>(false);
  const contacts$ = new BehaviorSubject<WhatsappContact[]>([]);
  const selectedJids$ = new BehaviorSubject<Set<string>>(new Set());

  beforeEach(async () => {
    stateSpy = jasmine.createSpyObj('WhatsappStateService', [
      'loadInstances', 'selectInstance', 'refresh', 'selectAll', 'exitSelectionMode'
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

    bulkSpy = jasmine.createSpyObj('BulkSendService', ['start']);
    pendingBulkSpy = jasmine.createSpyObj('PendingBulkSendService', ['consume']);
    pendingBulkSpy.consume.and.returnValue(null);
    templateServiceSpy = jasmine.createSpyObj('MessageTemplateService', ['getTemplate']);
    templateServiceSpy.getTemplate.and.returnValue('');

    await TestBed.configureTestingModule({
      declarations: [WhatsappConsoleComponent],
      providers: [
        { provide: WhatsappStateService, useValue: stateSpy },
        { provide: BulkSendService, useValue: bulkSpy },
        { provide: PendingBulkSendService, useValue: pendingBulkSpy },
        { provide: MessageTemplateService, useValue: templateServiceSpy }
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
});
