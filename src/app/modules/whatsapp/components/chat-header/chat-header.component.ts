import { Component, HostListener, Input, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import { Subject } from 'rxjs';
import { switchMap, takeUntil } from 'rxjs/operators';
import { Observable, of } from 'rxjs';

import { AppLabel } from '../../../../models/app-label.model';
import { WhatsappContact, WhatsappLabel } from '../../../../models/whatsapp.model';
import { LabelService } from '../../../../services/label.service';
import { ManagerLaunchService } from '../../../../services/manager-launch.service';
import { ContactLabelDisplayItem, resolveCombinedContactLabelDisplayItems } from '../../helpers/contact-label-display.helper';
import { formatBrazilianPhone, resolveDisplayedPhoneSource } from '../../helpers/phone-format.helper';
import { WhatsappStateService } from '../../services/whatsapp-state.service';

@Component({
  selector: 'app-chat-header',
  templateUrl: './chat-header.component.html',
  styleUrls: ['./chat-header.component.scss']
})
export class ChatHeaderComponent implements OnChanges, OnDestroy {
  @Input() contact: WhatsappContact | null = null;
  @Input() whatsappLabels: WhatsappLabel[] = [];

  readonly maxVisibleLabels = 3;

  appLabels: AppLabel[] = [];
  isLabelPickerOpen = false;
  isOverflowMenuOpen = false;
  pendingRemovalLabel: ContactLabelDisplayItem | null = null;

  private readonly destroy$ = new Subject<void>();
  private readonly contactJid$ = new Subject<string | null>();

  constructor(
    private state: WhatsappStateService,
    private labelService: LabelService,
    private managerLaunch: ManagerLaunchService
  ) {
    this.contactJid$
      .pipe(
        takeUntil(this.destroy$),
        switchMap((jid: string | null): Observable<AppLabel[]> => jid ? this.labelService.watchLabelsForJid(jid) : of([] as AppLabel[]))
      )
      .subscribe(labels => {
        this.appLabels = labels;
      });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['contact']) {
      const contact = this.contact;
      if (contact && contact.photoUrl == null) {
        this.state.requestPhoto(contact.jid);
      }
      this.contactJid$.next(contact?.jid || null);
      this.isLabelPickerOpen = false;
      this.isOverflowMenuOpen = false;
      this.pendingRemovalLabel = null;
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  get phoneFormatted(): string {
    if (!this.contact) {
      return '';
    }

    const phoneSource = resolveDisplayedPhoneSource(this.contact);
    return formatBrazilianPhone(phoneSource);
  }

  get displayedLabels(): ContactLabelDisplayItem[] {
    return resolveCombinedContactLabelDisplayItems(this.contact, this.appLabels, this.whatsappLabels);
  }

  get visibleLabels(): ContactLabelDisplayItem[] {
    return this.displayedLabels.slice(0, this.maxVisibleLabels);
  }

  get hiddenLabels(): ContactLabelDisplayItem[] {
    return this.displayedLabels.slice(this.maxVisibleLabels);
  }

  toggleLabelPicker(): void {
    if (!this.contact) {
      return;
    }
    this.isOverflowMenuOpen = false;
    this.isLabelPickerOpen = !this.isLabelPickerOpen;
  }

  closeLabelPicker(): void {
    this.isLabelPickerOpen = false;
  }

  openLabelPicker(): void {
    if (!this.contact) {
      return;
    }
    this.isOverflowMenuOpen = false;
    this.isLabelPickerOpen = true;
  }

  toggleOverflowMenu(): void {
    if (!this.hiddenLabels.length) {
      return;
    }
    this.isLabelPickerOpen = false;
    this.isOverflowMenuOpen = !this.isOverflowMenuOpen;
  }

  closeOverflowMenu(): void {
    this.isOverflowMenuOpen = false;
  }

  requestRemoveLabel(label: ContactLabelDisplayItem): void {
    if (!label.removable || !this.contact) {
      return;
    }

    this.isOverflowMenuOpen = false;
    this.pendingRemovalLabel = label;
  }

  closeRemoveLabelDialog(): void {
    this.pendingRemovalLabel = null;
  }

  confirmRemoveLabel(): void {
    if (!this.contact || !this.pendingRemovalLabel?.appLabelId) {
      this.pendingRemovalLabel = null;
      return;
    }

    this.labelService.toggleLabelOnJid(this.contact.jid, this.pendingRemovalLabel.appLabelId);
    this.pendingRemovalLabel = null;
  }

  get removeLabelConfirmationText(): string {
    if (!this.pendingRemovalLabel) {
      return '';
    }

    return `Tem certeza que deseja remover a etiqueta ${this.pendingRemovalLabel.name} deste contato?`;
  }

  onManageRequested(): void {
    this.isLabelPickerOpen = false;
    this.isOverflowMenuOpen = false;
    this.managerLaunch.openLabelManager();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.isOverflowMenuOpen) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (!target) {
      this.isOverflowMenuOpen = false;
      return;
    }

    if (target.closest('[data-label-overflow-anchor]') || target.closest('[data-label-overflow-menu]')) {
      return;
    }

    this.isOverflowMenuOpen = false;
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.isOverflowMenuOpen = false;
    this.pendingRemovalLabel = null;
  }
}
