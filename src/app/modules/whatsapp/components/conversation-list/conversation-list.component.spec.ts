import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { WhatsappContact } from '../../../../models/whatsapp.model';
import { WhatsappStateService } from '../../services/whatsapp-state.service';
import { ConversationListComponent } from './conversation-list.component';

const makeContact = (jid: string, name = 'User', unread = 0): WhatsappContact => ({
  jid, phone: jid.replace('@c.us', ''), name, found: true, unreadCount: unread
});

describe('ConversationListComponent', () => {
  let fixture: ComponentFixture<ConversationListComponent>;
  let component: ConversationListComponent;
  let contacts$: BehaviorSubject<WhatsappContact[]>;
  let selectedJid$: BehaviorSubject<string>;
  let loadingState$: BehaviorSubject<any>;
  let syncing$: BehaviorSubject<boolean>;
  let selectionMode$: BehaviorSubject<boolean>;
  let selectedJids$: BehaviorSubject<Set<string>>;
  let stateSpy: jasmine.SpyObj<WhatsappStateService>;

  beforeEach(async () => {
    contacts$ = new BehaviorSubject<WhatsappContact[]>([]);
    selectedJid$ = new BehaviorSubject<string>('');
    loadingState$ = new BehaviorSubject({ instances: false, contacts: false, messages: false, sending: false });
    syncing$ = new BehaviorSubject<boolean>(false);
    selectionMode$ = new BehaviorSubject<boolean>(false);
    selectedJids$ = new BehaviorSubject<Set<string>>(new Set());

    stateSpy = jasmine.createSpyObj('WhatsappStateService', [
      'selectContact', 'selectAll', 'exitSelectionMode', 'toggleContactSelection', 'requestPhoto'
    ], {
      contacts$: contacts$.asObservable(),
      selectedContactJid$: selectedJid$.asObservable(),
      loadingState$: loadingState$.asObservable(),
      syncing$: syncing$.asObservable(),
      selectionMode$: selectionMode$.asObservable(),
      selectedJids$: selectedJids$.asObservable()
    });

    await TestBed.configureTestingModule({
      declarations: [ConversationListComponent],
      providers: [
        { provide: WhatsappStateService, useValue: stateSpy }
      ],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(ConversationListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  it('starts with empty contacts', () => {
    expect(component.contacts).toEqual([]);
  });

  it('updates contacts when service emits', () => {
    const list = [makeContact('a@c.us', 'Ana')];
    contacts$.next(list);
    expect(component.contacts).toEqual(list);
  });

  it('requests photos for visible non-group contacts', () => {
    const list = [
      makeContact('a@c.us', 'Ana'),
      makeContact('b@c.us', 'Bia'),
      { ...makeContact('g@g.us', 'Grupo'), isGroup: true }
    ];

    contacts$.next(list);
    fixture.detectChanges();

    const container = fixture.nativeElement.querySelector('.list-scroll') as HTMLDivElement;
    const firstItem = fixture.nativeElement.querySelector('.conversation-item') as HTMLButtonElement;
    Object.defineProperty(container, 'clientHeight', { value: 160, configurable: true });
    Object.defineProperty(container, 'scrollTop', { value: 0, configurable: true });
    Object.defineProperty(firstItem, 'offsetHeight', { value: 80, configurable: true });

    (component as any).requestVisiblePhotos();

    expect(stateSpy.requestPhoto).toHaveBeenCalledWith('a@c.us');
    expect(stateSpy.requestPhoto).toHaveBeenCalledWith('b@c.us');
    expect(stateSpy.requestPhoto).not.toHaveBeenCalledWith('g@g.us');
  });

  it('tracks loading state', () => {
    loadingState$.next({ instances: false, contacts: true, messages: false, sending: false });
    expect(component.isLoading).toBeTrue();
  });

  it('tracks syncing state', () => {
    syncing$.next(true);
    expect(component.isSyncing).toBeTrue();
  });

  it('tracks selection mode', () => {
    selectionMode$.next(true);
    expect(component.isSelectionMode).toBeTrue();
  });

  it('formats data URL preview as media label', () => {
    const contact: WhatsappContact = {
      ...makeContact('a@c.us', 'Ana'),
      lastMessagePreview: 'data:image/png;base64,abc'
    };

    expect(component.formatLastMessagePreview(contact)).toBe('Foto');
  });

  it('formats raw JPEG base64 preview as media label', () => {
    const contact: WhatsappContact = {
      ...makeContact('a@c.us', 'Ana'),
      lastMessagePreview: '/9j/' + 'A'.repeat(320)
    };

    expect(component.formatLastMessagePreview(contact)).toBe('Foto');
  });

  it('returns image icon for image media preview', () => {
    const contact: WhatsappContact = {
      ...makeContact('a@c.us', 'Ana'),
      lastMessagePreview: 'Foto',
      lastMessageType: 'image',
      lastMessageHasMedia: true,
      lastMessageMediaMimetype: 'image/jpeg'
    };

    expect(component.getPreviewMediaIcon(contact)).toBe('image');
  });

  it('does not return media icon for plain text preview', () => {
    const contact: WhatsappContact = {
      ...makeContact('a@c.us', 'Ana'),
      lastMessagePreview: 'Oi, tudo bem?'
    };

    expect(component.getPreviewMediaIcon(contact)).toBe('');
  });

  it('isFlashing returns false for non-flashing jid', () => {
    expect(component.isFlashing('unknown@c.us')).toBeFalse();
  });

  describe('applyFilter / filteredContacts', () => {
    beforeEach(() => {
      contacts$.next([
        makeContact('a@c.us', 'Ana', 2),
        makeContact('b@c.us', 'Bob', 0),
        makeContact('c@c.us', 'Carlos', 1)
      ]);
    });

    it('all filter shows all contacts', () => {
      component.activeFilter = 'all';
      component.searchTerm = '';
      (component as any).applyFilter();
      expect(component.filteredContacts.length).toBe(3);
    });

    it('unread filter shows only unread contacts', () => {
      component.activeFilter = 'unread';
      component.searchTerm = '';
      (component as any).applyFilter();
      expect(component.filteredContacts.every(c => (c.unreadCount ?? 0) > 0)).toBeTrue();
    });

    it('search by name filters correctly', () => {
      component.activeFilter = 'all';
      component.searchTerm = 'ana';
      (component as any).applyFilter();
      expect(component.filteredContacts.length).toBe(1);
      expect(component.filteredContacts[0].name).toBe('Ana');
    });

    it('search is case-insensitive', () => {
      component.activeFilter = 'all';
      component.searchTerm = 'CARLOS';
      (component as any).applyFilter();
      expect(component.filteredContacts.some(c => c.name === 'Carlos')).toBeTrue();
    });
  });
});
