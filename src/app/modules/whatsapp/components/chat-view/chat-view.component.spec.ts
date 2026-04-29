import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { BehaviorSubject, of } from 'rxjs';

import { WhatsappContact, WhatsappMessage } from '../../../../models/whatsapp.model';
import { AgentService } from '../../../../services/agent.service';
import { BulkSendService } from '../../services/bulk-send.service';
import { AssistantFeedbackService } from '../../services/assistant-feedback.service';
import { WhatsappStateService } from '../../services/whatsapp-state.service';
import { ChatViewComponent } from './chat-view.component';

const makeContact = (jid = 'a@c.us'): WhatsappContact => ({
  jid,
  phone: '5511987654321',
  name: 'Ana',
  found: true
});

const makeMessage = (id: string, text: string, isFromMe: boolean): WhatsappMessage => ({
  id,
  contactJid: 'a@c.us',
  text,
  sentAt: new Date().toISOString(),
  isFromMe,
  source: 'spec'
});

describe('ChatViewComponent', () => {
  let fixture: ComponentFixture<ChatViewComponent>;
  let component: ChatViewComponent;
  let stateSpy: jasmine.SpyObj<WhatsappStateService>;
  let bulkSpy: jasmine.SpyObj<BulkSendService>;
  let feedbackSpy: jasmine.SpyObj<AssistantFeedbackService>;
  let agentSpy: jasmine.SpyObj<AgentService>;
  let queueSubject: BehaviorSubject<any>;
  let jidSubject: BehaviorSubject<string>;
  let draftSubject: BehaviorSubject<string>;
  let draftImageSubject: BehaviorSubject<string | null>;
  let loadingSubject: BehaviorSubject<{ instances: boolean; contacts: boolean; messages: boolean; sending: boolean }>;
  let selectedMessagesSubject: BehaviorSubject<WhatsappMessage[]>;
  let selectedContactSubject: BehaviorSubject<WhatsappContact | null>;
  let gemSettingsSubject: BehaviorSubject<any>;
  let gemSuggestionSubject: BehaviorSubject<any>;

  const makeStateSpyWith = (contact: WhatsappContact | null) => {
    jidSubject = new BehaviorSubject<string>(contact?.jid || '');
    const contacts$ = new BehaviorSubject<WhatsappContact[]>(contact ? [contact] : []);
    const messages$ = new BehaviorSubject<WhatsappMessage[]>([]);
    loadingSubject = new BehaviorSubject<{ instances: boolean; contacts: boolean; messages: boolean; sending: boolean }>({
      instances: false,
      contacts: false,
      messages: false,
      sending: false
    });
    draftSubject = new BehaviorSubject<string>('');
    draftImageSubject = new BehaviorSubject<string | null>(null);
    const syncing$ = new BehaviorSubject<boolean>(false);
    selectedMessagesSubject = new BehaviorSubject<WhatsappMessage[]>([]);
    selectedContactSubject = new BehaviorSubject<WhatsappContact | null>(contact);

    stateSpy = jasmine.createSpyObj('WhatsappStateService', [
      'getMessagesFor', 'getDraftTextForJid', 'setDraftText', 'setDraftTextForJid', 'sendText', 'sendMedia', 'resolveConversationJid'
    ], {
      selectedContactJid$: jidSubject.asObservable(),
      contacts$: contacts$.asObservable(),
      messages$: messages$.asObservable(),
      loadingState$: loadingSubject.asObservable(),
      draftText$: draftSubject.asObservable(),
      draftImageDataUrl$: draftImageSubject.asObservable(),
      syncing$: syncing$.asObservable(),
      selectedMessages$: selectedMessagesSubject.asObservable(),
      selectedContact$: selectedContactSubject.asObservable()
    });
    stateSpy.getMessagesFor.and.returnValue([]);
    stateSpy.getDraftTextForJid.and.returnValue('');
    stateSpy.resolveConversationJid.and.callFake((jid: string) => jid);
    return stateSpy;
  };

  beforeEach(async () => {
    const spy = makeStateSpyWith(null);

    queueSubject = new BehaviorSubject<any>(null);

    bulkSpy = jasmine.createSpyObj('BulkSendService', [], {
      queue$: queueSubject.asObservable(),
      hasActiveQueue: false
    });

    feedbackSpy = jasmine.createSpyObj('AssistantFeedbackService', ['record']);

    gemSettingsSubject = new BehaviorSubject({
      enabled: false,
      gemUrl: '',
      responseMode: 'fast',
      googleAccounts: [{ id: 'primary', label: 'Conta principal', createdAt: new Date().toISOString(), lastUsedAt: null }],
      activeGoogleAccountId: 'primary'
    });
    gemSuggestionSubject = new BehaviorSubject({
      status: 'idle',
      contactJid: '',
      contextKey: '',
      suggestion: '',
      errorMessage: '',
      source: 'none',
      updatedAt: null
    });

    agentSpy = jasmine.createSpyObj('AgentService', ['clearSuggestion', 'generateSuggestion'], {
      settings$: gemSettingsSubject.asObservable(),
      suggestion$: gemSuggestionSubject.asObservable()
    });
    agentSpy.generateSuggestion.and.returnValue(Promise.resolve({
      status: 'idle',
      contactJid: '',
      contextKey: '',
      suggestion: '',
      errorMessage: '',
      source: 'none',
      updatedAt: null
    }));

    await TestBed.configureTestingModule({
      declarations: [ChatViewComponent],
      providers: [
        { provide: WhatsappStateService, useValue: spy },
        { provide: BulkSendService, useValue: bulkSpy },
        { provide: AssistantFeedbackService, useValue: feedbackSpy },
        { provide: AgentService, useValue: agentSpy }
      ],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(ChatViewComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  it('onDraftChange updates draftText and syncs state after a short debounce', fakeAsync(() => {
    component.contact = makeContact('a@c.us');

    component.onDraftChange('new text');

    expect(component.draftText).toBe('new text');
    expect(stateSpy.setDraftTextForJid).not.toHaveBeenCalled();

    tick(40);

    expect(stateSpy.setDraftTextForJid).toHaveBeenCalledWith('a@c.us', 'new text');
  }));

  it('syncs draft text using the resolved conversation jid', fakeAsync(() => {
    component.contact = makeContact('120363999999999999@lid');
    stateSpy.resolveConversationJid.and.returnValue('5511987654321@c.us');

    component.onDraftChange('mensagem resolvida');
    tick(40);

    expect(stateSpy.setDraftTextForJid).toHaveBeenCalledWith('5511987654321@c.us', 'mensagem resolvida');
  }));

  it('cancels a pending draft sync when the external state clears the draft', () => {
    component.contact = makeContact('a@c.us');

    component.onDraftChange('texto antigo');
    draftSubject.next('');

    expect(stateSpy.setDraftTextForJid).not.toHaveBeenCalled();
    expect(component.draftText).toBe('');
  });

  it('restores composer focus when an active bulk queue is cancelled', fakeAsync(() => {
    component.contact = makeContact('a@c.us');
    const composerSpy = jasmine.createSpyObj('ComposerComponent', ['focus']);
    component.composer = composerSpy;

    queueSubject.next({ items: [] });
    queueSubject.next(null);
    tick();

    expect(composerSpy.focus).toHaveBeenCalled();
  }));

  it('retries composer focus after bulk cancel once message syncing finishes', fakeAsync(() => {
    component.contact = makeContact('a@c.us');
    const composerSpy = jasmine.createSpyObj('ComposerComponent', ['focus']);
    component.composer = composerSpy;

    loadingSubject.next({ instances: false, contacts: false, messages: true, sending: false });
    queueSubject.next({ items: [] });
    queueSubject.next(null);
    tick();

    expect(composerSpy.focus).not.toHaveBeenCalled();

    loadingSubject.next({ instances: false, contacts: false, messages: false, sending: false });
    tick();

    expect(composerSpy.focus).toHaveBeenCalledTimes(1);
  }));

  it('onSendText calls state.sendText with the resolved conversation jid', () => {
    component.contact = makeContact('a@c.us');
    component.isSyncingMessages = false;
    component.disabled = false;
    stateSpy.resolveConversationJid.and.returnValue('resolved@c.us');
    stateSpy.sendText.and.returnValue(of(undefined));

    component.onSendText('hello');

    expect(stateSpy.sendText).toHaveBeenCalledWith('resolved@c.us', 'hello');
  });

  it('keeps AI disabled even when agent settings are enabled', fakeAsync(() => {
    const contact = makeContact('a@c.us');
    gemSettingsSubject.next({
      enabled: true,
      gemUrl: 'https://gemini.google.com/gem/teste',
      responseMode: 'fast',
      googleAccounts: [{ id: 'primary', label: 'Conta principal', createdAt: new Date().toISOString(), lastUsedAt: null }],
      activeGoogleAccountId: 'primary'
    });
    selectedContactSubject.next(contact);
    jidSubject.next(contact.jid);

    selectedMessagesSubject.next([
      makeMessage('1', 'quero ver a calça', false)
    ]);

    tick(4000);

    expect(agentSpy.generateSuggestion).not.toHaveBeenCalled();
    expect(component.isSuggestionToggleOn).toBeFalse();
    expect(component.aiStatusMessage).toBe('');
  }));

  it('ignores manual refresh and guided suggestion requests while AI is disabled', fakeAsync(() => {
    const contact = makeContact('a@c.us');
    gemSettingsSubject.next({
      enabled: true,
      gemUrl: 'https://gemini.google.com/gem/teste',
      responseMode: 'fast',
      googleAccounts: [{ id: 'primary', label: 'Conta principal', createdAt: new Date().toISOString(), lastUsedAt: null }],
      activeGoogleAccountId: 'primary'
    });
    selectedContactSubject.next(contact);
    jidSubject.next(contact.jid);
    selectedMessagesSubject.next([makeMessage('1', 'quero ver o 36', false)]);

    component.onRefreshAiSuggestion();
    component.onGuidedAiSuggestion('responda curto e direto');
    tick();

    expect(agentSpy.generateSuggestion).not.toHaveBeenCalled();
  }));

  it('does not record agent feedback while AI is disabled', () => {
    const contact = makeContact('a@c.us');
    component.contact = contact;
    component.aiSuggestion = 'Resposta pronta';

    component.onRateAiSuggestion('up');

    expect(feedbackSpy.record).not.toHaveBeenCalled();
  });
});
