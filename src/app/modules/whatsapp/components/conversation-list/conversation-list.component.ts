import { AfterViewInit, Component, ElementRef, Input, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Subject, combineLatest } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { MessageAck, WhatsappContact, WhatsappLabel } from '../../../../models/whatsapp.model';
import { WhatsappWebjsGatewayService } from '../../../../services/whatsapp-webjs-gateway.service';
import { formatBrazilianPhone } from '../../helpers/phone-format.helper';
import { WhatsappStateService } from '../../services/whatsapp-state.service';

type ConversationFilterId = 'all' | 'conversations' | 'unread' | `label:${string}`;

interface ConversationFilterChip {
  id: ConversationFilterId;
  label: string;
  hexColor?: string | null;
}

const PHOTO_VISIBLE_OVERSCAN = 6;
const PHOTO_FALLBACK_ITEM_HEIGHT = 76;

@Component({
  selector: 'app-conversation-list',
  templateUrl: './conversation-list.component.html',
  styleUrls: ['./conversation-list.component.scss']
})
export class ConversationListComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input() disabled = false;
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
  labelFilters: string[] = [];
  filterChipsCached: ConversationFilterChip[] = [];
  isLoading = false;
  isSyncing = false;
  isSelectionMode = false;
  selectedJids = new Set<string>();
  flashingJids = new Set<string>();
  private labelColorMap = new Map<string, string>();

  private destroy$ = new Subject<void>();
  private prevOrderMap = new Map<string, number>();
  private scrollContainer?: ElementRef<HTMLDivElement>;
  private visiblePhotoTimer: number | null = null;

  constructor(
    private state: WhatsappStateService,
    private gateway: WhatsappWebjsGatewayService
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
      });

    this.state.loadingState$
      .pipe(takeUntil(this.destroy$))
      .subscribe(state => (this.isLoading = state.contacts));

    this.state.syncing$
      .pipe(takeUntil(this.destroy$))
      .subscribe(syncing => (this.isSyncing = syncing));

    this.state.selectionMode$
      .pipe(takeUntil(this.destroy$))
      .subscribe(mode => (this.isSelectionMode = mode));

    this.state.selectedJids$
      .pipe(takeUntil(this.destroy$))
      .subscribe(jids => (this.selectedJids = jids));

    this.gateway.loadLabels().subscribe({
      next: labels => {
        this.labelColorMap.clear();
        labels.forEach(label => {
          if (label.hexColor) {
            this.labelColorMap.set(label.name, label.hexColor);
          }
        });
      },
      error: () => { /* silent */ }
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
      }, 1500);
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
    this.applyFilter();
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
    return formatBrazilianPhone(contact.phone || contact.jid);
  }

  formatLastMessagePreview(contact: WhatsappContact): string {
    const text = (contact.lastMessagePreview || '').trim();
    if (text) {
      return text;
    }

    return this.formatPhone(contact);
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

  getChipStyle(chip: ConversationFilterChip): Record<string, string> {
    if (!chip.hexColor || this.activeFilter !== chip.id) {
      return {};
    }
    return {
      'background-color': chip.hexColor,
      'border-color': chip.hexColor,
      'color': '#fff'
    };
  }

  getUnreadCount(contact: WhatsappContact): number {
    return Math.max(0, Number(contact.unreadCount || 0));
  }

  getPreviewAckIcon(contact: WhatsappContact): string {
    if (!contact.lastMessageFromMe) return '';
    const ack = contact.lastMessageAck;
    if (ack === null || ack === undefined) return 'check';
    if (ack <= MessageAck.PENDING) return 'schedule';
    if (ack === MessageAck.SERVER) return 'check';
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

  private applyFilter(): void {
    const term = this.searchTerm.trim().toLowerCase();
    const activeLabel = this.getActiveLabelName();

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

      if (activeLabel) {
        const labels = Array.isArray(contact.labels) ? contact.labels : [];
        if (!labels.includes(activeLabel)) {
          return false;
        }
      }

      if (!term) {
        return true;
      }

      const digits = term.replace(/\D/g, '');
      const name = (contact.name || '').toLowerCase();
      const phone = contact.phone || '';
      const preview = (contact.lastMessagePreview || '').toLowerCase();
      const labelsJoined = (Array.isArray(contact.labels) ? contact.labels : []).join(' ').toLowerCase();

      if (name.includes(term) || preview.includes(term) || labelsJoined.includes(term)) {
        return true;
      }

      return digits.length > 0 && phone.includes(digits);
    });

    this.scheduleVisiblePhotoPrefetch();
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
      if (!contact.isGroup) {
        this.state.requestPhoto(contact.jid);
      }
    }
  }

  private refreshLabelFilters(): void {
    const labels = new Set<string>();
    this.contacts.forEach(contact => {
      (contact.labels || []).forEach(label => {
        const normalized = String(label || '').trim();
        if (normalized) {
          labels.add(normalized);
        }
      });
    });

    this.labelFilters = Array.from(labels).sort((a, b) => a.localeCompare(b, 'pt-BR'));

    const activeLabel = this.getActiveLabelName();
    if (activeLabel && !this.labelFilters.includes(activeLabel)) {
      this.activeFilter = 'all';
    }

    this.rebuildFilterChips();
  }

  private rebuildFilterChips(): void {
    const base: ConversationFilterChip[] = [
      { id: 'all', label: 'Tudo' },
      { id: 'conversations', label: 'Conversas' },
      { id: 'unread', label: 'Não lidas' }
    ];

    const labelChips = this.labelFilters.map(label => ({
      id: `label:${encodeURIComponent(label)}` as ConversationFilterId,
      label,
      hexColor: this.labelColorMap.get(label) || null
    }));

    this.filterChipsCached = [...base, ...labelChips];
  }

  private getActiveLabelName(): string {
    if (!this.activeFilter.startsWith('label:')) {
      return '';
    }

    return decodeURIComponent(this.activeFilter.slice('label:'.length));
  }

}
