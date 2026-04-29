import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { AppLabel } from '../../../../models/app-label.model';
import { WhatsappContact, WhatsappLabel } from '../../../../models/whatsapp.model';
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
    localStorage.removeItem('appLabels');
    localStorage.removeItem('appLabelAssignments');

    contacts$ = new BehaviorSubject<WhatsappContact[]>([]);
    selectedJid$ = new BehaviorSubject<string>('');
    loadingState$ = new BehaviorSubject({ instances: false, contacts: false, messages: false, sending: false });
    syncing$ = new BehaviorSubject<boolean>(false);
    selectionMode$ = new BehaviorSubject<boolean>(false);
    selectedJids$ = new BehaviorSubject<Set<string>>(new Set());

    stateSpy = jasmine.createSpyObj('WhatsappStateService', [
      'selectContact', 'selectAll', 'exitSelectionMode', 'toggleContactSelection', 'requestPhoto', 'requestConversationContext'
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

  it('requests photos for visible contacts, including groups', () => {
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
    expect(stateSpy.requestPhoto).toHaveBeenCalledWith('g@g.us');
    expect(stateSpy.requestConversationContext).toHaveBeenCalledWith('a@c.us');
    expect(stateSpy.requestConversationContext).toHaveBeenCalledWith('b@c.us');
    expect(stateSpy.requestConversationContext).toHaveBeenCalledWith('g@g.us');
  });

  it('tracks loading state', () => {
    loadingState$.next({ instances: false, contacts: true, messages: false, sending: false });
    expect(component.isLoading).toBeTrue();
  });

  it('tracks syncing state', () => {
    syncing$.next(true);
    expect(component.isSyncing).toBeTrue();
  });

  it('does not show the synced label when syncing is idle', () => {
    syncing$.next(false);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('Sincronizado agora');
  });

  it('shows the syncing label only while syncing is active', () => {
    syncing$.next(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Sincronizando conversas...');
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

  it('formats the conversation jid when the phone field conflicts with it', () => {
    const contact: WhatsappContact = {
      ...makeContact('5511987654321@c.us', 'Ana'),
      phone: '5511912345678'
    };

    expect(component.formatPhone(contact)).toBe('+55 (11) 98765-4321');
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

  it('clears the flash shortly after a conversation moves up', fakeAsync(() => {
    const first = makeContact('a@c.us', 'Ana');
    const second = makeContact('b@c.us', 'Bia');

    (component as any).detectAndFlashMoved([first, second]);
    (component as any).detectAndFlashMoved([second, first]);

    expect(component.isFlashing('b@c.us')).toBeTrue();

    tick(649);
    expect(component.isFlashing('b@c.us')).toBeTrue();

    tick(1);
    expect(component.isFlashing('b@c.us')).toBeFalse();
  }));

  it('does not flash the currently active conversation row', () => {
    selectedJid$.next('b@c.us');
    component.flashingJids = new Set(['b@c.us']);

    expect(component.isFlashing('b@c.us')).toBeFalse();
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

  it('separates base filters from label filters for the dropdown menu', () => {
    component.whatsappLabels = [{ id: 'wa-vip', name: 'VIP Externo', hexColor: '#25D366' } as WhatsappLabel];
    component.appLabels = [{ id: 'vip', name: 'VIP', color: '#ef4444', createdAt: '2026-04-24T00:00:00.000Z' } as AppLabel];

    (component as any).rebuildFilterChips();

    expect(component.baseFilterChips.map(chip => chip.id)).toEqual(['all', 'conversations', 'unread']);
    expect(component.labelFilterChips.map(chip => chip.label)).toEqual(['VIP', 'VIP Externo']);
  });

  it('links contacts to WhatsApp labels by id or by name and filters correctly', () => {
    component.whatsappLabels = [{ id: 'lab-1', name: 'Cliente quente', hexColor: '#16a34a' } as WhatsappLabel];

    contacts$.next([
      { ...makeContact('a@c.us', 'Ana'), labels: ['lab-1'] },
      { ...makeContact('b@c.us', 'Bia'), labels: ['Cliente quente'] },
      { ...makeContact('c@c.us', 'Carlos'), labels: ['Outro'] }
    ]);

    const anaLabels = component.getWhatsappLabelsForContact(component.contacts[0]);
    const biaLabels = component.getWhatsappLabelsForContact(component.contacts[1]);

    expect(anaLabels.length).toBe(1);
    expect(biaLabels.length).toBe(1);
    expect(anaLabels[0].name).toBe('Cliente quente');
    expect(biaLabels[0].name).toBe('Cliente quente');

    component.activeFilter = `label:${encodeURIComponent(anaLabels[0].key)}` as any;
    (component as any).applyFilter();

    expect(component.filteredContacts.map(contact => contact.jid)).toEqual(['a@c.us', 'b@c.us']);
  });

  it('preserves the active WhatsApp label filter when the catalog upgrades a fallback name key to an id key', () => {
    contacts$.next([
      { ...makeContact('a@c.us', 'Ana'), labels: ['Cliente quente'] },
      { ...makeContact('b@c.us', 'Bia'), labels: ['Outro'] }
    ]);

    const fallbackLabel = component.getWhatsappLabelsForContact(component.contacts[0])[0];
    component.activeFilter = `label:${encodeURIComponent(fallbackLabel.key)}` as any;

    component.whatsappLabels = [{ id: 'lab-1', name: 'Cliente quente', hexColor: '#16a34a' } as WhatsappLabel];

    expect(component.activeFilter).toBe(`label:${encodeURIComponent('id:lab-1')}` as any);
    expect(component.filteredContacts.map(contact => contact.jid)).toEqual(['a@c.us']);
  });

  it('filters contacts using chat membership returned by the labels endpoint even when contact.labels is empty', () => {
    contacts$.next([
      { ...makeContact('a@c.us', 'Ana'), labels: [] },
      { ...makeContact('b@c.us', 'Bia'), labels: [] }
    ]);

    component.whatsappLabels = [{
      id: 'lab-1',
      name: 'Cliente quente',
      hexColor: '#16a34a',
      chatJids: ['a@c.us']
    } as WhatsappLabel];

    const filterChip = component.labelFilterChips.find(chip => chip.label === 'Cliente quente');
    expect(filterChip).toBeTruthy();

    component.activeFilter = filterChip!.id as any;
    (component as any).applyFilter();

    expect(component.filteredContacts.map(contact => contact.jid)).toEqual(['a@c.us']);
  });
});
