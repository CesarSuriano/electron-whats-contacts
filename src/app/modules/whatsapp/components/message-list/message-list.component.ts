import { AfterViewChecked, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, HostListener, Input, OnChanges, Output, ViewChild } from '@angular/core';

import { MessageAck, WhatsappMessage } from '../../../../models/whatsapp.model';

export interface MessageActionEvent {
  messageId: string;
  text: string;
  isFromMe: boolean;
}

interface MessageListItem {
  id: string;
  sentAt: string;
  isFromMe: boolean;
  text: string;
  ackIcon: string;
  ackRead: boolean;
  quotedMsgBody: string | null;
  quotedMsgFromMe: boolean | null;
  media: {
    kind: string;
    filename: string;
    previewUrl: string | null;
    label: string;
  } | null;
}

@Component({
  selector: 'app-message-list',
  templateUrl: './message-list.component.html',
  styleUrls: ['./message-list.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MessageListComponent implements AfterViewChecked, OnChanges {
  @Input() messages: WhatsappMessage[] = [];
  @ViewChild('scrollContainer') scrollContainer?: ElementRef<HTMLDivElement>;

  @Output() replySelected = new EventEmitter<MessageActionEvent>();
  @Output() forwardSelected = new EventEmitter<MessageActionEvent>();
  @Output() deleteSelected = new EventEmitter<MessageActionEvent>();

  viewMessages: MessageListItem[] = [];
  openMenuId: string | null = null;
  lightboxUrl: string | null = null;

  private lastMessageCount = 0;
  private lastConversationJid = '';
  private shouldAutoScrollOnNextCheck = false;
  private isPinnedToBottom = true;

  constructor(private cdr: ChangeDetectorRef) {}

  ngOnChanges(): void {
    const nextConversationJid = this.messages[0]?.contactJid || '';
    const nextMessageCount = this.messages.length;
    const conversationChanged = nextConversationJid !== this.lastConversationJid;

    this.shouldAutoScrollOnNextCheck = nextMessageCount > this.lastMessageCount
      || (conversationChanged && nextMessageCount > 0);

    this.viewMessages = this.messages.map(message => this.toMessageListItem(message));
  }

  ngAfterViewChecked(): void {
    if (this.shouldAutoScrollOnNextCheck) {
      this.scrollToBottom();
    }

    this.lastMessageCount = this.viewMessages.length;
    this.lastConversationJid = this.messages[0]?.contactJid || '';
    this.shouldAutoScrollOnNextCheck = false;
    this.updatePinnedToBottom();
  }

  onScroll(): void {
    this.updatePinnedToBottom();
  }

  onMediaLoad(): void {
    if (!this.isPinnedToBottom) {
      return;
    }

    this.scrollToBottom();
    this.updatePinnedToBottom();
  }

  trackById(_: number, message: { id: string }): string {
    return message.id;
  }

  toggleMenu(messageId: string, event: MouseEvent): void {
    event.stopPropagation();
    this.openMenuId = this.openMenuId === messageId ? null : messageId;
    this.cdr.markForCheck();
  }

  onReply(message: MessageListItem, event: MouseEvent): void {
    event.stopPropagation();
    this.openMenuId = null;
    this.replySelected.emit({ messageId: message.id, text: message.text, isFromMe: message.isFromMe });
  }

  onForward(message: MessageListItem, event: MouseEvent): void {
    event.stopPropagation();
    this.openMenuId = null;
    this.forwardSelected.emit({ messageId: message.id, text: message.text, isFromMe: message.isFromMe });
  }

  onDelete(message: MessageListItem, event: MouseEvent): void {
    event.stopPropagation();
    this.openMenuId = null;
    this.deleteSelected.emit({ messageId: message.id, text: message.text, isFromMe: message.isFromMe });
  }

  openLightbox(url: string): void {
    this.lightboxUrl = url;
    this.cdr.markForCheck();
  }

  closeLightbox(): void {
    this.lightboxUrl = null;
    this.cdr.markForCheck();
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    if (this.openMenuId !== null) {
      this.openMenuId = null;
      this.cdr.markForCheck();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.lightboxUrl) {
      this.closeLightbox();
    }
    if (this.openMenuId !== null) {
      this.openMenuId = null;
      this.cdr.markForCheck();
    }
  }

  private toMessageListItem(message: WhatsappMessage): MessageListItem {
    const media = this.mediaInfo(message);
    return {
      id: message.id,
      sentAt: message.sentAt,
      isFromMe: message.isFromMe,
      text: this.resolveMessageText(message, media),
      ackIcon: this.resolveAckIcon(message),
      ackRead: this.resolveAckRead(message),
      quotedMsgBody: this.resolveQuotedMsgBody(message),
      quotedMsgFromMe: this.resolveQuotedMsgFromMe(message),
      media: media
        ? {
            ...media,
            label: this.mediaLabelFromInfo(media)
          }
        : null
    };
  }

  private resolveQuotedMsgBody(message: WhatsappMessage): string | null {
    const body = message.payload?.['quotedMsgBody'];
    if (typeof body === 'string' && body.trim()) {
      return body.trim();
    }
    return null;
  }

  private resolveQuotedMsgFromMe(message: WhatsappMessage): boolean | null {
    const fromMe = message.payload?.['quotedMsgFromMe'];
    if (typeof fromMe === 'boolean') {
      return fromMe;
    }
    return null;
  }

  private resolveAckIcon(message: WhatsappMessage): string {
    if (!message.isFromMe) {
      return '';
    }

    const ack = message.ack ?? (message.payload?.['ack'] as number | undefined) ?? null;
    if (ack === null || ack === undefined) {
      return 'done';
    }
    if (ack <= MessageAck.PENDING) {
      return 'schedule';
    }
    if (ack === MessageAck.SERVER) {
      return 'done';
    }
    if (ack === MessageAck.DEVICE) {
      return 'done_all';
    }

    return 'done_all';
  }

  private resolveAckRead(message: WhatsappMessage): boolean {
    if (!message.isFromMe) {
      return false;
    }

    const ack = message.ack ?? (message.payload?.['ack'] as number | undefined) ?? null;
    return ack !== null && ack !== undefined && ack >= MessageAck.READ;
  }

  private mediaLabelFromInfo(info: { kind: string }): string {
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

  private resolveMessageText(
    message: WhatsappMessage,
    media: { kind: string; filename: string; previewUrl: string | null } | null
  ): string {
    if (typeof message.text !== 'string') {
      return this.nonTextLabel(message, media);
    }

    const trimmed = message.text.trim();
    if (!trimmed) {
      return this.nonTextLabel(message, media);
    }

    if (/^data:[^,]+,/i.test(trimmed) || this.looksLikeRawImageBase64(trimmed)) {
      return '';
    }

    return message.text;
  }

  private nonTextLabel(
    message: WhatsappMessage,
    media: { kind: string; filename: string; previewUrl: string | null } | null = this.mediaInfo(message)
  ): string {
    if (media) {
      return '';
    }

    const type = typeof message.payload?.['type'] === 'string'
      ? String(message.payload?.['type']).trim().toLowerCase()
      : '';

    switch (type) {
      case 'revoked':
        return 'Mensagem apagada';
      case 'location':
        return 'Localização';
      case 'vcard':
      case 'multi_vcard':
      case 'contact_card':
        return 'Contato';
      case 'reaction':
        return 'Reação';
      case 'poll_creation':
        return 'Enquete';
      case 'event_creation':
        return 'Evento';
      case 'order':
        return 'Pedido';
      case 'payment':
        return 'Pagamento';
      default:
        return type ? 'Mensagem' : '';
    }
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
    const rawPreview = typeof payload['mediaDataUrl'] === 'string' ? payload['mediaDataUrl'].trim() : '';
    let previewUrl: string | null = null;
    if (rawPreview) {
      if (/^data:[^,]+,/i.test(rawPreview)) {
        previewUrl = rawPreview;
      } else if ((mediaMimetype.startsWith('image/') || mediaType === 'image') && this.looksLikeRawImageBase64(rawPreview)) {
        const mime = mediaMimetype.startsWith('image/') ? mediaMimetype : 'image/jpeg';
        previewUrl = `data:${mime};base64,${this.normalizeBase64(rawPreview)}`;
      }
    }

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

  private updatePinnedToBottom(): void {
    const el = this.scrollContainer?.nativeElement;
    if (!el) {
      return;
    }

    const distanceToBottom = (el.scrollHeight || 0) - (el.clientHeight || 0) - (el.scrollTop || 0);
    this.isPinnedToBottom = distanceToBottom <= 48;
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
}
