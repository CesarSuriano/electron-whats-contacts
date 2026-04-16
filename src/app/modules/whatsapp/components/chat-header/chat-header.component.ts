import { Component, Input } from '@angular/core';

import { WhatsappContact } from '../../../../models/whatsapp.model';
import { formatBrazilianPhone } from '../../helpers/phone-format.helper';

@Component({
  selector: 'app-chat-header',
  templateUrl: './chat-header.component.html',
  styleUrls: ['./chat-header.component.scss']
})
export class ChatHeaderComponent {
  @Input() contact: WhatsappContact | null = null;

  get phoneFormatted(): string {
    if (!this.contact) {
      return '';
    }
    return formatBrazilianPhone(this.contact.phone || this.contact.jid);
  }
}
