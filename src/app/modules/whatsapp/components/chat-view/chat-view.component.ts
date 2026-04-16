import { Component, Input, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { WhatsappContact, WhatsappMessage } from '../../../../models/whatsapp.model';
import { BulkSendService } from '../../services/bulk-send.service';
import { WhatsappStateService } from '../../services/whatsapp-state.service';
import { ComposerComponent } from '../composer/composer.component';

@Component({
  selector: 'app-chat-view',
  templateUrl: './chat-view.component.html',
  styleUrls: ['./chat-view.component.scss']
})
export class ChatViewComponent implements OnInit, OnDestroy {
  @Input() disabled = false;
  @ViewChild(ComposerComponent) composer?: ComposerComponent;

  contact: WhatsappContact | null = null;
  messages: WhatsappMessage[] = [];
  draftText = '';
  isSending = false;
  isSyncingMessages = false;

  private destroy$ = new Subject<void>();

  constructor(private state: WhatsappStateService, private bulkSend: BulkSendService) {}

  ngOnInit(): void {
    this.state.selectedContact$.pipe(takeUntil(this.destroy$)).subscribe(contact => {
      this.contact = contact;
    });

    this.state.selectedMessages$.pipe(takeUntil(this.destroy$)).subscribe(messages => {
      this.messages = messages;
    });

    this.state.selectedContactJid$
      .pipe(takeUntil(this.destroy$))
      .subscribe(jid => {
        if (!jid) {
          return;
        }
        setTimeout(() => this.composer?.focus(), 0);
      });

    this.state.loadingState$.pipe(takeUntil(this.destroy$)).subscribe(state => {
      this.isSending = state.sending;
      this.isSyncingMessages = state.messages;
    });

    this.state.draftText$.pipe(takeUntil(this.destroy$)).subscribe(text => {
      if (text !== this.draftText) {
        this.draftText = text;
      }
    });

    this.state.draftImageDataUrl$.pipe(takeUntil(this.destroy$)).subscribe(dataUrl => {
      if (dataUrl) {
        setTimeout(() => this.composer?.setAttachmentFromDataUrl(dataUrl, 'imagem-template.jpg'), 0);
      }
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  onDraftChange(value: string): void {
    this.draftText = value;
    this.state.setDraftText(value);
  }

  onSendText(text: string): void {
    if (!this.contact || this.disabled || this.isSyncingMessages) {
      return;
    }
    this.state.sendText(this.contact.jid, text).subscribe({
      next: () => {
        if (!this.bulkSend.hasActiveQueue) {
          this.composer?.resetAfterSend();
          this.draftText = '';
          this.state.setDraftText('');
        }
      },
      error: () => {}
    });
  }

  onSendMedia(payload: { file: File; caption: string }): void {
    if (!this.contact || this.disabled || this.isSyncingMessages) {
      return;
    }
    this.state.sendMedia(this.contact.jid, payload.file, payload.caption).subscribe({
      next: () => {
        if (!this.bulkSend.hasActiveQueue) {
          this.composer?.resetAfterSend();
          this.draftText = '';
          this.state.setDraftText('');
        }
      },
      error: () => {}
    });
  }
}
