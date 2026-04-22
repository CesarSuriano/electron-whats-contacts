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
      'getMessagesFor', 'setDraftText', 'sendText', 'sendMedia'
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
    return stateSpy;
  };

  beforeEach(async () => {
    const spy = makeStateSpyWith(null);

    bulkSpy = jasmine.createSpyObj('BulkSendService', [], {
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

  it('onDraftChange updates draftText and notifies state', () => {
    component.onDraftChange('new text');
    expect(component.draftText).toBe('new text');
    expect(stateSpy.setDraftText).toHaveBeenCalledWith('new text');
  });

  it('onSendText calls state.sendText with correct args', () => {
    component.contact = makeContact('a@c.us');
    component.isSyncingMessages = false;
    component.disabled = false;
    stateSpy.sendText.and.returnValue(of(undefined));

    component.onSendText('hello');

    expect(stateSpy.sendText).toHaveBeenCalledWith('a@c.us', 'hello');
  });

  it('waits a bit before generating a suggestion so consecutive customer messages can be grouped', fakeAsync(() => {
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

    tick(1500);
  expect(agentSpy.generateSuggestion).not.toHaveBeenCalled();

    selectedMessagesSubject.next([
      makeMessage('1', 'quero ver a calça', false),
      makeMessage('2', 'no 36', false)
    ]);

    tick(2000);
    expect(agentSpy.generateSuggestion).not.toHaveBeenCalled();

    tick(900);
    expect(agentSpy.generateSuggestion).toHaveBeenCalledTimes(1);
  }));

  it('ignores ready snapshots from the same contact when the context key is stale', fakeAsync(() => {
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
      makeMessage('1', 'quero ver o 36', false)
    ]);

    tick(1900);

    gemSuggestionSubject.next({
      status: 'ready',
      contactJid: contact.jid,
      contextKey: 'contexto-antigo',
      suggestion: 'resposta velha',
      errorMessage: '',
      source: 'gem',
      updatedAt: new Date().toISOString()
    });

    expect(component.aiSuggestion).toBe('');
  }));

  it('queues follow-up messages when the agent returns multiple parts', () => {
    const contact = makeContact('a@c.us');
    component.contact = contact;
    selectedContactSubject.next(contact);
    jidSubject.next(contact.jid);
    selectedMessagesSubject.next([makeMessage('1', 'quero saber horario e parcelamento', false)]);
    stateSpy.sendText.and.returnValue(of(undefined));
    agentSpy.clearSuggestion.and.callFake(() => {
      gemSuggestionSubject.next({
        status: 'idle',
        contactJid: contact.jid,
        contextKey: 'a@c.us::1',
        suggestion: '',
        errorMessage: '',
        source: 'none',
        updatedAt: null
      });
    });

    gemSuggestionSubject.next({
      status: 'ready',
      contactJid: 'a@c.us',
      contextKey: 'a@c.us::1',
      suggestion: 'Primeira resposta ||| Segunda resposta',
      errorMessage: '',
      source: 'gem',
      updatedAt: new Date().toISOString()
    });

    component.onAcceptAiSuggestion('Primeira resposta');
    component.onSendText('Primeira resposta');

    expect(component.aiSuggestion).toBe('Segunda resposta');
  });

  it('does not promote a queued follow-up after a manual send changes the topic', () => {
    const contact = makeContact('a@c.us');
    component.contact = contact;
    selectedContactSubject.next(contact);
    jidSubject.next(contact.jid);
    selectedMessagesSubject.next([makeMessage('1', 'oi', false)]);
    stateSpy.sendText.and.returnValue(of(undefined));

    gemSuggestionSubject.next({
      status: 'ready',
      contactJid: 'a@c.us',
      contextKey: 'a@c.us::1',
      suggestion: 'Temos sim o modelo flare no 36. ||| Vou te enviar as fotos das opções que temos no azul e no modelo flare agora mesmo.',
      errorMessage: '',
      source: 'gem',
      updatedAt: new Date().toISOString()
    });

    component.onDraftChange('Estou procurando a camisa italiana');
    component.onSendText('Estou procurando a camisa italiana');

    expect(component.aiSuggestion).toBe('');
  });

  it('passes the operator instruction when requesting a guided suggestion', () => {
    const contact = makeContact('a@c.us');
    component.contact = contact;
    component.disabled = false;
    component.isSyncingMessages = false;
    gemSettingsSubject.next({
      enabled: true,
      gemUrl: 'https://gemini.google.com/gem/teste',
      responseMode: 'reasoning',
      googleAccounts: [{ id: 'primary', label: 'Conta principal', createdAt: new Date().toISOString(), lastUsedAt: null }],
      activeGoogleAccountId: 'primary'
    });
    selectedContactSubject.next(contact);
    jidSubject.next(contact.jid);
    selectedMessagesSubject.next([
      makeMessage('1', 'quero o valor', false)
    ]);

    component.onGuidedAiSuggestion('responda curto e direto');

    expect(agentSpy.generateSuggestion).toHaveBeenCalledWith(jasmine.objectContaining({
      operatorInstruction: 'responda curto e direto'
    }));
  });

  it('records feedback as Gem feedback', () => {
    const contact = makeContact('a@c.us');
    component.contact = contact;
    selectedMessagesSubject.next([
      makeMessage('1', 'oi', false)
    ]);
    component.aiSuggestion = 'Resposta pronta';

    component.onRateAiSuggestion('up');

    expect(feedbackSpy.record).toHaveBeenCalledWith(jasmine.objectContaining({
      provider: 'gem',
      rating: 'up',
      contactJid: 'a@c.us'
    }));
  });
});
