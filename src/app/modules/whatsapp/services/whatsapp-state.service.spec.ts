import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { WhatsappStateService } from './whatsapp-state.service';
import { WhatsappWebjsGatewayService } from '../../../services/whatsapp-webjs-gateway.service';
import { WhatsappContact, WhatsappInstance, WhatsappMessage } from '../../../models/whatsapp.model';

const mockInstance: WhatsappInstance = { name: 'inst1', token: 'tok', connected: true, jid: 'jid', webhook: '' };
const mockContact: WhatsappContact = { jid: 'c1@s.whatsapp.net', phone: '5511', name: 'Alice', found: true };

function makeGatewayStub(): jasmine.SpyObj<WhatsappWebjsGatewayService> {
  return jasmine.createSpyObj<WhatsappWebjsGatewayService>('WhatsappWebjsGatewayService', [
    'loadInstances',
    'loadContacts',
    'loadContactPhoto',
    'loadEvents',
    'loadChatMessages',
    'sendMessage',
    'sendMedia',
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

    TestBed.configureTestingModule({
      providers: [
        WhatsappStateService,
        { provide: WhatsappWebjsGatewayService, useValue: stub }
      ]
    });

    service = TestBed.inject(WhatsappStateService);
    gateway = TestBed.inject(WhatsappWebjsGatewayService) as jasmine.SpyObj<WhatsappWebjsGatewayService>;
  });

  afterEach(() => service.ngOnDestroy());

  // ─── getContact ────────────────────────────────────────────────────────────

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
      service.setDraftText('Olá mundo');
      expect(draft).toBe('Olá mundo');
    });
  });

  describe('setDraftImageDataUrl', () => {
    it('emits dataUrl', () => {
      let url: string | null = '';
      service.draftImageDataUrl$.subscribe(u => (url = u));
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
});
