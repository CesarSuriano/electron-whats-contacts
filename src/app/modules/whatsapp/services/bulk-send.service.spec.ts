import { TestBed } from '@angular/core/testing';
import { BulkSendService } from './bulk-send.service';
import { WhatsappStateService } from './whatsapp-state.service';
import { WhatsappContact } from '../../../models/whatsapp.model';
import { BehaviorSubject, Subject } from 'rxjs';

function makeContact(jid: string, name = 'Test'): WhatsappContact {
  return { jid, phone: jid.replace('@c.us', ''), name, found: true };
}

function makeStateMock() {
  return {
    selectContact: jasmine.createSpy('selectContact'),
    setDraftText: jasmine.createSpy('setDraftText'),
    setDraftImageDataUrl: jasmine.createSpy('setDraftImageDataUrl'),
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
    expect(stateMock.selectContact).toHaveBeenCalledWith('5511@c.us');
    expect(stateMock.setDraftText).toHaveBeenCalled();
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
  });

  it('cancel clears queue and resets drafts', () => {
    service.start([makeContact('5511@c.us')], 'msg');
    service.cancel();
    expect(service.hasActiveQueue).toBeFalse();
    expect(stateMock.setDraftText).toHaveBeenCalledWith('');
    expect(stateMock.setDraftImageDataUrl).toHaveBeenCalledWith(null);
  });

  it('pause sets isPaused to true', () => {
    service.start([makeContact('5511@c.us')], 'msg');
    service.pause();
    const queue = (service as unknown as { queueSubject: BehaviorSubject<{ isPaused: boolean }> }).queueSubject.value;
    expect(queue?.isPaused).toBeTrue();
  });

  it('queue emits new value when started', () => {
    let emittedQueue: { items: unknown[] } | null = null;
    service.queue$.subscribe(q => { if (q) { emittedQueue = q as { items: unknown[] }; } });
    service.start([makeContact('5511@c.us')], 'msg');
    expect(emittedQueue).not.toBeNull();
    expect(emittedQueue!.items.length).toBe(1);
  });

  it('advances to next after messageSent$ fires for current jid', () => {
    const contacts = [makeContact('5511@c.us'), makeContact('5522@c.us')];
    service.start(contacts, 'msg');
    // Simulate message sent for current contact
    (stateMock.messageSent$ as BehaviorSubject<{ jid: string; at: number } | null>).next({ jid: '5511@c.us', at: Date.now() });
    const queue = (service as unknown as { queueSubject: BehaviorSubject<{ items: { jid: string; status: string }[] } | null> }).queueSubject.value;
    expect(queue?.items[0].status).toBe('done');
    expect(queue?.items[1].status).toBe('current');
  });
});
