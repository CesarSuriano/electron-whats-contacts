import { AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, HostListener, Input, OnDestroy, OnInit, Output, ViewChild } from '@angular/core';
import { Subject, combineLatest } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { AppLabel, AppLabelAssignments } from '../../../../models/app-label.model';
import { MessageAck, WhatsappContact, WhatsappLabel } from '../../../../models/whatsapp.model';
import { LabelService } from '../../../../services/label.service';
import { ManagerLaunchService } from '../../../../services/manager-launch.service';
import { formatBrazilianPhone, resolveDisplayedPhoneSource } from '../../helpers/phone-format.helper';
import { WhatsappStateService } from '../../services/whatsapp-state.service';

type ConversationFilterId = 'all' | 'conversations' | 'unread' | `label:${string}` | `app-label:${string}`;

interface ConversationFilterChip {
  id: ConversationFilterId;
  label: string;
  color?: string;
}

interface ConversationWhatsappLabel {
  key: string;
  id: string;
  name: string;
  color: string;
  chatJids: string[];
}

const MOVE_FLASH_DURATION_MS = 650;
const PHOTO_VISIBLE_OVERSCAN = 6;
const PHOTO_FALLBACK_ITEM_HEIGHT = 76;

@Component({
  selector: 'app-conversation-list',
  templateUrl: './conversation-list.component.html',
  styleUrls: ['./conversation-list.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ConversationListComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input() disabled = false;
  @Input()
  set whatsappLabels(value: WhatsappLabel[] | null | undefined) {
    this.sourceWhatsappLabels = Array.isArray(value) ? value : [];
    this.refreshLabelFilters();
    this.applyFilter();
    this.cdr.markForCheck();
  }
  @Output() scheduleMessage = new EventEmitter<WhatsappContact>();
  @Output() filteredContactsChange = new EventEmitter<WhatsappContact[]>();
  @ViewChild('scrollContainer')
  set scrollContainerRef(value: ElementRef<HTMLDivElement> | undefined) {
    this.scrollContainer = value;
    this.scheduleVisiblePhotoPrefetch();
  }

  contacts: WhatsappContact[] = [];
  filteredContacts: WhatsappContact[] = [];
  selectedJid = '';
  searchTerm = '';
  activeFilter: ConversationFilterId = 'all';
  whatsappLabelFilters: ConversationWhatsappLabel[] = [];
  filterChipsCached: ConversationFilterChip[] = [];
  appLabels: AppLabel[] = [];
  appLabelAssignments: AppLabelAssignments = {};
  isLoading = false;
  isSyncing = false;
  isSelectionMode = false;
  isLabelMenuOpen = false;
  selectedJids = new Set<string>();
  flashingJids = new Set<string>();
  contextMenuVisible = false;
  contextMenuX = 0;
  contextMenuY = 0;
  contextMenuContact: WhatsappContact | null = null;
  private sourceWhatsappLabels: WhatsappLabel[] = [];
  private whatsappLabelsById = new Map<string, ConversationWhatsappLabel>();
  private whatsappLabelsByName = new Map<string, ConversationWhatsappLabel>();
  private whatsappLabelsByContact = new Map<string, ConversationWhatsappLabel[]>();
  private appLabelsById = new Map<string, AppLabel>();
  private appLabelsByContact = new Map<string, AppLabel[]>();
  private static readonly EMPTY_LABELS: AppLabel[] = [];
  private static readonly EMPTY_WHATSAPP_LABELS: ConversationWhatsappLabel[] = [];

  private readonly destroy$ = new Subject<void>();
  private prevOrderMap = new Map<string, number>();
  private scrollContainer?: ElementRef<HTMLDivElement>;
  private visiblePhotoTimer: number | null = null;

  constructor(
    private state: WhatsappStateService,
    private labelService: LabelService,
    private managerLaunch: ManagerLaunchService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.rebuildFilterChips();

    combineLatest([this.state.contacts$, this.state.selectedContactJid$])
      .pipe(takeUntil(this.destroy$))
      .subscribe(([contacts, jid]) => {
        this.detectAndFlashMoved(contacts);
        this.contacts = contacts;
        this.selectedJid = jid;
        this.refreshLabelFilters();
        this.applyFilter();
        this.scheduleVisiblePhotoPrefetch();
        this.cdr.markForCheck();
      });

    this.state.loadingState$
      .pipe(takeUntil(this.destroy$))
      .subscribe(state => {
        this.isLoading = state.contacts;
        this.cdr.markForCheck();
      });

    this.state.syncing$
      .pipe(takeUntil(this.destroy$))
      .subscribe(syncing => {
        this.isSyncing = syncing;
        this.cdr.markForCheck();
      });

    this.state.selectionMode$
      .pipe(takeUntil(this.destroy$))
      .subscribe(mode => {
        this.isSelectionMode = mode;
        this.cdr.markForCheck();
      });

    this.state.selectedJids$
      .pipe(takeUntil(this.destroy$))
      .subscribe(jids => {
        this.selectedJids = jids;
        this.cdr.markForCheck();
      });

    this.labelService.state$
      .pipe(takeUntil(this.destroy$))
      .subscribe(({ labels, assignments }) => {
        this.appLabels = labels;
        this.appLabelAssignments = assignments;
        this.appLabelsById = new Map(labels.map(label => [label.id, label]));
        this.rebuildFilterChips();
        this.applyFilter();
        this.cdr.markForCheck();
      });
  }

  ngAfterViewInit(): void {
    this.scheduleVisiblePhotoPrefetch();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.visiblePhotoTimer !== null) {
      window.clearTimeout(this.visiblePhotoTimer);
    }
  }

  onScroll(): void {
    this.scheduleVisiblePhotoPrefetch();
  }

  isFlashing(jid: string): boolean {
    if (!jid) {
      return false;
    }

    if (!this.isSelectionMode && jid === this.selectedJid) {
      return false;
    }

    if (this.isSelectionMode && this.selectedJids.has(jid)) {
      return false;
    }

    return this.flashingJids.has(jid);
  }

  private detectAndFlashMoved(newContacts: WhatsappContact[]): void {
    const movedUp: string[] = [];
    newContacts.forEach((contact, newIndex) => {
      const prevIndex = this.prevOrderMap.get(contact.jid);
      if (prevIndex !== undefined && newIndex < prevIndex) {
        movedUp.push(contact.jid);
      }
    });

    if (movedUp.length) {
      this.flashingJids = new Set([...this.flashingJids, ...movedUp]);
      window.setTimeout(() => {
        this.flashingJids = new Set([...this.flashingJids].filter(j => !movedUp.includes(j)));
        this.cdr.markForCheck();
      }, MOVE_FLASH_DURATION_MS);
    }

    this.prevOrderMap.clear();
    newContacts.forEach((contact, index) => {
      this.prevOrderMap.set(contact.jid, index);
    });
  }

  onSearchChange(value: string): void {
    if (this.disabled) {
      return;
    }
    this.searchTerm = value;
    this.applyFilter();
  }

  onFilterChange(filterId: ConversationFilterId): void {
    if (this.disabled) {
      return;
    }

    this.activeFilter = filterId;
    this.isLabelMenuOpen = false;
    this.applyFilter();
  }

  toggleLabelMenu(event: Event): void {
    event.stopPropagation();
    if (this.disabled) {
      return;
    }

    this.isLabelMenuOpen = !this.isLabelMenuOpen;
  }

  onLabelMenuFilterSelect(filterId: ConversationFilterId, event: Event): void {
    event.stopPropagation();
    if (this.disabled) {
      return;
    }

    this.activeFilter = this.activeFilter === filterId ? 'all' : filterId;
    this.isLabelMenuOpen = false;
    this.applyFilter();
  }

  openLabelManagerFromMenu(event: Event): void {
    event.stopPropagation();
    this.isLabelMenuOpen = false;
    this.openLabelManager();
  }

  onAppLabelChipClick(label: AppLabel, event: Event): void {
    event.stopPropagation();
    if (this.disabled || this.isSelectionMode) {
      return;
    }

    const filterId = this.toAppLabelFilterId(label.id);
    this.activeFilter = this.activeFilter === filterId ? 'all' : filterId;
    this.applyFilter();
  }

  isAppLabelFilterActive(labelId: string): boolean {
    return this.activeFilter === this.toAppLabelFilterId(labelId);
  }

  onWhatsappLabelChipClick(label: ConversationWhatsappLabel, event: Event): void {
    event.stopPropagation();
    if (this.disabled || this.isSelectionMode) {
      return;
    }

    const filterId = this.toWhatsappLabelFilterId(label.key);
    this.activeFilter = this.activeFilter === filterId ? 'all' : filterId;
    this.applyFilter();
  }

  isWhatsappLabelFilterActive(label: ConversationWhatsappLabel): boolean {
    return this.activeFilter === this.toWhatsappLabelFilterId(label.key);
  }

  onContactClick(contact: WhatsappContact): void {
    if (this.disabled) {
      return;
    }

    if (this.isSelectionMode) {
      this.state.toggleContactSelection(contact.jid);
      return;
    }
    this.state.selectContact(contact.jid);
  }

  enterSelectionMode(contact?: WhatsappContact): void {
    if (this.disabled) {
      return;
    }

    this.state.enterSelectionMode();
    if (contact) {
      this.state.toggleContactSelection(contact.jid);
    }
  }

  formatPhone(contact: WhatsappContact): string {
    return formatBrazilianPhone(this.resolvePhoneSource(contact));
  }

  formatLastMessagePreview(contact: WhatsappContact): string {
    const text = (contact.lastMessagePreview || '').trim();
    if (text) {
      if (this.isDataUrlPreview(text)) {
        return this.resolveDataUrlPreviewLabel(text);
      }
      if (this.looksLikeRawImageBase64(text)) {
        return 'Foto';
      }
      return text;
    }

    return this.formatPhone(contact);
  }

  private resolvePhoneSource(contact: WhatsappContact): string {
    return resolveDisplayedPhoneSource(contact);
  }

  getPreviewMediaIcon(contact: WhatsappContact): string {
    const kind = this.resolvePreviewMediaKind(contact);
    switch (kind) {
      case 'image':    return 'image';
      case 'video':    return 'videocam';
      case 'audio':    return 'mic';
      case 'sticker':  return 'sentiment_satisfied';
      case 'document': return 'description';
      default:         return '';
    }
  }

  formatLastMessageTime(contact: WhatsappContact): string {
    if (!contact.lastMessageAt) {
      return '';
    }

    const date = new Date(contact.lastMessageAt);
    if (Number.isNaN(date.getTime())) {
      return '';
    }

    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) {
      return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return 'Ontem';
    }

    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }

  get filterChips(): ConversationFilterChip[] {
    return this.filterChipsCached;
  }

  get baseFilterChips(): ConversationFilterChip[] {
    return this.filterChipsCached.filter(chip => !this.isLabelFilterChip(chip));
  }

  get labelFilterChips(): ConversationFilterChip[] {
    return this.filterChipsCached.filter(chip => this.isLabelFilterChip(chip));
  }

  get activeLabelFilterChip(): ConversationFilterChip | null {
    return this.labelFilterChips.find(chip => chip.id === this.activeFilter) || null;
  }

  get labelMenuButtonText(): string {
    return this.activeLabelFilterChip?.label || 'Etiquetas';
  }

  getUnreadCount(contact: WhatsappContact): number {
    return Math.max(0, Number(contact.unreadCount || 0));
  }

  getPreviewAckIcon(contact: WhatsappContact): string {
    if (!contact.lastMessageFromMe) return '';
    const ack = contact.lastMessageAck;
    if (ack === null || ack === undefined) return 'done';
    if (ack <= MessageAck.PENDING) return 'schedule';
    if (ack === MessageAck.SERVER) return 'done';
    if (ack === MessageAck.DEVICE) return 'done_all';
    return 'done_all'; // READ or PLAYED
  }

  isPreviewAckRead(contact: WhatsappContact): boolean {
    if (!contact.lastMessageFromMe) return false;
    const ack = contact.lastMessageAck;
    return ack !== null && ack !== undefined && ack >= MessageAck.READ;
  }

  trackByJid(_: number, contact: WhatsappContact): string {
    return contact.jid;
  }

  onContextMenu(event: MouseEvent, contact: WhatsappContact): void {
    if (this.disabled || this.isSelectionMode) return;
    event.preventDefault();
    this.contextMenuContact = contact;
    this.contextMenuX = event.clientX;
    this.contextMenuY = event.clientY;
    this.contextMenuVisible = true;
  }

  onContextSchedule(): void {
    if (this.contextMenuContact) {
      this.scheduleMessage.emit(this.contextMenuContact);
    }
    this.closeContextMenu();
  }

  openLabelManager(): void {
    this.managerLaunch.openLabelManager();
  }

  onContextManageLabels(): void {
    this.managerLaunch.openLabelManager();
    this.closeContextMenu();
  }

  getAppLabelsForContact(contact: WhatsappContact): AppLabel[] {
    return this.appLabelsByContact.get(contact.jid) || ConversationListComponent.EMPTY_LABELS;
  }

  getWhatsappLabelsForContact(contact: WhatsappContact): ConversationWhatsappLabel[] {
    return this.whatsappLabelsByContact.get(this.normalizeWhatsappChatJid(contact.jid)) || ConversationListComponent.EMPTY_WHATSAPP_LABELS;
  }

  private resolveAppLabelsForContact(jid: string): AppLabel[] {
    const ids = this.appLabelAssignments[jid] || [];
    if (!ids.length || !this.appLabelsById.size) {
      return ConversationListComponent.EMPTY_LABELS;
    }
    const labels = ids
      .map(id => this.appLabelsById.get(id))
      .filter((label): label is AppLabel => Boolean(label));
    return labels.length ? labels : ConversationListComponent.EMPTY_LABELS;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;

    this.closeContextMenu();

    if (!this.isLabelMenuOpen) {
      return;
    }

    if (target && (target.closest('[data-label-menu-anchor]') || target.closest('[data-label-menu]'))) {
      return;
    }

    this.isLabelMenuOpen = false;
  }

  closeContextMenu(): void {
    this.contextMenuVisible = false;
    this.contextMenuContact = null;
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeContextMenu();
    this.isLabelMenuOpen = false;
  }

  private applyFilter(): void {
    this.rebuildAppLabelCache();

    const term = this.searchTerm.trim().toLowerCase();
    const activeWhatsappLabelKey = this.getActiveWhatsappLabelKey();
    const activeAppLabelId = this.getActiveAppLabelId();

    this.filteredContacts = this.contacts.filter(contact => {
      const unreadCount = this.getUnreadCount(contact);

      if (this.activeFilter === 'unread' && unreadCount <= 0) {
        return false;
      }

      if (this.activeFilter === 'conversations') {
        if (contact.isGroup || !contact.lastMessageAt) {
          return false;
        }
      }

      if (activeWhatsappLabelKey) {
        const whatsappLabels = this.getWhatsappLabelsForContact(contact);
        if (!whatsappLabels.some(label => label.key === activeWhatsappLabelKey)) {
          return false;
        }
      }

      if (activeAppLabelId) {
        const ids = this.appLabelAssignments[contact.jid] || [];
        if (!ids.includes(activeAppLabelId)) {
          return false;
        }
      }

      if (!term) {
        return true;
      }

      const digits = term.replace(/\D/g, '');
      const name = (contact.name || '').toLowerCase();
      const phone = contact.phone || '';
      const preview = this.formatLastMessagePreview(contact).toLowerCase();
      const labelsJoined = this.getWhatsappLabelsForContact(contact).map(label => label.name).join(' ').toLowerCase();
      const appLabelsJoined = this.getAppLabelsForContact(contact).map(label => label.name).join(' ').toLowerCase();
      const rawLabelsJoined = (Array.isArray(contact.labels) ? contact.labels : []).join(' ').toLowerCase();

      if (name.includes(term) || preview.includes(term) || labelsJoined.includes(term) || rawLabelsJoined.includes(term) || appLabelsJoined.includes(term)) {
        return true;
      }

      return digits.length > 0 && phone.includes(digits);
    });

    this.filteredContactsChange.emit(this.filteredContacts);
    this.scheduleVisiblePhotoPrefetch();
  }

  private rebuildAppLabelCache(): void {
    const next = new Map<string, AppLabel[]>();
    for (const contact of this.contacts) {
      const labels = this.resolveAppLabelsForContact(contact.jid);
      if (labels.length) {
        next.set(contact.jid, labels);
      }
    }
    this.appLabelsByContact = next;
  }

  private scheduleVisiblePhotoPrefetch(): void {
    if (this.visiblePhotoTimer !== null) {
      window.clearTimeout(this.visiblePhotoTimer);
    }

    this.visiblePhotoTimer = window.setTimeout(() => {
      this.visiblePhotoTimer = null;
      this.requestVisiblePhotos();
    }, 0);
  }

  private requestVisiblePhotos(): void {
    const container = this.scrollContainer?.nativeElement;
    if (!container || !this.filteredContacts.length) {
      return;
    }

    const firstItem = container.querySelector('.conversation-item') as HTMLElement | null;
    const itemHeight = Math.max(firstItem?.offsetHeight || PHOTO_FALLBACK_ITEM_HEIGHT, 1);
    const visibleStart = Math.max(0, Math.floor(container.scrollTop / itemHeight));
    const visibleCount = Math.ceil(container.clientHeight / itemHeight) + PHOTO_VISIBLE_OVERSCAN;
    const visibleEnd = Math.min(this.filteredContacts.length, visibleStart + visibleCount);

    for (const contact of this.filteredContacts.slice(visibleStart, visibleEnd)) {
      this.state.requestPhoto(contact.jid);
      this.state.requestConversationContext(contact.jid);
    }
  }

  private refreshLabelFilters(): void {
    this.whatsappLabelsById.clear();
    this.whatsappLabelsByName.clear();
    const labelsByContact = new Map<string, Map<string, ConversationWhatsappLabel>>();
    const addLabelToContact = (chatJidRaw: unknown, label: ConversationWhatsappLabel): void => {
      const chatJid = this.normalizeWhatsappChatJid(chatJidRaw);
      if (!chatJid) {
        return;
      }

      const currentLabels = labelsByContact.get(chatJid) || new Map<string, ConversationWhatsappLabel>();
      currentLabels.set(label.key, label);
      labelsByContact.set(chatJid, currentLabels);
    };

    this.sourceWhatsappLabels.forEach(label => {
      const parsed = this.createWhatsappLabel(label.id, label.name, label.hexColor);
      if (!parsed) {
        return;
      }

      if (parsed.id) {
        this.whatsappLabelsById.set(this.normalizeWhatsappLabelToken(parsed.id), parsed);
      }
      this.whatsappLabelsByName.set(this.normalizeWhatsappLabelToken(parsed.name), parsed);
      (label.chatJids || []).forEach(chatJid => {
        addLabelToContact(chatJid, parsed);
      });
    });

    const menuLabels = new Map<string, ConversationWhatsappLabel>();

    this.whatsappLabelsByName.forEach(label => {
      menuLabels.set(label.key, label);
    });

    this.contacts.forEach(contact => {
      const labels = this.resolveContactWhatsappLabels(contact);
      const chatJid = this.normalizeWhatsappChatJid(contact.jid);
      const currentLabels = labelsByContact.get(chatJid) || new Map<string, ConversationWhatsappLabel>();

      labels.forEach(label => {
        currentLabels.set(label.key, label);
      });

      if (!currentLabels.size) {
        return;
      }

      labelsByContact.set(chatJid, currentLabels);
      currentLabels.forEach(label => {
        menuLabels.set(label.key, label);
      });
    });

    this.whatsappLabelsByContact = new Map(
      Array.from(labelsByContact.entries()).map(([chatJid, contactLabels]) => [
        chatJid,
        Array.from(contactLabels.values()).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
      ])
    );
    this.whatsappLabelFilters = Array.from(menuLabels.values()).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

    const activeLabelKey = this.getActiveWhatsappLabelKey();
    if (activeLabelKey) {
      const compatibleLabelKey = this.resolveCompatibleWhatsappLabelKey(activeLabelKey, menuLabels);
      if (!compatibleLabelKey) {
        this.activeFilter = 'all';
      } else if (compatibleLabelKey !== activeLabelKey) {
        this.activeFilter = this.toWhatsappLabelFilterId(compatibleLabelKey);
      }
    }

    this.rebuildFilterChips();
  }

  private rebuildFilterChips(): void {
    const base: ConversationFilterChip[] = [
      { id: 'all', label: 'Tudo' },
      { id: 'conversations', label: 'Conversas' },
      { id: 'unread', label: 'Não lidas' }
    ];

    const appLabelChips: ConversationFilterChip[] = this.appLabels
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
      .map(label => ({
        id: `app-label:${label.id}` as ConversationFilterId,
        label: label.name,
        color: label.color
      }));

    const labelChips: ConversationFilterChip[] = this.whatsappLabelFilters.map(label => ({
      id: this.toWhatsappLabelFilterId(label.key),
      label: label.name,
      color: label.color
    }));

    this.filterChipsCached = [...base, ...appLabelChips, ...labelChips];
  }

  private getActiveWhatsappLabelKey(): string {
    if (!this.activeFilter.startsWith('label:')) {
      return '';
    }

    return decodeURIComponent(this.activeFilter.slice('label:'.length));
  }

  private getActiveAppLabelId(): string {
    if (!this.activeFilter.startsWith('app-label:')) {
      return '';
    }
    return this.activeFilter.slice('app-label:'.length);
  }

  private toAppLabelFilterId(labelId: string): ConversationFilterId {
    return `app-label:${labelId}`;
  }

  private toWhatsappLabelFilterId(labelKey: string): ConversationFilterId {
    return `label:${encodeURIComponent(labelKey)}`;
  }

  private isLabelFilterChip(chip: ConversationFilterChip): boolean {
    return chip.id.startsWith('app-label:') || chip.id.startsWith('label:');
  }

  private resolveContactWhatsappLabels(contact: WhatsappContact): ConversationWhatsappLabel[] {
    const rawLabels = Array.isArray(contact.labels) ? contact.labels : [];
    if (!rawLabels.length) {
      return ConversationListComponent.EMPTY_WHATSAPP_LABELS;
    }

    const resolved = new Map<string, ConversationWhatsappLabel>();

    rawLabels.forEach(rawLabel => {
      const token = this.normalizeWhatsappLabelToken(rawLabel);
      if (!token) {
        return;
      }

      const fromCatalog = this.whatsappLabelsById.get(token) || this.whatsappLabelsByName.get(token);
      if (fromCatalog) {
        resolved.set(fromCatalog.key, fromCatalog);
        return;
      }

      const fallback = this.createWhatsappLabel('', rawLabel, undefined);
      if (fallback) {
        resolved.set(fallback.key, fallback);
      }
    });

    if (!resolved.size) {
      return ConversationListComponent.EMPTY_WHATSAPP_LABELS;
    }

    return Array.from(resolved.values()).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  private createWhatsappLabel(idRaw: unknown, nameRaw: unknown, colorRaw: unknown): ConversationWhatsappLabel | null {
    const id = String(idRaw || '').trim();
    const name = String(nameRaw || '').trim() || id;
    if (!name) {
      return null;
    }

    const normalizedId = this.normalizeWhatsappLabelToken(id);
    const normalizedName = this.normalizeWhatsappLabelToken(name);
    const key = normalizedId ? `id:${normalizedId}` : `name:${normalizedName}`;

    return {
      key,
      id,
      name,
      color: this.normalizeWhatsappLabelColor(colorRaw),
      chatJids: []
    };
  }

  private normalizeWhatsappChatJid(value: unknown): string {
    return String(value || '').trim().toLowerCase();
  }

  private normalizeWhatsappLabelToken(value: unknown): string {
    return String(value || '').trim().toLowerCase();
  }

  private resolveCompatibleWhatsappLabelKey(
    activeLabelKey: string,
    menuLabels: Map<string, ConversationWhatsappLabel>
  ): string {
    if (!activeLabelKey) {
      return '';
    }

    if (menuLabels.has(activeLabelKey)) {
      return activeLabelKey;
    }

    const [, rawToken = ''] = activeLabelKey.split(':', 2);
    const normalizedToken = this.normalizeWhatsappLabelToken(rawToken);
    if (!normalizedToken) {
      return '';
    }

    const fromCatalog = this.whatsappLabelsById.get(normalizedToken) || this.whatsappLabelsByName.get(normalizedToken);
    if (fromCatalog && menuLabels.has(fromCatalog.key)) {
      return fromCatalog.key;
    }

    for (const label of menuLabels.values()) {
      if (
        this.normalizeWhatsappLabelToken(label.id) === normalizedToken
        || this.normalizeWhatsappLabelToken(label.name) === normalizedToken
      ) {
        return label.key;
      }
    }

    return '';
  }

  private normalizeWhatsappLabelColor(value: unknown): string {
    const raw = String(value || '').trim();
    if (!raw) {
      return '#128c7e';
    }
    return raw.startsWith('#') ? raw : `#${raw}`;
  }

  private isDataUrlPreview(value: string): boolean {
    return /^data:[^,]+,/i.test(value);
  }

  private resolvePreviewMediaKind(contact: WhatsappContact): string {
    const mediaType = typeof contact.lastMessageType === 'string' ? contact.lastMessageType : '';
    const mediaMimetype = typeof contact.lastMessageMediaMimetype === 'string' ? contact.lastMessageMediaMimetype : '';

    if (mediaType === 'image' || mediaMimetype.startsWith('image/')) {
      return 'image';
    }
    if (mediaType === 'video' || mediaMimetype.startsWith('video/')) {
      return 'video';
    }
    if (mediaType === 'audio' || mediaType === 'ptt' || mediaMimetype.startsWith('audio/')) {
      return 'audio';
    }
    if (mediaType === 'sticker') {
      return 'sticker';
    }
    if (mediaType === 'document' || (Boolean(contact.lastMessageHasMedia) && mediaMimetype.startsWith('application/'))) {
      return 'document';
    }

    const previewText = (contact.lastMessagePreview || '').trim();
    if (this.isDataUrlPreview(previewText) || this.looksLikeRawImageBase64(previewText)) {
      return 'image';
    }

    const formattedPreview = this.formatLastMessagePreview(contact);
    if (formattedPreview === 'Foto') {
      return 'image';
    }
    if (formattedPreview === 'Video') {
      return 'video';
    }
    if (formattedPreview === 'Audio') {
      return 'audio';
    }
    if (formattedPreview === 'Documento') {
      return 'document';
    }
    if (formattedPreview === 'Figurinha') {
      return 'sticker';
    }

    return '';
  }

  private looksLikeRawImageBase64(value: string): boolean {
    const normalized = this.normalizeBase64(value);
    if (normalized.length < 256) {
      return false;
    }

    if (normalized.length % 4 === 1) {
      return false;
    }

    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
      return false;
    }

    return /^(\/9j\/|iVBORw0KGgo|R0lGOD|UklGR)/.test(normalized);
  }

  private normalizeBase64(value: string): string {
    return value.replace(/\s+/g, '');
  }

  private resolveDataUrlPreviewLabel(value: string): string {
    const normalized = value.toLowerCase();
    if (normalized.startsWith('data:image/')) {
      return 'Foto';
    }
    if (normalized.startsWith('data:video/')) {
      return 'Video';
    }
    if (normalized.startsWith('data:audio/')) {
      return 'Audio';
    }
    return 'Documento';
  }

}
