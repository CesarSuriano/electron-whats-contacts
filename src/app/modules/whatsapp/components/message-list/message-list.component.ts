import { AfterViewChecked, Component, ElementRef, Input, ViewChild } from '@angular/core';

import { MessageAck, WhatsappMessage } from '../../../../models/whatsapp.model';

@Component({
  selector: 'app-message-list',
  templateUrl: './message-list.component.html',
  styleUrls: ['./message-list.component.scss']
})
export class MessageListComponent implements AfterViewChecked {
  @Input() messages: WhatsappMessage[] = [];
  @ViewChild('scrollContainer') scrollContainer?: ElementRef<HTMLDivElement>;

  private lastMessageCount = 0;

  ngAfterViewChecked(): void {
    if (this.messages.length !== this.lastMessageCount) {
      this.scrollToBottom();
      this.lastMessageCount = this.messages.length;
    }
  }

  trackById(_: number, message: WhatsappMessage): string {
    return message.id;
  }

  isMediaMessage(message: WhatsappMessage): boolean {
    return Boolean(this.mediaInfo(message));
  }

  isImageMessage(message: WhatsappMessage): boolean {
    const info = this.mediaInfo(message);
    return Boolean(info?.kind === 'image' && info.previewUrl);
  }

  imagePreviewUrl(message: WhatsappMessage): string {
    const info = this.mediaInfo(message);
    return info?.previewUrl || '';
  }

  mediaFilename(message: WhatsappMessage): string {
    const info = this.mediaInfo(message);
    return info?.filename || 'Arquivo anexado';
  }

  mediaLabel(message: WhatsappMessage): string {
    const info = this.mediaInfo(message);
    if (!info) {
      return '';
    }

    if (info.kind === 'image') {
      return 'Imagem';
    }

    if (info.kind === 'video') {
      return 'Video';
    }

    if (info.kind === 'audio') {
      return 'Audio';
    }

    return 'Documento';
  }

  getAckIcon(message: WhatsappMessage): string {
    if (!message.isFromMe) return '';
    const ack = message.ack ?? (message.payload?.['ack'] as number | undefined) ?? null;
    if (ack === null || ack === undefined) return 'check';
    if (ack <= MessageAck.PENDING) return 'schedule';
    if (ack === MessageAck.SERVER) return 'check';
    if (ack === MessageAck.DEVICE) return 'done_all';
    return 'done_all'; // READ or PLAYED
  }

  isAckRead(message: WhatsappMessage): boolean {
    if (!message.isFromMe) return false;
    const ack = message.ack ?? (message.payload?.['ack'] as number | undefined) ?? null;
    return ack !== null && ack !== undefined && ack >= MessageAck.READ;
  }

  private mediaInfo(message: WhatsappMessage): { kind: string; filename: string; previewUrl: string | null } | null {
    const payload = message.payload || {};
    const hasMedia = Boolean(payload['hasMedia'])
      || (typeof payload['mediaMimetype'] === 'string' && payload['mediaMimetype'].length > 0)
      || (typeof payload['mediaDataUrl'] === 'string' && payload['mediaDataUrl'].length > 0);

    if (!hasMedia) {
      return null;
    }

    const mediaMimetype = typeof payload['mediaMimetype'] === 'string' ? payload['mediaMimetype'] : '';
    const mediaType = typeof payload['type'] === 'string' ? payload['type'] : '';
    const filename = typeof payload['mediaFilename'] === 'string' && payload['mediaFilename'].trim().length
      ? payload['mediaFilename']
      : 'Arquivo anexado';
    const previewUrl = typeof payload['mediaDataUrl'] === 'string' ? payload['mediaDataUrl'] : null;

    let kind = 'document';
    if (mediaMimetype.startsWith('image/') || mediaType === 'image') {
      kind = 'image';
    } else if (mediaMimetype.startsWith('video/') || mediaType === 'video') {
      kind = 'video';
    } else if (mediaMimetype.startsWith('audio/') || mediaType === 'audio') {
      kind = 'audio';
    }

    return { kind, filename, previewUrl };
  }

  private scrollToBottom(): void {
    const el = this.scrollContainer?.nativeElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }
}
