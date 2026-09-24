import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { BulkInterruptedEvent, BulkQueue, BulkScheduleLifecycleEvent, BulkSendService } from './bulk-send.service';
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
    resolveConversationJid: jasmine.createSpy('resolveConversationJid').and.callFake((jid: string) => jid),
    selectContact: jasmine.createSpy('selectContact'),
    setDraftText: jasmine.createSpy('setDraftText'),
    setDraftTextForJid: jasmine.createSpy('setDraftTextForJid'),
    setDraftImageDataUrls: jasmine.createSpy('setDraftImageDataUrls'),
    setDraftImageDataUrlsForJid: jasmine.createSpy('setDraftImageDataUrlsForJid'),
    setDraftImageDataUrl: jasmine.createSpy('setDraftImageDataUrl'),
    setDraftImageDataUrlForJid: jasmine.createSpy('setDraftImageDataUrlForJid'),
    clearDraftTextsForJids: jasmine.createSpy('clearDraftTextsForJids'),
    clearDraftImageDataUrlsForJids: jasmine.createSpy('clearDraftImageDataUrlsForJids'),
    getDraftTextForJid: jasmine.createSpy('getDraftTextForJid').and.returnValue(''),
    getDraftImageDataUrlsForJid: jasmine.createSpy('getDraftImageDataUrlsForJid').and.returnValue([]),
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
    localStorage.removeItem('uniq-system.whatsapp.bulk-queue-images');
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
    localStorage.removeItem('uniq-system.whatsapp.bulk-queue-images');
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

  it('start accepts an empty template so each contact can be filled manually', () => {
    service.start([makeContact('5511@c.us')], '   ');
    expect(service.hasActiveQueue).toBeTrue();
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

  it('emits the remaining contacts when a new bulk replaces an unfinished one', () => {
    const events: BulkInterruptedEvent[] = [];
    service.interrupted$.subscribe(value => events.push(value));

    service.start([makeContact('5511@c.us', 'Ana'), makeContact('5522@c.us', 'Bia'), makeContact('5533@c.us', 'Caio')], 'msg', undefined, { scheduleId: 'sch-1' });
    service.skipCurrent();
    service.start([makeContact('5599@c.us', 'Duda')], 'outra');

    expect(events.length).toBe(1);
    expect(events[0].queue.scheduleId).toBe('sch-1');
    expect(events[0].processedCount).toBe(1);
    expect(events[0].remainingItems.map(item => item.jid)).toEqual(['5522@c.us', '5533@c.us']);
    expect(service.currentItem?.jid).toBe('5599@c.us');
  });

  it('does not emit interrupted when the bulk is cancelled', () => {
    const events: BulkInterruptedEvent[] = [];
    service.interrupted$.subscribe(value => events.push(value));

    service.start([makeContact('5511@c.us'), makeContact('5522@c.us')], 'msg');
    service.cancel();
    service.start([makeContact('5599@c.us')], 'outra');

    expect(events.length).toBe(0);
  });

  it('waits half a second after messageSent$ before advancing to the next contact', fakeAsync(() => {
    const contacts = [makeContact('5511@c.us'), makeContact('5522@c.us')];
    service.start(contacts, 'msg');
    (stateMock.messageSent$ as BehaviorSubject<{ jid: string; at: number } | null>).next({ jid: '5511@c.us', at: Date.now() });

    let queue = (service as unknown as { queueSubject: BehaviorSubject<{ items: { jid: string; status: string }[] } | null> }).queueSubject.value;
    expect(queue?.items[0].status).toBe('done');
    expect(queue?.items[1].status).toBe('pending');
    expect(service.isSendingCurrent).toBeTrue();
    expect(stateMock.clearDraftTextsForJids).toHaveBeenCalledWith(['5511@c.us']);

    tick(500);

    queue = (service as unknown as { queueSubject: BehaviorSubject<{ items: { jid: string; status: string }[] } | null> }).queueSubject.value;
    expect(queue?.items[1].status).toBe('current');
    expect(service.isSendingCurrent).toBeFalse();

    tick(120);
  }));

  it('emits a completed schedule lifecycle event when a scheduled bulk finishes', fakeAsync(() => {
    const events: BulkScheduleLifecycleEvent[] = [];
    service.scheduleLifecycle$.subscribe(value => events.push(value));

    service.start([makeContact('5511@c.us')], 'msg', undefined, { scheduleId: 'sch-1' });
    (stateMock.messageSent$ as BehaviorSubject<{ jid: string; at: number } | null>).next({ jid: '5511@c.us', at: Date.now() });

    tick(500);

    expect(events.length).toBe(1);
    expect(events[0].scheduleId).toBe('sch-1');
    expect(events[0].outcome).toBe('completed');
  }));

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

  it('reuses the decoded image file for every contact of the same queue', fakeAsync(() => {
    const imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    stateMock.getDraftTextForJid.and.returnValue('Legenda');
    service.start([makeContact('5511@c.us'), makeContact('5522@c.us')], 'msg', imageDataUrl);

    service.sendCurrent();
    (stateMock.messageSent$ as BehaviorSubject<{ jid: string; at: number } | null>).next({ jid: '5511@c.us', at: Date.now() });
    tick(500);
    service.sendCurrent();
    tick(120);

    expect(stateMock.sendMedia).toHaveBeenCalledTimes(2);
    const firstFile = stateMock.sendMedia.calls.argsFor(0)[1] as File;
    const secondFile = stateMock.sendMedia.calls.argsFor(1)[1] as File;
    expect(stateMock.sendMedia.calls.argsFor(1)[0]).toBe('5522@c.us');
    expect(secondFile).toBe(firstFile);
    expect(firstFile.type).toBe('image/png');
    expect(firstFile.name).toBe('bulk-template.png');
  }));

  it('sendCurrent sends every queued image and keeps the caption only on the first file', () => {
    const imageDataUrls = [
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGElEQVR42mP8z/D/PwMDAwMjI+P/AwMDAB9mBAd2vNh4AAAAAElFTkSuQmCC'
    ];
    stateMock.getDraftTextForJid.and.returnValue('Legenda');
    service.start([makeContact('5511@c.us')], 'msg', imageDataUrls);

    service.sendCurrent();

    expect(stateMock.sendMedia).toHaveBeenCalledTimes(2);
    expect(stateMock.sendMedia.calls.argsFor(0)[2]).toBe('Legenda');
    expect(stateMock.sendMedia.calls.argsFor(1)[2]).toBe('');
  });

  it('updateTemplate refreshes the active queue draft instead of starting a new queue', () => {
    const imageDataUrls = ['data:image/png;base64,updated'];
    service.start([makeContact('5511@c.us', 'Ana'), makeContact('5522@c.us', 'Bia')], 'Olá {nome}');
    stateMock.setDraftTextForJid.calls.reset();
    stateMock.setDraftImageDataUrlsForJid.calls.reset();

    service.updateTemplate('Nova {nome}', imageDataUrls);

    expect(stateMock.setDraftTextForJid).toHaveBeenCalledWith('5511@c.us', 'Nova Ana');
    expect(stateMock.setDraftImageDataUrlsForJid).toHaveBeenCalledWith('5511@c.us', imageDataUrls);
  });

  it('opens and sends using the resolved canonical jid when the queue item jid is synthetic', () => {
    stateMock.resolveConversationJid.and.callFake((jid: string) =>
      jid === '551187654321@c.us' ? '5511987654321@c.us' : jid
    );
    stateMock.getDraftTextForJid.and.callFake((jid: string) =>
      jid === '5511987654321@c.us' ? 'Mensagem pronta' : ''
    );

    service.start([makeContact('551187654321@c.us', 'Ana')], 'Ola {nome}');
    service.sendCurrent();

    expect(stateMock.selectContact).toHaveBeenCalledWith('5511987654321@c.us', { loadHistory: false, markAsRead: false });
    expect(stateMock.setDraftTextForJid).toHaveBeenCalledWith('5511987654321@c.us', 'Ola Ana');
    expect(stateMock.sendText).toHaveBeenCalledWith('5511987654321@c.us', 'Mensagem pronta');
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

  describe('queue persistence', () => {
    const QUEUE_KEY = 'uniq-system.whatsapp.bulk-queue';
    const IMAGES_KEY = 'uniq-system.whatsapp.bulk-queue-images';
    const imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    function restoreFromStorage(): BulkSendService {
      const restoredService = new BulkSendService(stateMock as unknown as WhatsappStateService);
      return restoredService;
    }

    it('stores the images once and only the item statuses on every step', fakeAsync(() => {
      const setItemSpy = spyOn(Storage.prototype, 'setItem').and.callThrough();

      service.start([makeContact('5511@c.us'), makeContact('5522@c.us'), makeContact('5533@c.us')], 'msg', imageDataUrl);
      tick(120);
      service.skipCurrent();
      tick(120);
      service.skipCurrent();
      tick(120);

      const imageWrites = setItemSpy.calls.all().filter(call => call.args[0] === IMAGES_KEY);
      expect(imageWrites.length).toBe(1);

      const persisted = JSON.parse(localStorage.getItem(QUEUE_KEY)!);
      expect(persisted.imageDataUrls).toBeUndefined();
      expect(persisted.imageDataUrl).toBeUndefined();
      expect(persisted.imageCount).toBe(1);
      expect(persisted.items.map((item: { status: string }) => item.status)).toEqual(['skipped', 'skipped', 'current']);
      expect(JSON.parse(localStorage.getItem(IMAGES_KEY)!)).toEqual([imageDataUrl]);
    }));

    it('restores a paused queue with its images after the app restarts', fakeAsync(() => {
      service.start([makeContact('5511@c.us'), makeContact('5522@c.us')], 'Olá {nome}', imageDataUrl);
      tick(120);
      service.skipCurrent();
      tick(120);

      const restoredService = restoreFromStorage();
      const restored = (restoredService as unknown as { queueSubject: BehaviorSubject<BulkQueue | null> }).queueSubject.value;

      expect(restored?.isPaused).toBeTrue();
      expect(restored?.template).toBe('Olá {nome}');
      expect(restored?.imageDataUrls).toEqual([imageDataUrl]);
      expect(restored?.items.map(item => item.status)).toEqual(['skipped', 'pending']);
      restoredService.ngOnDestroy();
    }));

    it('restores queues saved in the previous format with the images inline', () => {
      localStorage.setItem(QUEUE_KEY, JSON.stringify({
        template: 'msg',
        imageDataUrls: [imageDataUrl],
        items: [{ jid: '5511@c.us', name: 'Ana', status: 'current' }],
        isPaused: false,
        createdAt: '2026-09-01T10:00:00.000Z'
      }));

      const restoredService = restoreFromStorage();
      const restored = (restoredService as unknown as { queueSubject: BehaviorSubject<BulkQueue | null> }).queueSubject.value;

      expect(restored?.imageDataUrls).toEqual([imageDataUrl]);
      expect(restored?.items[0].status).toBe('pending');
      restoredService.ngOnDestroy();
    });

    it('does not restore a queue whose images could not be saved, so it never resumes without them', () => {
      localStorage.setItem(QUEUE_KEY, JSON.stringify({
        template: 'msg',
        imageCount: 1,
        items: [{ jid: '5511@c.us', name: 'Ana', status: 'pending' }],
        isPaused: true,
        createdAt: '2026-09-01T10:00:00.000Z'
      }));

      const restoredService = restoreFromStorage();

      expect(restoredService.hasActiveQueue).toBeFalse();
      expect(localStorage.getItem(QUEUE_KEY)).toBeNull();
      restoredService.ngOnDestroy();
    });

    it('drops the previous images when a text-only queue replaces an image queue', fakeAsync(() => {
      service.start([makeContact('5511@c.us')], 'com imagem', imageDataUrl);
      tick(120);
      service.start([makeContact('5522@c.us')], 'só texto');
      tick(120);

      expect(localStorage.getItem(IMAGES_KEY)).toBeNull();

      const restoredService = restoreFromStorage();
      const restored = (restoredService as unknown as { queueSubject: BehaviorSubject<BulkQueue | null> }).queueSubject.value;
      expect(restored?.template).toBe('só texto');
      expect(restored?.imageDataUrls).toBeUndefined();
      restoredService.ngOnDestroy();
    }));

    it('clears everything when the queue is cancelled', fakeAsync(() => {
      service.start([makeContact('5511@c.us'), makeContact('5522@c.us')], 'msg', imageDataUrl);
      tick(120);
      service.cancel();

      expect(localStorage.getItem(QUEUE_KEY)).toBeNull();
      expect(localStorage.getItem(IMAGES_KEY)).toBeNull();
    }));
  });
});
