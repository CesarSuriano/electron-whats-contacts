import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { EMPTY, of, throwError } from 'rxjs';

import { WhatsappStateService } from './whatsapp-state.service';
import { WhatsappWebjsGatewayService } from '../../../services/whatsapp-webjs-gateway.service';
import { WhatsappWsService } from '../../../services/whatsapp-ws.service';
import { WhatsappContact, WhatsappInstance, WhatsappMessage } from '../../../models/whatsapp.model';

const mockInstance: WhatsappInstance = { name: 'inst1', token: 'tok', connected: true, jid: 'jid', webhook: '' };
const mockContact: WhatsappContact = { jid: 'c1@s.whatsapp.net', phone: '5511', name: 'Alice', found: true };
const secondMockContact: WhatsappContact = { jid: 'c2@s.whatsapp.net', phone: '5522', name: 'Bob', found: true };

function makeBootstrapContact(index: number): WhatsappContact {
  return {
    jid: `c${index}@s.whatsapp.net`,
    phone: `55${index}`,
    name: `Contato ${index}`,
    found: true,
    lastMessagePreview: `mensagem ${index}`,
    getChatsTimestampMs: (1_000 - index) * 1_000,
    fromGetChats: true
  };
}

function makeGatewayStub(): jasmine.SpyObj<WhatsappWebjsGatewayService> {
  return jasmine.createSpyObj<WhatsappWebjsGatewayService>('WhatsappWebjsGatewayService', [
    'loadInstances',
    'loadContacts',
    'loadContactPhoto',
    'loadEvents',
    'loadChatMessages',
    'sendMessage',
    'sendMedia',
    'markChatSeen',
    'loadSessionStatus',
    'connectSession',
    'disconnectSession'
  ]);
}

describe('WhatsappStateService', () => {
  let service: WhatsappStateService;
  let gateway: jasmine.SpyObj<WhatsappWebjsGatewayService>;

  beforeEach(() => {
    const stub = makeGatewayStub();
    stub.loadInstances.and.returnValue(of([mockInstance]));
    stub.loadContacts.and.returnValue(of([mockContact]));
    stub.loadContactPhoto.and.returnValue(of(null));
    stub.loadEvents.and.returnValue(of([]));
    stub.loadChatMessages.and.returnValue(of([]));
    stub.markChatSeen.and.returnValue(of(undefined));

    TestBed.configureTestingModule({
      providers: [
        WhatsappStateService,
        { provide: WhatsappWebjsGatewayService, useValue: stub },
        {
          provide: WhatsappWsService,
          useValue: jasmine.createSpyObj('WhatsappWsService', ['connect', 'disconnect', 'on'], {
            connected$: EMPTY
          })
        }
      ]
    });

    const ws = TestBed.inject(WhatsappWsService) as jasmine.SpyObj<WhatsappWsService>;
    ws.on.and.returnValue(EMPTY);

    service = TestBed.inject(WhatsappStateService);
    gateway = TestBed.inject(WhatsappWebjsGatewayService) as jasmine.SpyObj<WhatsappWebjsGatewayService>;
  });

  afterEach(() => service.ngOnDestroy());

  // ─── getContact ────────────────────────────────────────────────────────────

  describe('syncing$', () => {
    it('emits true immediately and delays false briefly', fakeAsync(() => {
      const emitted: boolean[] = [];
      service.syncing$.subscribe(value => emitted.push(value));

      (service as any).syncingSubject.next(true);
      expect(emitted).toEqual([true]);

      (service as any).syncingSubject.next(false);
      tick(149);
      expect(emitted).toEqual([true]);

      tick(1);
      expect(emitted).toEqual([true, false]);
    }));
  });

  describe('getContact', () => {
    it('returns null when contacts list is empty', () => {
      expect(service.getContact('unknown')).toBeNull();
    });
  });

  // ─── getMessagesFor ─────────────────────────────────────────────────────────

  describe('getMessagesFor', () => {
    it('returns empty array for empty jid', () => {
      expect(service.getMessagesFor('')).toEqual([]);
    });

    it('returns empty array when no messages exist for jid', () => {
      expect(service.getMessagesFor('nobody@s.whatsapp.net')).toEqual([]);
    });
  });

  // ─── loadInstances ──────────────────────────────────────────────────────────

  describe('loadInstances', () => {
    it('calls gateway and updates instances$', () => {
      let instances: WhatsappInstance[] | undefined;
      service.instances$.subscribe(i => (instances = i));

      service.loadInstances();

      expect(gateway.loadInstances).toHaveBeenCalledTimes(1);
      expect(instances).toEqual([mockInstance]);
    });

    it('does not call gateway a second time when called twice', () => {
      service.loadInstances();
      service.loadInstances();
      expect(gateway.loadInstances).toHaveBeenCalledTimes(1);
    });

    it('starts loading contacts immediately for the selected instance', () => {
      service.loadInstances();

      expect(gateway.loadContacts).toHaveBeenCalledWith(mockInstance.name, { waitForRefresh: true });
    });

    it('loads conversation context for each contact after contacts bootstrap', fakeAsync(() => {
      gateway.loadContacts.and.returnValue(of([
        {
          ...mockContact,
          lastMessagePreview: 'primeira',
          getChatsTimestampMs: 2_000,
          fromGetChats: true
        },
        {
          ...secondMockContact,
          lastMessagePreview: 'segunda',
          getChatsTimestampMs: 1_000,
          fromGetChats: true
        }
      ]));

      service.loadInstances();
      tick();

      const calledArgs = gateway.loadChatMessages.calls.all().map((call: { args: unknown[] }) => call.args);
      expect(calledArgs).toEqual([
        [mockInstance.name, mockContact.jid, 10, false],
        [mockInstance.name, secondMockContact.jid, 10, false]
      ]);
    }));

    it('preloads all unread messages for unread conversations during bootstrap', fakeAsync(() => {
      gateway.loadContacts.and.returnValue(of([
        {
          ...mockContact,
          lastMessagePreview: 'primeira',
          getChatsTimestampMs: 2_000,
          fromGetChats: true,
          unreadCount: 150
        }
      ]));

      service.loadInstances();
      tick();

      expect(gateway.loadChatMessages).toHaveBeenCalledWith(mockInstance.name, mockContact.jid, 150, false);
    }));

    it('caps bootstrap context loading to the first 100 contacts', fakeAsync(() => {
      const contacts = Array.from({ length: 120 }, (_, index) => makeBootstrapContact(index + 1));
      gateway.loadContacts.and.returnValue(of(contacts));

      service.loadInstances();
      tick();

      const calledJids = gateway.loadChatMessages.calls.all().map((call: { args: unknown[] }) => call.args[1] as string);
      expect(calledJids.length).toBe(100);
      expect(calledJids).toEqual(contacts.slice(0, 100).map(contact => contact.jid));
    }));

    it('prioritizes unread conversations in the bootstrap queue even when they are older', fakeAsync(() => {
      const contacts = Array.from({ length: 120 }, (_, index) => makeBootstrapContact(index + 1));
      const unreadTailContact = {
        ...makeBootstrapContact(999),
        jid: 'older-unread@s.whatsapp.net',
        getChatsTimestampMs: 1,
        unreadCount: 3,
        lastMessagePreview: 'não lida'
      };
      contacts[119] = unreadTailContact;
      gateway.loadContacts.and.returnValue(of(contacts));

      service.loadInstances();
      tick();

      const calledJids = gateway.loadChatMessages.calls.all().map((call: { args: unknown[] }) => call.args[1] as string);
      expect(calledJids).toContain(unreadTailContact.jid);
    }));

    it('sets error message on gateway failure', () => {
      gateway.loadInstances.and.returnValue(throwError(() => new Error('network')));

      let error = '';
      service.errorMessage$.subscribe(e => (error = e));

      service.loadInstances();

      expect(error).toBeTruthy();
    });

  });

  // ─── selection mode ─────────────────────────────────────────────────────────

  describe('selection mode', () => {
    it('starts as false', () => {
      expect(service.isSelectionMode).toBe(false);
    });

    it('enterSelectionMode sets mode to true', () => {
      service.enterSelectionMode();
      expect(service.isSelectionMode).toBe(true);
    });

    it('exitSelectionMode resets mode and clears selectedJids', () => {
      service.enterSelectionMode();
      service.toggleContactSelection('jid1');
      service.exitSelectionMode();
      expect(service.isSelectionMode).toBe(false);
      expect(service.selectedJids).toEqual([]);
    });
  });

  // ─── toggleContactSelection ─────────────────────────────────────────────────

  describe('toggleContactSelection', () => {
    it('adds jid on first toggle', () => {
      service.toggleContactSelection('jid1');
      expect(service.selectedJids).toContain('jid1');
    });

    it('removes jid on second toggle', () => {
      service.toggleContactSelection('jid1');
      service.toggleContactSelection('jid1');
      expect(service.selectedJids).not.toContain('jid1');
    });
  });

  // ─── selectAll ───────────────────────────────────────────────────────────────

  describe('selectAll', () => {
    it('sets all provided jids as selected', () => {
      service.selectAll(['a', 'b', 'c']);
      expect(service.selectedJids.sort()).toEqual(['a', 'b', 'c']);
    });
  });

  // ─── isSelected ─────────────────────────────────────────────────────────────

  describe('isSelected', () => {
    it('returns false for unselected jid', () => {
      expect(service.isSelected('unselected')).toBe(false);
    });

    it('returns true for selected jid', () => {
      service.toggleContactSelection('jid1');
      expect(service.isSelected('jid1')).toBe(true);
    });
  });

  // ─── draft text / image ──────────────────────────────────────────────────────

  describe('setDraftText', () => {
    it('emits new draft text', () => {
      let draft = '';
      service.draftText$.subscribe(t => (draft = t));

      service.selectContact(mockContact.jid);
      service.setDraftText('Olá mundo');

      expect(draft).toBe('Olá mundo');
    });

    it('keeps a separate draft for each conversation', () => {
      let draft = '';
      (service as any).contactsSubject.next([mockContact, secondMockContact]);
      service.draftText$.subscribe(value => (draft = value));

      service.selectContact(mockContact.jid);
      service.setDraftText('rascunho da Alice');
      expect(draft).toBe('rascunho da Alice');

      service.selectContact(secondMockContact.jid);
      expect(draft).toBe('');

      service.setDraftText('rascunho do Bob');
      expect(draft).toBe('rascunho do Bob');

      service.selectContact(mockContact.jid);
      expect(draft).toBe('rascunho da Alice');
    });

    it('can clear draft text for multiple conversations at once', () => {
      let draft = '';
      (service as any).contactsSubject.next([mockContact, secondMockContact]);
      service.draftText$.subscribe(value => (draft = value));

      service.selectContact(mockContact.jid);
      service.setDraftText('rascunho da Alice');
      service.selectContact(secondMockContact.jid);
      service.setDraftText('rascunho do Bob');

      service.clearDraftTextsForJids([mockContact.jid, secondMockContact.jid]);
      service.selectContact(mockContact.jid, { loadHistory: false, markAsRead: false });

      expect(draft).toBe('');
    });
  });

  describe('setDraftImageDataUrl', () => {
    it('emits dataUrl', () => {
      let url: string | null = '';
      service.draftImageDataUrl$.subscribe(u => (url = u));

      service.selectContact(mockContact.jid);
      service.setDraftImageDataUrl('data:image/png;base64,abc');

      expect(url).toBe('data:image/png;base64,abc');
    });
  });

  // ─── sendText ────────────────────────────────────────────────────────────────

  describe('sendText', () => {
    it('calls gateway.sendMessage with correct args and appends local message', () => {
      gateway.sendMessage.and.returnValue(of({ ok: true }));

      let messages: WhatsappMessage[] = [];
      service.messages$.subscribe(m => (messages = m));

      service.sendText('jid1', 'Olá').subscribe();

      expect(gateway.sendMessage).toHaveBeenCalledWith('', 'jid1', 'Olá');
      expect(messages.some(m => m.text === 'Olá' && m.contactJid === 'jid1')).toBe(true);
    });

    it('sets error on failure', () => {
      gateway.sendMessage.and.returnValue(throwError(() => new Error('send failed')));

      let errorMsg = '';
      service.errorMessage$.subscribe(e => (errorMsg = e));

      service.sendText('jid1', 'Oi').subscribe({ error: () => {} });

      expect(errorMsg).toBeTruthy();
    });
  });

  // ─── refresh ─────────────────────────────────────────────────────────────────

  describe('refresh', () => {
    it('does not throw when called with no selected instance', () => {
      expect(() => service.refresh()).not.toThrow();
    });
  });

  describe('selectContact', () => {
    beforeEach(() => {
      (service as unknown as { selectedInstanceSubject: { next(value: string): void } }).selectedInstanceSubject.next(mockInstance.name);
      (service as unknown as { contactsSubject: { next(value: WhatsappContact[]): void } }).contactsSubject.next([mockContact]);
    });

    it('loads history silently when the selected chat still needs server history', fakeAsync(() => {
      gateway.loadChatMessages.and.returnValue(of([]));

      let loadingState = { instances: false, contacts: false, messages: false, sending: false };
      service.loadingState$.subscribe(state => (loadingState = state));

      service.selectContact(mockContact.jid);

      tick();

      expect(gateway.loadChatMessages).toHaveBeenCalledTimes(1);
      expect(gateway.loadChatMessages).toHaveBeenCalledWith(mockInstance.name, mockContact.jid, 180, true);
      expect(loadingState.messages).toBeFalse();
    }));

    it('skips history fetch when the chat history is already marked as loaded', () => {
      gateway.loadChatMessages.and.returnValue(of([]));
      (service as unknown as { loadedHistoryJids: Set<string> }).loadedHistoryJids.add(mockContact.jid);

      let loadingState = { instances: false, contacts: false, messages: false, sending: false };
      service.loadingState$.subscribe(state => (loadingState = state));

      service.selectContact(mockContact.jid);

      expect(gateway.loadChatMessages).not.toHaveBeenCalled();
      expect(loadingState.messages).toBeFalse();
    });

    it('supports lightweight contact selection without history loading or mark-as-read', () => {
      gateway.loadChatMessages.and.returnValue(of([]));

      service.selectContact(mockContact.jid, { loadHistory: false, markAsRead: false });

      expect(gateway.loadChatMessages).not.toHaveBeenCalled();
      expect(gateway.markChatSeen).not.toHaveBeenCalled();
    });

    it('still loads full history when the chat only has shallow preview messages', () => {
      (service as unknown as { messagesSubject: { next(value: WhatsappMessage[]): void } }).messagesSubject.next([
        {
          id: 'm1',
          contactJid: mockContact.jid,
          text: 'primeira',
          sentAt: '2024-01-01T00:00:00.000Z',
          isFromMe: false,
          source: 'ws'
        },
        {
          id: 'm2',
          contactJid: mockContact.jid,
          text: 'segunda',
          sentAt: '2024-01-01T00:01:00.000Z',
          isFromMe: false,
          source: 'ws'
        }
      ]);

      service.selectContact(mockContact.jid);

      expect(gateway.loadChatMessages).toHaveBeenCalledWith(mockInstance.name, mockContact.jid, 180, true);
    });
  });

  describe('media preview normalization', () => {
    it('drops data URL text when mapping media events', () => {
      const mapped = (service as any).mapEventsToMessages([
        {
          id: 'evt-1',
          source: 'history',
          receivedAt: '2024-01-01T00:00:00.000Z',
          isFromMe: false,
          chatJid: mockContact.jid,
          phone: mockContact.phone,
          text: 'data:image/png;base64,abc',
          payload: {
            hasMedia: true,
            mediaMimetype: 'image/png'
          }
        }
      ]);

      expect(mapped.length).toBe(1);
      expect(mapped[0].text).toBe('');
    });

    it('converts raw JPEG base64 text into mediaDataUrl and hides text', () => {
      const rawJpegBase64 = '/9j/' + 'A'.repeat(320);
      const mapped = (service as any).mapEventsToMessages([
        {
          id: 'evt-raw-1',
          source: 'history',
          receivedAt: '2024-01-01T00:00:00.000Z',
          isFromMe: false,
          chatJid: mockContact.jid,
          phone: mockContact.phone,
          text: rawJpegBase64,
          payload: {
            hasMedia: true,
            mediaMimetype: 'image/jpeg'
          }
        }
      ]);

      expect(mapped.length).toBe(1);
      expect(mapped[0].text).toBe('');
      expect(String(mapped[0].payload?.['mediaDataUrl'] || '')).toContain('data:image/jpeg;base64,/9j/');
    });

    it('uses media placeholder in contact preview when message has media and no text', () => {
      (service as any).contactsSubject.next([{ ...mockContact, lastMessagePreview: '' }]);

      (service as any).resortContactsByLatestMessage([
        {
          id: 'msg-media',
          contactJid: mockContact.jid,
          text: '',
          sentAt: '2024-01-01T00:00:00.000Z',
          isFromMe: false,
          source: 'history',
          payload: {
            type: 'image',
            hasMedia: true,
            mediaMimetype: 'image/jpeg'
          }
        }
      ]);

      const updated = (service as any).contactsSubject.value as WhatsappContact[];
      expect(updated[0].lastMessagePreview).toBe('Foto');
      expect(updated[0].lastMessageType).toBe('image');
      expect(updated[0].lastMessageHasMedia).toBeTrue();
      expect(updated[0].lastMessageMediaMimetype).toBe('image/jpeg');
    });

    it('uses a placeholder in contact preview when history message is a location without text', () => {
      (service as any).contactsSubject.next([{ ...mockContact, lastMessagePreview: '' }]);

      (service as any).resortContactsByLatestMessage([
        {
          id: 'msg-location',
          contactJid: mockContact.jid,
          text: '',
          sentAt: '2024-01-01T00:00:00.000Z',
          isFromMe: false,
          source: 'history',
          payload: {
            type: 'location'
          }
        }
      ]);

      const updated = (service as any).contactsSubject.value as WhatsappContact[];
      expect(updated[0].lastMessagePreview).toBe('Localização');
    });
  });

  describe('requestPhoto', () => {
    it('retries photo fetch after previous null result cooldown expires', fakeAsync(() => {
      (service as unknown as { contactsSubject: { next(value: WhatsappContact[]): void } }).contactsSubject.next([
        { ...mockContact, photoUrl: null }
      ]);
      (service as unknown as { photoRetryUntil: Map<string, number> }).photoRetryUntil.set(mockContact.jid, Date.now() - 1);

      gateway.loadContactPhoto.calls.reset();

      service.requestPhoto(mockContact.jid);
      tick(151);

      expect(gateway.loadContactPhoto).toHaveBeenCalledWith(mockContact.jid);
    }));

    it('skips photo fetch when contact already has a photoUrl string', fakeAsync(() => {
      (service as unknown as { contactsSubject: { next(value: WhatsappContact[]): void } }).contactsSubject.next([
        { ...mockContact, photoUrl: 'data:image/jpeg;base64,abc' }
      ]);

      gateway.loadContactPhoto.calls.reset();

      service.requestPhoto(mockContact.jid);
      tick(151);

      expect(gateway.loadContactPhoto).not.toHaveBeenCalled();
    }));
  });

  describe('requestConversationContext', () => {
    beforeEach(() => {
      (service as unknown as { selectedInstanceSubject: { next(value: string): void } }).selectedInstanceSubject.next(mockInstance.name);
      (service as unknown as { contactsSubject: { next(value: WhatsappContact[]): void } }).contactsSubject.next([mockContact]);
      gateway.loadChatMessages.calls.reset();
    });

    it('loads a shallow 10-message context for visible contacts', fakeAsync(() => {
      service.requestConversationContext(mockContact.jid);
      tick(151);

      expect(gateway.loadChatMessages).toHaveBeenCalledWith(mockInstance.name, mockContact.jid, 10, false);
    }));

    it('loads enough preview history to cover unread messages', fakeAsync(() => {
      (service as unknown as { contactsSubject: { next(value: WhatsappContact[]): void } }).contactsSubject.next([
        { ...mockContact, unreadCount: 150 }
      ]);

      service.requestConversationContext(mockContact.jid);
      tick(151);

      expect(gateway.loadChatMessages).toHaveBeenCalledWith(mockInstance.name, mockContact.jid, 150, false);
    }));

    it('does not refetch the same warmed context twice after loading preview history', fakeAsync(() => {
      gateway.loadChatMessages.and.returnValue(of([
        {
          id: 'evt-preview-1',
          source: 'webjs-chat-history',
          receivedAt: '2024-01-01T00:00:00.000Z',
          isFromMe: false,
          chatJid: mockContact.jid,
          phone: mockContact.phone,
          text: 'preview',
          payload: {}
        }
      ]));

      service.requestConversationContext(mockContact.jid);
      tick(151);

      gateway.loadChatMessages.calls.reset();

      service.requestConversationContext(mockContact.jid);
      tick(151);

      expect(gateway.loadChatMessages).not.toHaveBeenCalled();
    }));

    it('does not mark shallow warmed context as fully loaded', fakeAsync(() => {
      gateway.loadChatMessages.and.returnValues(of([]), of([]));

      service.requestConversationContext(mockContact.jid);
      tick(151);

      service.selectContact(mockContact.jid);
      tick();

      expect(gateway.loadChatMessages.calls.allArgs()).toEqual([
        [mockInstance.name, mockContact.jid, 10, false],
        [mockInstance.name, mockContact.jid, 180, true]
      ]);
    }));
  });
});
