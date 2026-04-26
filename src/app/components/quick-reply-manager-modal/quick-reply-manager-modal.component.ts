import { Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges, ViewChild } from '@angular/core';

import { QuickReply } from '../../models/quick-reply.model';
import { QuickReplyService } from '../../services/quick-reply.service';

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

const QUICK_REPLY_EMOJIS = [
  '😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊', '😇', '🙂',
  '😉', '😍', '🥰', '😘', '😋', '😎', '🤗', '🤔', '🤨', '😐',
  '😴', '🤤', '😪', '😮', '😯', '😲', '😳', '🥺', '😢', '😭',
  '😤', '😠', '😡', '🤬', '🤯', '😱', '🥵', '🥶', '😷', '🤒',
  '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '👊', '✊', '🙏',
  '👏', '🙌', '💪', '🫡', '🫶', '❤️', '🧡', '💛', '💚', '💙',
  '💜', '🖤', '🤍', '💔', '❣️', '💯', '✅', '❌', '⚠️', '⭐',
  '🎉', '🎊', '🎁', '🏆', '💰', '💵', '🔥', '💧', '☀️', '🌙'
];

@Component({
  selector: 'app-quick-reply-manager-modal',
  templateUrl: './quick-reply-manager-modal.component.html',
  styleUrls: ['./quick-reply-manager-modal.component.scss']
})
export class QuickReplyManagerModalComponent implements OnChanges {
  @Input() isOpen = false;
  @Output() close = new EventEmitter<void>();

  @ViewChild('imageInput') imageInput?: ElementRef<HTMLInputElement>;
  @ViewChild('contentTextarea') contentTextarea?: ElementRef<HTMLTextAreaElement>;

  readonly emojis = QUICK_REPLY_EMOJIS;
  isEmojiPickerOpen = false;

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
    this.isEmojiPickerOpen = false;
  }

  startEdit(item: QuickReply): void {
    this.editingId = item.id;
    this.isCreating = false;
    this.errorMessage = '';
    this.draftShortcode = item.shortcode;
    this.draftTitle = item.title || '';
    this.draftContent = item.content;
    this.draftImageDataUrl = item.imageDataUrl;
    this.isEmojiPickerOpen = false;
  }

  cancelEdit(): void {
    this.editingId = null;
    this.isCreating = false;
    this.errorMessage = '';
    this.isEmojiPickerOpen = false;
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
    this.insertAtCursor('{nome}');
  }

  insertEmoji(emoji: string): void {
    this.insertAtCursor(emoji);
    this.isEmojiPickerOpen = false;
  }

  toggleEmojiPicker(): void {
    this.isEmojiPickerOpen = !this.isEmojiPickerOpen;
  }

  applyBold(): void {
    this.wrapSelection('*', '*', 'texto em negrito');
  }

  applyItalic(): void {
    this.wrapSelection('_', '_', 'texto em itálico');
  }

  applyStrike(): void {
    this.wrapSelection('~', '~', 'texto riscado');
  }

  applyMono(): void {
    this.wrapSelection('```', '```', 'código');
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
    this.isEmojiPickerOpen = false;
  }

  // Insere texto no cursor da textarea preservando o histórico de undo nativo
  // (document.execCommand gera um input event que entra na undo stack do browser).
  private insertAtCursor(text: string): void {
    const textarea = this.contentTextarea?.nativeElement;
    if (!textarea) {
      this.draftContent = `${this.draftContent || ''}${text}`;
      return;
    }

    textarea.focus();

    const ok = document.execCommand('insertText', false, text);
    if (ok) {
      this.draftContent = textarea.value;
      return;
    }

    // Fallback para browsers sem suporte a execCommand: setRangeText preserva undo na maioria.
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.setRangeText(text, start, end, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    this.draftContent = textarea.value;
  }

  private wrapSelection(prefix: string, suffix: string, placeholder: string): void {
    const textarea = this.contentTextarea?.nativeElement;
    if (!textarea) {
      this.draftContent = `${this.draftContent || ''}${prefix}${placeholder}${suffix}`;
      return;
    }

    textarea.focus();
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const selected = textarea.value.substring(start, end);
    const inner = selected || placeholder;
    const ok = document.execCommand('insertText', false, `${prefix}${inner}${suffix}`);
    if (ok) {
      if (!selected) {
        const selStart = start + prefix.length;
        textarea.setSelectionRange(selStart, selStart + inner.length);
      }
      this.draftContent = textarea.value;
      return;
    }

    textarea.setRangeText(`${prefix}${inner}${suffix}`, start, end, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    this.draftContent = textarea.value;
  }
}
