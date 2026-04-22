import { Component, Input, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import { Subject } from 'rxjs';
import { switchMap, takeUntil } from 'rxjs/operators';
import { Observable, of } from 'rxjs';

import { AppLabel } from '../../../../models/app-label.model';
import { WhatsappContact } from '../../../../models/whatsapp.model';
import { LabelService } from '../../../../services/label.service';
import { ManagerLaunchService } from '../../../../services/manager-launch.service';
import { formatBrazilianPhone } from '../../helpers/phone-format.helper';
import { WhatsappStateService } from '../../services/whatsapp-state.service';

@Component({
  selector: 'app-chat-header',
  templateUrl: './chat-header.component.html',
  styleUrls: ['./chat-header.component.scss']
})
export class ChatHeaderComponent implements OnChanges, OnDestroy {
  @Input() contact: WhatsappContact | null = null;

  appLabels: AppLabel[] = [];
  isLabelPickerOpen = false;

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

  toggleLabelPicker(): void {
    if (!this.contact) {
      return;
    }
    this.isLabelPickerOpen = !this.isLabelPickerOpen;
  }

  closeLabelPicker(): void {
    this.isLabelPickerOpen = false;
  }

  removeLabel(label: AppLabel): void {
    if (!this.contact) {
      return;
    }
    this.labelService.toggleLabelOnJid(this.contact.jid, label.id);
  }

  onManageRequested(): void {
    this.isLabelPickerOpen = false;
    this.managerLaunch.openLabelManager();
  }

  private resolvePhoneSource(contact: WhatsappContact): string {
    const phone = typeof contact.phone === 'string' ? contact.phone.trim() : '';
    if (phone) {
      return phone;
    }

    return contact.jid.endsWith('@lid') ? '' : contact.jid;
  }
}
