import { TestBed } from '@angular/core/testing';
import { BulkScheduleLifecycleEvent, BulkSendService } from './bulk-send.service';
import { WhatsappStateService } from './whatsapp-state.service';
import { WhatsappContact } from '../../../models/whatsapp.model';
import { BehaviorSubject, of } from 'rxjs';

function makeContact(jid: string, name = 'Test'): WhatsappContact {
  return { jid, phone: jid.replace('@c.us', ''), name, found: true };
}

function makeStateMock() {
  return {
    isSending: false,
    selectedContactJid: '',
    selectContact: jasmine.createSpy('selectContact'),
    setDraftText: jasmine.createSpy('setDraftText'),
    setDraftTextForJid: jasmine.createSpy('setDraftTextForJid'),
    setDraftImageDataUrl: jasmine.createSpy('setDraftImageDataUrl'),
    setDraftImageDataUrlForJid: jasmine.createSpy('setDraftImageDataUrlForJid'),
    clearDraftTextsForJids: jasmine.createSpy('clearDraftTextsForJids'),
    clearDraftImageDataUrlsForJids: jasmine.createSpy('clearDraftImageDataUrlsForJids'),
    getDraftTextForJid: jasmine.createSpy('getDraftTextForJid').and.returnValue(''),
    getDraftImageDataUrlForJid: jasmine.createSpy('getDraftImageDataUrlForJid').and.returnValue(null),
    sendText: jasmine.createSpy('sendText').and.returnValue(of({})),
    sendMedia: jasmine.createSpy('sendMedia').and.returnValue(of({})),
    messageSent$: new BehaviorSubject<{ jid: string; at: number } | null>(null),
  };
}

describe('BulkSendService', () => {
  let service: BulkSendService;
  let stateMock: ReturnType<typeof makeStateMock>;

  beforeEach(() => {
    localStorage.removeItem('uniq-system.whatsapp.bulk-queue');
    stateMock = makeStateMock();
    TestBed.configureTestingModule({
      providers: [
        BulkSendService,
        { provide: WhatsappStateService, useValue: stateMock }
      ]
    });
    service = TestBed.inject(BulkSendService);
  });

  afterEach(() => {
    service.ngOnDestroy();
    localStorage.removeItem('uniq-system.whatsapp.bulk-queue');
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('hasActiveQueue is false initially', () => {
    expect(service.hasActiveQueue).toBeFalse();
  });

  it('start creates a queue and selects first contact', () => {
    const contacts = [makeContact('5511@c.us', 'Ana'), makeContact('5522@c.us', 'Bia')];
    service.start(contacts, 'Olá {nome}');
    expect(service.hasActiveQueue).toBeTrue();
    expect(stateMock.selectContact).toHaveBeenCalledWith('5511@c.us', { loadHistory: false, markAsRead: false });
    expect(stateMock.setDraftTextForJid).toHaveBeenCalledWith('5511@c.us', 'Olá Ana');
  });

  it('start does nothing with empty contacts', () => {
    service.start([], 'template');
    expect(service.hasActiveQueue).toBeFalse();
  });

  it('start does nothing with empty template', () => {
    service.start([makeContact('5511@c.us')], '   ');
    expect(service.hasActiveQueue).toBeFalse();
  });

  it('currentItem returns current contact', () => {
    service.start([makeContact('5511@c.us', 'Ana')], 'Olá {nome}');
    expect(service.currentItem?.jid).toBe('5511@c.us');
    expect(service.currentItem?.status).toBe('current');
  });

  it('skipCurrent marks current as skipped and advances', () => {
    const contacts = [makeContact('5511@c.us'), makeContact('5522@c.us')];
    service.start(contacts, 'msg');
    service.skipCurrent();
    // 5511 should be skipped, 5522 should be current
    const queue = (service as unknown as { queueSubject: BehaviorSubject<unknown> }).queueSubject.value as { items: { jid: string; status: string }[] };
    expect(queue.items[0].status).toBe('skipped');
    expect(queue.items[1].status).toBe('current');
    expect(stateMock.clearDraftTextsForJids).toHaveBeenCalledWith(['5511@c.us']);
    expect(stateMock.clearDraftImageDataUrlsForJids).toHaveBeenCalledWith(['5511@c.us']);
  });

  it('cancel clears queue and resets drafts', () => {
    service.start([makeContact('5511@c.us')], 'msg');
    service.cancel();
    expect(service.hasActiveQueue).toBeFalse();
    expect(stateMock.clearDraftTextsForJids).toHaveBeenCalledWith(['5511@c.us']);
    expect(stateMock.clearDraftImageDataUrlsForJids).toHaveBeenCalledWith(['5511@c.us']);
  });

  it('cancel clears only the touched draft state instead of the full queue', () => {
    const contacts = [makeContact('5511@c.us'), makeContact('5522@c.us'), makeContact('5533@c.us')];

    service.start(contacts, 'msg');
    stateMock.clearDraftTextsForJids.calls.reset();
    stateMock.clearDraftImageDataUrlsForJids.calls.reset();

    service.skipCurrent();
    stateMock.clearDraftTextsForJids.calls.reset();
    stateMock.clearDraftImageDataUrlsForJids.calls.reset();

    service.cancel();

    expect(stateMock.clearDraftTextsForJids).toHaveBeenCalledWith(['5522@c.us']);
    expect(stateMock.clearDraftImageDataUrlsForJids).toHaveBeenCalledWith(['5522@c.us']);
  });

  it('pause sets isPaused to true', () => {
    service.start([makeContact('5511@c.us')], 'msg');
    service.pause();
    const queue = (service as unknown as { queueSubject: BehaviorSubject<{ isPaused: boolean }> }).queueSubject.value;
    expect(queue?.isPaused).toBeTrue();
  });

  it('canSendCurrent is true when the current contact has a draft message', () => {
    stateMock.getDraftTextForJid.and.returnValue('Mensagem pronta');

    service.start([makeContact('5511@c.us')], 'msg');

    expect(service.canSendCurrent).toBeTrue();
  });

  it('canSendCurrent is false while the current item is still sending', () => {
    stateMock.getDraftTextForJid.and.returnValue('Mensagem pronta');
    stateMock.isSending = true;

    service.start([makeContact('5511@c.us')], 'msg');

    expect(service.canSendCurrent).toBeFalse();
  });

  it('queue emits new value when started', () => {
    let emittedQueue: { items: unknown[] } | null = null;
    service.queue$.subscribe(q => { if (q) { emittedQueue = q as { items: unknown[] }; } });
    service.start([makeContact('5511@c.us')], 'msg');
    expect(emittedQueue).not.toBeNull();
    expect(emittedQueue!.items.length).toBe(1);
  });

  it('emits a cancelled schedule lifecycle event when a scheduled bulk is cancelled', () => {
    const events: BulkScheduleLifecycleEvent[] = [];
    service.scheduleLifecycle$.subscribe(value => events.push(value));

    service.start([makeContact('5511@c.us')], 'msg', undefined, { scheduleId: 'sch-1' });
    service.cancel();

    expect(events.length).toBe(1);
    expect(events[0].scheduleId).toBe('sch-1');
    expect(events[0].outcome).toBe('cancelled');
  });

  it('advances to next after messageSent$ fires for current jid', () => {
    const contacts = [makeContact('5511@c.us'), makeContact('5522@c.us')];
    service.start(contacts, 'msg');
    // Simulate message sent for current contact
    (stateMock.messageSent$ as BehaviorSubject<{ jid: string; at: number } | null>).next({ jid: '5511@c.us', at: Date.now() });
    const queue = (service as unknown as { queueSubject: BehaviorSubject<{ items: { jid: string; status: string }[] } | null> }).queueSubject.value;
    expect(queue?.items[0].status).toBe('done');
    expect(queue?.items[1].status).toBe('current');
    expect(stateMock.clearDraftTextsForJids).toHaveBeenCalledWith(['5511@c.us']);
  });

  it('emits a completed schedule lifecycle event when a scheduled bulk finishes', () => {
    const events: BulkScheduleLifecycleEvent[] = [];
    service.scheduleLifecycle$.subscribe(value => events.push(value));

    service.start([makeContact('5511@c.us')], 'msg', undefined, { scheduleId: 'sch-1' });
    (stateMock.messageSent$ as BehaviorSubject<{ jid: string; at: number } | null>).next({ jid: '5511@c.us', at: Date.now() });

    expect(events.length).toBe(1);
    expect(events[0].scheduleId).toBe('sch-1');
    expect(events[0].outcome).toBe('completed');
  });

  it('sendCurrent delegates text sending to the state service', () => {
    stateMock.getDraftTextForJid.and.returnValue('Mensagem pronta');
    service.start([makeContact('5511@c.us')], 'msg');

    service.sendCurrent();

    expect(stateMock.sendText).toHaveBeenCalledWith('5511@c.us', 'Mensagem pronta');
  });

  it('sendCurrent delegates media sending when the queue has an image template', () => {
    const imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    stateMock.getDraftTextForJid.and.returnValue('Legenda');
    service.start([makeContact('5511@c.us')], 'msg', imageDataUrl);

    service.sendCurrent();

    expect(stateMock.sendMedia).toHaveBeenCalled();
    const [jid, file, caption] = stateMock.sendMedia.calls.mostRecent().args;
    expect(jid).toBe('5511@c.us');
    expect(file).toEqual(jasmine.any(File));
    expect(caption).toBe('Legenda');
  });

  it('does not mutate the queue while the current item is still sending', () => {
    const contacts = [makeContact('5511@c.us'), makeContact('5522@c.us')];
    service.start(contacts, 'msg');
    stateMock.isSending = true;

    service.skipCurrent();
    service.cancel();
    service.sendCurrent();

    const queue = (service as unknown as { queueSubject: BehaviorSubject<{ items: { jid: string; status: string }[] } | null> }).queueSubject.value;
    expect(queue?.items[0].status).toBe('current');
    expect(service.hasActiveQueue).toBeTrue();
    expect(stateMock.sendText).not.toHaveBeenCalled();
  });
});
