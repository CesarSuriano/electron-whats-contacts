import { Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges, ViewChild } from '@angular/core';

import { QuickReply } from '../../models/quick-reply.model';
import { QuickReplyService } from '../../services/quick-reply.service';

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

@Component({
  selector: 'app-quick-reply-manager-modal',
  templateUrl: './quick-reply-manager-modal.component.html',
  styleUrls: ['./quick-reply-manager-modal.component.scss']
})
export class QuickReplyManagerModalComponent implements OnChanges {
  @Input() isOpen = false;
  @Output() close = new EventEmitter<void>();

  @ViewChild('imageInput') imageInput?: ElementRef<HTMLInputElement>;

  items: QuickReply[] = [];
  editingId: string | null = null;
  isCreating = false;
  errorMessage = '';

  draftShortcode = '';
  draftTitle = '';
  draftContent = '';
  draftImageDataUrl?: string;

  constructor(private quickReplies: QuickReplyService) {
    this.quickReplies.items$.subscribe(items => {
      this.items = [...items].sort((a, b) => a.shortcode.localeCompare(b.shortcode, 'pt-BR'));
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isOpen'] && this.isOpen) {
      this.resetForm();
    }
  }

  startCreate(): void {
    this.editingId = null;
    this.isCreating = true;
    this.errorMessage = '';
    this.draftShortcode = '';
    this.draftTitle = '';
    this.draftContent = '';
    this.draftImageDataUrl = undefined;
  }

  startEdit(item: QuickReply): void {
    this.editingId = item.id;
    this.isCreating = false;
    this.errorMessage = '';
    this.draftShortcode = item.shortcode;
    this.draftTitle = item.title || '';
    this.draftContent = item.content;
    this.draftImageDataUrl = item.imageDataUrl;
  }

  cancelEdit(): void {
    this.editingId = null;
    this.isCreating = false;
    this.errorMessage = '';
  }

  remove(item: QuickReply): void {
    if (!window.confirm(`Excluir a mensagem rápida "/${item.shortcode}"?`)) {
      return;
    }
    this.quickReplies.remove(item.id);
    if (this.editingId === item.id) {
      this.cancelEdit();
    }
  }

  save(): void {
    const content = this.draftContent.trim();
    const shortcode = this.quickReplies.normalizeShortcode(this.draftShortcode);

    if (!shortcode) {
      this.errorMessage = 'Informe um atalho (apenas letras, números, hífen ou underline).';
      return;
    }

    if (!content) {
      this.errorMessage = 'Escreva o conteúdo da mensagem.';
      return;
    }

    if (!this.quickReplies.isShortcodeAvailable(shortcode, this.editingId || undefined)) {
      this.errorMessage = `O atalho "/${shortcode}" já está em uso.`;
      return;
    }

    const draft = {
      shortcode,
      title: this.draftTitle.trim() || undefined,
      content,
      imageDataUrl: this.draftImageDataUrl
    };

    if (this.editingId) {
      this.quickReplies.update(this.editingId, draft);
    } else {
      this.quickReplies.create(draft);
    }

    this.cancelEdit();
  }

  chooseImage(): void {
    this.imageInput?.nativeElement.click();
  }

  onImageSelected(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) {
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      this.errorMessage = 'A imagem deve ter no máximo 3 MB.';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      this.draftImageDataUrl = reader.result as string;
    };
    reader.readAsDataURL(file);
    if (this.imageInput?.nativeElement) {
      this.imageInput.nativeElement.value = '';
    }
  }

  clearImage(): void {
    this.draftImageDataUrl = undefined;
    if (this.imageInput?.nativeElement) {
      this.imageInput.nativeElement.value = '';
    }
  }

  insertNameToken(): void {
    this.draftContent = `${this.draftContent || ''}{nome}`;
  }

  onShortcodeInput(value: string): void {
    this.draftShortcode = this.quickReplies.normalizeShortcode(value);
  }

  get isFormOpen(): boolean {
    return this.isCreating || this.editingId !== null;
  }

  private resetForm(): void {
    this.editingId = null;
    this.isCreating = false;
    this.errorMessage = '';
    this.draftShortcode = '';
    this.draftTitle = '';
    this.draftContent = '';
    this.draftImageDataUrl = undefined;
  }
}
