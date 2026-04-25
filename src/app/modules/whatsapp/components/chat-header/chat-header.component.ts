import { Component, HostListener, Input, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import { Subject } from 'rxjs';
import { switchMap, takeUntil } from 'rxjs/operators';
import { Observable, of } from 'rxjs';

import { AppLabel } from '../../../../models/app-label.model';
import { WhatsappContact } from '../../../../models/whatsapp.model';
import { LabelService } from '../../../../services/label.service';
import { ManagerLaunchService } from '../../../../services/manager-launch.service';
import { extractDigits, formatBrazilianPhone } from '../../helpers/phone-format.helper';
import { WhatsappStateService } from '../../services/whatsapp-state.service';

@Component({
  selector: 'app-chat-header',
  templateUrl: './chat-header.component.html',
  styleUrls: ['./chat-header.component.scss']
})
export class ChatHeaderComponent implements OnChanges, OnDestroy {
  @Input() contact: WhatsappContact | null = null;

  readonly maxVisibleLabels = 2;

  appLabels: AppLabel[] = [];
  isLabelPickerOpen = false;
  isOverflowMenuOpen = false;

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

    const phoneSource = this.resolvePhoneSource(this.contact);
    return formatBrazilianPhone(phoneSource);
  }

  get visibleLabels(): AppLabel[] {
    return this.appLabels.slice(0, this.maxVisibleLabels);
  }

  get hiddenLabels(): AppLabel[] {
    return this.appLabels.slice(this.maxVisibleLabels);
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

  removeLabel(label: AppLabel): void {
    if (!this.contact) {
      return;
    }
    this.labelService.toggleLabelOnJid(this.contact.jid, label.id);
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
  }

  private resolvePhoneSource(contact: WhatsappContact): string {
    const jid = typeof contact.jid === 'string' ? contact.jid.trim() : '';
    const phoneDigits = extractDigits(contact.phone || '');
    const jidDigits = extractDigits(jid);

    if (jid.endsWith('@g.us')) {
      return '';
    }

    if (jid.endsWith('@lid')) {
      // @lid is an internal linked-id. If we still only have this id, do not
      // expose it as a phone number in the UI.
      return this.isLikelyPublicPhone(phoneDigits) ? phoneDigits : '';
    }

    if (jid.endsWith('@c.us')) {
      if (!phoneDigits) {
        return jidDigits;
      }

      if (!jidDigits) {
        return this.isLikelyPublicPhone(phoneDigits) ? phoneDigits : '';
      }

      if (this.areBrazilianVariants(phoneDigits, jidDigits)) {
        return phoneDigits.length >= jidDigits.length ? phoneDigits : jidDigits;
      }

      if (this.looksLikeLinkedId(phoneDigits) && this.isLikelyPublicPhone(jidDigits)) {
        return jidDigits;
      }

      return this.isLikelyPublicPhone(phoneDigits) ? phoneDigits : jidDigits;
    }

    if (this.isLikelyPublicPhone(phoneDigits)) {
      return phoneDigits;
    }

    return jidDigits;
  }

  private isLikelyPublicPhone(value: string): boolean {
    return value.length >= 10 && value.length <= 15;
  }

  private looksLikeLinkedId(value: string): boolean {
    return value.length > 15;
  }

  private areBrazilianVariants(a: string, b: string): boolean {
    const normalize = (value: string): string => {
      const withoutCountry = value.startsWith('55') ? value.slice(2) : value;
      if (withoutCountry.length !== 10 && withoutCountry.length !== 11) {
        return '';
      }

      const ddd = withoutCountry.slice(0, 2);
      const local = withoutCountry.slice(2);
      const withoutNinth = local.length === 9 && local.startsWith('9')
        ? local.slice(1)
        : local;

      return `${ddd}:${withoutNinth}`;
    };

    const normalizedA = normalize(a);
    const normalizedB = normalize(b);
    return Boolean(normalizedA && normalizedB && normalizedA === normalizedB);
  }
}
