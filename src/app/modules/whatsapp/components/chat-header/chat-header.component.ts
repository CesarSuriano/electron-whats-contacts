import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';

import { WhatsappContact } from '../../../../models/whatsapp.model';
import { formatBrazilianPhone } from '../../helpers/phone-format.helper';
import { WhatsappStateService } from '../../services/whatsapp-state.service';

@Component({
  selector: 'app-chat-header',
  templateUrl: './chat-header.component.html',
  styleUrls: ['./chat-header.component.scss']
})
export class ChatHeaderComponent implements OnChanges {
  @Input() contact: WhatsappContact | null = null;

  constructor(private state: WhatsappStateService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['contact']) {
      const contact = this.contact;
      if (contact && !contact.isGroup && contact.photoUrl === undefined) {
        this.state.requestPhoto(contact.jid);
      }
    }
  }

  get phoneFormatted(): string {
    if (!this.contact) {
      return '';
    }
    return formatBrazilianPhone(this.contact.phone || this.contact.jid);
  }
}
