import { Component, ElementRef, EventEmitter, Input, Output, ViewChild } from '@angular/core';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ACCEPTED_MIME_PREFIXES = ['image/', 'application/pdf'];
const ACCEPTED_DOC_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv'];

@Component({
  selector: 'app-composer',
  templateUrl: './composer.component.html',
  styleUrls: ['./composer.component.scss']
})
export class ComposerComponent {
  @Input() draftText = '';
  @Input() isSending = false;
  @Input() disabled = false;
  @Output() draftTextChange = new EventEmitter<string>();
  @Output() sendText = new EventEmitter<string>();
  @Output() sendMedia = new EventEmitter<{ file: File; caption: string }>();

  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;
  @ViewChild('textarea') textarea?: ElementRef<HTMLTextAreaElement>;

  setAttachmentFromDataUrl(dataUrl: string, filename: string): void {
    try {
      const commaIndex = dataUrl.indexOf(',');
      if (commaIndex === -1) {
        return;
      }
      const header = dataUrl.slice(0, commaIndex);
      const base64Data = dataUrl.slice(commaIndex + 1);
      const mimeMatch = header.match(/:(.*?);/);
      const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
      const byteString = atob(base64Data);
      const bytes = new Uint8Array(byteString.length);
      for (let i = 0; i < byteString.length; i++) {
        bytes[i] = byteString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: mime });
      this.clearPreview();
      this.selectedFile = new File([blob], filename, { type: mime });
      this.filePreviewUrl = dataUrl;
    } catch {
      // ignore conversion errors
    }
  }

  focus(): void {
    const el = this.textarea?.nativeElement;
    if (!el || this.disabled) {
      return;
    }
    el.focus();
  }

  isAttachMenuOpen = false;
  selectedFile: File | null = null;
  filePreviewUrl: string | null = null;
  attachmentError = '';

  onTextChange(value: string): void {
    this.draftText = value;
    this.draftTextChange.emit(value);
  }

  onPaste(event: ClipboardEvent): void {
    if (this.disabled || this.isSending) {
      return;
    }

    const items = event.clipboardData?.items;
    if (!items) {
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) {
          continue;
        }

        if (file.size > MAX_FILE_BYTES) {
          this.attachmentError = 'Imagem excede 50MB.';
          return;
        }

        event.preventDefault();
        this.attachmentError = '';
        this.clearPreview();
        const ext = item.type.split('/')[1] || 'png';
        this.selectedFile = new File([file], `imagem-colada.${ext}`, { type: item.type });
        this.filePreviewUrl = URL.createObjectURL(file);
        return;
      }
    }
  }

  onTextareaKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.onSubmit();
    }
  }

  toggleAttachMenu(): void {
    if (this.disabled || this.isSending) {
      return;
    }
    this.isAttachMenuOpen = !this.isAttachMenuOpen;
  }

  chooseFile(kind: 'image' | 'document'): void {
    if (this.disabled || this.isSending) {
      return;
    }

    this.isAttachMenuOpen = false;
    const input = this.fileInput?.nativeElement;
    if (!input) {
      return;
    }

    input.accept = kind === 'image'
      ? 'image/*'
      : '.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    input.value = '';
    input.click();
  }

  onFileSelected(event: Event): void {
    if (this.disabled || this.isSending) {
      return;
    }

    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) {
      return;
    }

    this.attachmentError = '';

    if (file.size > MAX_FILE_BYTES) {
      this.attachmentError = 'Arquivo excede 50MB.';
      return;
    }

    if (!this.isAccepted(file)) {
      this.attachmentError = 'Tipo de arquivo não suportado.';
      return;
    }

    this.clearPreview();
    this.selectedFile = file;

    if (file.type.startsWith('image/')) {
      this.filePreviewUrl = URL.createObjectURL(file);
    }
  }

  clearAttachment(): void {
    if (this.disabled || this.isSending) {
      return;
    }
    this.clearAttachmentInternal();
  }

  onSubmit(): void {
    if (this.disabled || this.isSending) {
      return;
    }

    if (this.selectedFile) {
      const file = this.selectedFile;
      const caption = this.draftText.trim();
      this.sendMedia.emit({ file, caption });
      return;
    }

    const text = this.draftText.trim();
    if (!text) {
      return;
    }

    this.sendText.emit(text);
  }

  resetAfterSend(): void {
    this.draftText = '';
    this.draftTextChange.emit('');
    this.clearAttachmentInternal();
    this.focus();
  }

  get hasContent(): boolean {
    return Boolean(this.selectedFile) || this.draftText.trim().length > 0;
  }

  get fileSizeLabel(): string {
    if (!this.selectedFile) {
      return '';
    }
    const mb = this.selectedFile.size / (1024 * 1024);
    if (mb >= 1) {
      return `${mb.toFixed(1)} MB`;
    }
    const kb = this.selectedFile.size / 1024;
    return `${kb.toFixed(0)} KB`;
  }

  private isAccepted(file: File): boolean {
    if (ACCEPTED_MIME_PREFIXES.some(prefix => file.type.startsWith(prefix))) {
      return true;
    }
    const name = file.name.toLowerCase();
    return ACCEPTED_DOC_EXTENSIONS.some(ext => name.endsWith(ext));
  }

  private clearAttachmentInternal(): void {
    this.clearPreview();
    this.selectedFile = null;
    this.attachmentError = '';
    if (this.fileInput?.nativeElement) {
      this.fileInput.nativeElement.value = '';
    }
  }

  private clearPreview(): void {
    if (this.filePreviewUrl) {
      URL.revokeObjectURL(this.filePreviewUrl);
      this.filePreviewUrl = null;
    }
  }
}
