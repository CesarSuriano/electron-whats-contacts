import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject, of } from 'rxjs';

import { WhatsappContact, WhatsappMessage } from '../../../../models/whatsapp.model';
import { BulkSendService } from '../../services/bulk-send.service';
import { WhatsappStateService } from '../../services/whatsapp-state.service';
import { ChatViewComponent } from './chat-view.component';

const makeContact = (jid = 'a@c.us'): WhatsappContact => ({
  jid, phone: '5511987654321', name: 'Ana', found: true
});

describe('ChatViewComponent', () => {
  let fixture: ComponentFixture<ChatViewComponent>;
  let component: ChatViewComponent;
  let stateSpy: jasmine.SpyObj<WhatsappStateService>;
  let bulkSpy: jasmine.SpyObj<BulkSendService>;

  const makeStateSpyWith = (contact: WhatsappContact | null) => {
    const jid$ = new BehaviorSubject<string>(contact?.jid || '');
    const contacts$ = new BehaviorSubject<WhatsappContact[]>(contact ? [contact] : []);
    const messages$ = new BehaviorSubject<WhatsappMessage[]>([]);
    const loading$ = new BehaviorSubject({ instances: false, contacts: false, messages: false, sending: false });
    const draft$ = new BehaviorSubject<string>('');
    const draftImage$ = new BehaviorSubject<string | null>(null);
    const syncing$ = new BehaviorSubject<boolean>(false);
    const selectedMessages$ = new BehaviorSubject<WhatsappMessage[]>([]);
    const selectedContact$ = new BehaviorSubject<WhatsappContact | null>(contact);

    stateSpy = jasmine.createSpyObj('WhatsappStateService', [
      'getMessagesFor', 'setDraftText', 'sendText', 'sendMedia'
    ], {
      selectedContactJid$: jid$.asObservable(),
      contacts$: contacts$.asObservable(),
      messages$: messages$.asObservable(),
      loadingState$: loading$.asObservable(),
      draftText$: draft$.asObservable(),
      draftImageDataUrl$: draftImage$.asObservable(),
      syncing$: syncing$.asObservable(),
      selectedMessages$: selectedMessages$.asObservable(),
      selectedContact$: selectedContact$.asObservable()
    });
    stateSpy.getMessagesFor.and.returnValue([]);
    return stateSpy;
  };

  beforeEach(async () => {
    const spy = makeStateSpyWith(null);

    bulkSpy = jasmine.createSpyObj('BulkSendService', [], {
      hasActiveQueue: false
    });

    await TestBed.configureTestingModule({
      declarations: [ChatViewComponent],
      providers: [
        { provide: WhatsappStateService, useValue: spy },
        { provide: BulkSendService, useValue: bulkSpy }
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

  it('onSendText does nothing when no contact', () => {
    component.contact = null;
    component.onSendText('hello');
    expect(stateSpy.sendText).not.toHaveBeenCalled();
  });

  it('onSendText does nothing when disabled', () => {
    component.contact = makeContact();
    component.disabled = true;
    component.onSendText('hello');
    expect(stateSpy.sendText).not.toHaveBeenCalled();
  });

  it('onSendText does nothing when syncing messages', () => {
    component.contact = makeContact();
    component.isSyncingMessages = true;
    component.onSendText('hello');
    expect(stateSpy.sendText).not.toHaveBeenCalled();
  });

  it('onSendText calls state.sendText with correct args', () => {
    component.contact = makeContact('a@c.us');
    component.isSyncingMessages = false;
    component.disabled = false;
    stateSpy.sendText.and.returnValue(of(undefined));
    component.onSendText('hello');
    expect(stateSpy.sendText).toHaveBeenCalledWith('a@c.us', 'hello');
  });

  it('onSendMedia does nothing when no contact', () => {
    component.contact = null;
    const file = new File(['a'], 'a.jpg', { type: 'image/jpeg' });
    component.onSendMedia({ file, caption: '' });
    expect(stateSpy.sendMedia).not.toHaveBeenCalled();
  });

  it('onSendMedia calls state.sendMedia with correct args', () => {
    component.contact = makeContact('a@c.us');
    component.disabled = false;
    component.isSyncingMessages = false;
    const file = new File(['data'], 'img.jpg', { type: 'image/jpeg' });
    stateSpy.sendMedia.and.returnValue(of(undefined));
    component.onSendMedia({ file, caption: 'test' });
    expect(stateSpy.sendMedia).toHaveBeenCalledWith('a@c.us', file, 'test');
  });
});
