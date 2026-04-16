import { Injectable } from '@angular/core';

import { Cliente } from '../models/cliente.model';
import { MessageTemplateType } from '../models/message-template.model';

export interface PendingBulkSend {
  templateType: MessageTemplateType;
  clientes: Cliente[];
}

@Injectable({ providedIn: 'root' })
export class PendingBulkSendService {
  private pending: PendingBulkSend | null = null;

  set(pending: PendingBulkSend): void {
    this.pending = pending;
  }

  consume(): PendingBulkSend | null {
    const val = this.pending;
    this.pending = null;
    return val;
  }
}
