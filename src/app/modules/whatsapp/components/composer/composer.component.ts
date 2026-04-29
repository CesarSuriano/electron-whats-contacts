import { AfterViewInit, Component, ElementRef, EventEmitter, HostListener, Input, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild } from '@angular/core';

import { QuickReply } from '../../../../models/quick-reply.model';
import { ManagerLaunchService } from '../../../../services/manager-launch.service';
import { QuickReplyMenuComponent } from '../quick-reply-menu/quick-reply-menu.component';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ACCEPTED_MIME_PREFIXES = ['image/', 'application/pdf'];
const ACCEPTED_DOC_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv'];
const QUICK_REPLY_TRIGGER_REGEX = /^\/([a-z0-9_-]*)$/i;
const MAX_VISIBLE_TEXTAREA_LINES = 8;
const DEFAULT_TEXTAREA_MIN_HEIGHT_PX = 46;
// Minimum bottom offset for the floating bulk panel (matches default composer height ~92px).
const DEFAULT_BULK_PANEL_CLEARANCE_PX = 92;
// Extra space between the bulk panel's bottom edge and the composer's top edge.
const BULK_PANEL_CLEARANCE_GAP_PX = 20;
const BULK_PANEL_CLEARANCE_VAR = '--uniq-whatsapp-composer-clearance';

const EMOJI_LIST = [
  '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😊',
  '😇', '🥰', '😍', '🤩', '😘', '😗', '😋', '😛', '😜', '🤪',
  '😝', '🤑', '🤗', '🤭', '🫢', '🤫', '🤔', '🫡', '🤐', '🤨',
  '😐', '😑', '😶', '🫥', '😏', '😒', '🙄', '😬', '😮‍💨', '🤥',
  '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮',
  '🥵', '🥶', '😵', '🤯', '🥳', '🥺', '😢', '😭', '😤', '😠',
  '😡', '🤬', '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙',
  '👋', '🤚', '✋', '🖖', '👏', '🙌', '🤝', '🙏', '❤️', '🧡',
  '💛', '💚', '💙', '💜', '🖤', '🤍', '💯', '💢', '💥', '🔥',
  '⭐', '🌟', '✨', '💫', '🎉', '🎊', '🏆', '🥇', '🏅', '🎯'
];

@Component({
  selector: 'app-composer',
  templateUrl: './composer.component.html',
  styleUrls: ['./composer.component.scss']
})
export class ComposerComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() draftText = '';
  @Input() isSending = false;
  @Input() disabled = false;
  @Input() aiEnabled = false;
  @Input() isAiThinking = false;
  @Input() aiSuggestion = '';
  @Input() aiStatusMessage = '';
  @Input() assistantLabel = 'IA';
  @Input() assistantIcon = 'smart_toy';
  @Input() contactName = '';
  @Output() draftTextChange = new EventEmitter<string>();
  @Output() acceptAiSuggestion = new EventEmitter<string>();
  @Output() requestAiSuggestion = new EventEmitter<void>();
  @Output() requestGuidedAiSuggestion = new EventEmitter<string>();
  @Output() rateAiSuggestion = new EventEmitter<'up' | 'down'>();
  @Output() sendText = new EventEmitter<string>();
  @Output() sendMedia = new EventEmitter<{ file: File; caption: string }>();

  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;
  @ViewChild('textarea') textarea?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('aiButton') aiButton?: ElementRef<HTMLButtonElement>;
  @ViewChild('guidedAiTextarea') guidedAiTextarea?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('suggestionAcceptButton') suggestionAcceptButton?: ElementRef<HTMLButtonElement>;
  @ViewChild(QuickReplyMenuComponent) quickReplyMenu?: QuickReplyMenuComponent;

  isEmojiPickerOpen = false;
  isGuidedAiOpen = false;
  guidedAiInstruction = '';
  suggestionFeedback: '' | 'up' | 'down' = '';
  emojiList = EMOJI_LIST;

  isQuickReplyMenuOpen = false;
  quickReplyQuery = '';
  private isQuickReplyForcedOpen = false;
  private layoutFrameId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    private hostElement: ElementRef<HTMLElement>,
    private managerLaunch: ManagerLaunchService
  ) {}

  ngAfterViewInit(): void {
    this.resizeObserver = new ResizeObserver(() => this.syncBulkPanelClearance());
    this.resizeObserver.observe(this.hostElement.nativeElement);
    this.scheduleLayoutSync();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (Object.prototype.hasOwnProperty.call(changes, 'aiSuggestion')) {
      this.suggestionFeedback = '';
    }

    if (
      Object.prototype.hasOwnProperty.call(changes, 'draftText')
      || Object.prototype.hasOwnProperty.call(changes, 'disabled')
      || Object.prototype.hasOwnProperty.call(changes, 'isSending')
      || Object.prototype.hasOwnProperty.call(changes, 'aiSuggestion')
    ) {
      this.scheduleLayoutSync();
    }
  }

  ngOnDestroy(): void {
    if (this.layoutFrameId !== null) {
      window.cancelAnimationFrame(this.layoutFrameId);
      this.layoutFrameId = null;
    }

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.clearBulkPanelClearance();
    this.clearPreview();
  }

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
      this.scheduleLayoutSync();
      this.focus();
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
    this.updateQuickReplyMenuFromText(value);
    this.scheduleLayoutSync();
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.scheduleLayoutSync();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) {
      this.closeTransientPopovers();
      return;
    }

    const path = (event.composedPath && event.composedPath()) || [];
    for (const node of path) {
      if (node instanceof HTMLElement && node.hasAttribute('data-composer-popover-root')) {
        return;
      }
    }

    if (target.closest('[data-composer-popover-root]')) {
      return;
    }

    this.closeTransientPopovers();
  }

  toggleQuickReplyMenu(): void {
    if (this.disabled || this.isSending) {
      return;
    }

    const shouldOpen = !this.isQuickReplyMenuOpen;
    this.closeTransientPopovers(shouldOpen ? 'quickReply' : undefined);

    if (!shouldOpen) {
      return;
    }

    this.isQuickReplyForcedOpen = true;
    this.quickReplyQuery = this.extractQuickReplyQuery(this.draftText);
    this.isQuickReplyMenuOpen = true;
    setTimeout(() => this.focus(), 0);
  }

  closeQuickReplyMenu(): void {
    this.isQuickReplyMenuOpen = false;
    this.isQuickReplyForcedOpen = false;
  }

  onQuickReplyManageRequested(): void {
    this.closeQuickReplyMenu();
    this.managerLaunch.openQuickReplyManager();
  }

  onQuickReplySelected(reply: QuickReply): void {
    const rendered = this.renderQuickReplyContent(reply.content);
    this.draftText = rendered;
    this.draftTextChange.emit(rendered);

    if (reply.imageDataUrl) {
      const ext = this.detectExtensionFromDataUrl(reply.imageDataUrl);
      this.setAttachmentFromDataUrl(reply.imageDataUrl, `mensagem-rapida.${ext}`);
    }

    this.closeQuickReplyMenu();
    setTimeout(() => this.focus(), 0);
  }

  private updateQuickReplyMenuFromText(value: string): void {
    const match = value.match(QUICK_REPLY_TRIGGER_REGEX);
    if (match) {
      this.closeTransientPopovers('quickReply');
      this.quickReplyQuery = match[1] || '';
      this.isQuickReplyMenuOpen = true;
      return;
    }

    if (this.isQuickReplyForcedOpen) {
      this.quickReplyQuery = '';
      return;
    }

    this.isQuickReplyMenuOpen = false;
  }

  private extractQuickReplyQuery(value: string): string {
    const match = value.match(QUICK_REPLY_TRIGGER_REGEX);
    return match ? match[1] : '';
  }

  private renderQuickReplyContent(content: string): string {
    const name = (this.contactName || '').trim();
    return content.replace(/\{nome\}/gi, name);
  }

  private detectExtensionFromDataUrl(dataUrl: string): string {
    const match = dataUrl.match(/^data:image\/([a-zA-Z0-9+]+);/i);
    if (!match) {
      return 'png';
    }
    const sub = match[1].toLowerCase();
    if (sub === 'jpeg' || sub === 'jpg') {
      return 'jpg';
    }
    return sub;
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
        this.scheduleLayoutSync();
        this.focus();
        return;
      }
    }
  }

  onTextareaKeydown(event: KeyboardEvent): void {
    if (this.isQuickReplyMenuOpen) {
      if (event.key === 'ArrowDown') {
        if (this.quickReplyMenu?.moveHighlight(1)) {
          event.preventDefault();
          return;
        }
      } else if (event.key === 'ArrowUp') {
        if (this.quickReplyMenu?.moveHighlight(-1)) {
          event.preventDefault();
          return;
        }
      } else if (event.key === 'Enter' && !event.shiftKey) {
        if (this.quickReplyMenu?.selectHighlighted()) {
          event.preventDefault();
          return;
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.closeQuickReplyMenu();
        return;
      }
    }

    if (event.key === 'Tab' && this.canAcceptAiSuggestion) {
      event.preventDefault();
      this.applyAiSuggestion();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.onSubmit();
    }
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.isGuidedAiOpen) {
      event.preventDefault();
      this.closeGuidedAi();
      return;
    }

    if (event.key !== 'Tab' || !this.canAcceptAiSuggestion) {
      return;
    }

    const activeElement = document.activeElement;
    const textarea = this.textarea?.nativeElement;
    const aiButton = this.aiButton?.nativeElement;
    const suggestionAcceptButton = this.suggestionAcceptButton?.nativeElement;

    if (activeElement !== textarea && activeElement !== aiButton && activeElement !== suggestionAcceptButton) {
      return;
    }

    event.preventDefault();
    this.applyAiSuggestion();
  }

  onAiButtonClick(): void {
    if (this.disabled || this.isSending || !this.aiEnabled) {
      return;
    }

    this.requestAiSuggestion.emit();
  }

  toggleGuidedAi(): void {
    if (!this.canUseGuidedAi) {
      return;
    }

    this.isGuidedAiOpen = !this.isGuidedAiOpen;
    this.scheduleLayoutSync();
    if (this.isGuidedAiOpen) {
      setTimeout(() => this.guidedAiTextarea?.nativeElement.focus(), 0);
      return;
    }

    setTimeout(() => this.focus(), 0);
  }

  closeGuidedAi(restoreComposerFocus = true): void {
    this.isGuidedAiOpen = false;
    this.guidedAiInstruction = '';
    this.scheduleLayoutSync();

    if (restoreComposerFocus) {
      setTimeout(() => this.focus(), 0);
    }
  }

  submitGuidedAi(): void {
    const instruction = this.guidedAiInstruction.trim();
    if (!instruction || !this.canUseGuidedAi) {
      return;
    }

    this.requestGuidedAiSuggestion.emit(instruction);
    this.closeGuidedAi();
  }

  onGuidedAiKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closeGuidedAi();
      return;
    }

    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.submitGuidedAi();
    }
  }

  applyAiSuggestion(): void {
    if (!this.canAcceptAiSuggestion) {
      return;
    }

    this.draftText = this.aiSuggestion.trim();
    this.draftTextChange.emit(this.draftText);
    this.acceptAiSuggestion.emit(this.draftText);
    this.scheduleLayoutSync();
    setTimeout(() => this.focus(), 0);
  }

  submitAiFeedback(rating: 'up' | 'down'): void {
    if (!this.canRateAiSuggestion) {
      return;
    }

    this.suggestionFeedback = rating;
    this.rateAiSuggestion.emit(rating);
  }

  toggleAttachMenu(): void {
    if (this.disabled || this.isSending) {
      return;
    }

    const shouldOpen = !this.isAttachMenuOpen;
    this.closeTransientPopovers(shouldOpen ? 'attach' : undefined);
    this.isAttachMenuOpen = shouldOpen;
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

    this.scheduleLayoutSync();
    this.focus();
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

  toggleEmojiPicker(): void {
    if (this.disabled || this.isSending) return;

    const shouldOpen = !this.isEmojiPickerOpen;
    this.closeTransientPopovers(shouldOpen ? 'emoji' : undefined);
    this.isEmojiPickerOpen = shouldOpen;
    this.scheduleLayoutSync();
  }

  insertEmoji(emoji: string): void {
    const textarea = this.textarea?.nativeElement;
    const start = textarea?.selectionStart ?? this.draftText.length;
    const end = textarea?.selectionEnd ?? start;

    this.draftText = this.draftText.slice(0, start) + emoji + this.draftText.slice(end);
    this.draftTextChange.emit(this.draftText);
    this.isEmojiPickerOpen = false;
    this.scheduleLayoutSync();

    const cursorPos = start + emoji.length;
    requestAnimationFrame(() => {
      const el = this.textarea?.nativeElement;
      if (el) {
        el.focus();
        el.setSelectionRange(cursorPos, cursorPos);
      }
    });
  }

  forceResetAttachment(): void {
    this.clearAttachmentInternal();
  }

  resetAfterSend(): void {
    this.draftText = '';
    this.draftTextChange.emit('');
    this.clearAttachmentInternal();
    this.scheduleLayoutSync();
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

  get canAcceptAiSuggestion(): boolean {
    return Boolean(
      this.aiEnabled
      && this.aiSuggestion.trim()
      && !this.disabled
      && !this.isSending
      && !this.selectedFile
      && !this.draftText.trim()
    );
  }

  get canUseGuidedAi(): boolean {
    return Boolean(this.aiEnabled && !this.disabled && !this.isSending);
  }

  get canRateAiSuggestion(): boolean {
    return Boolean(
      this.aiEnabled
      && this.aiSuggestion.trim()
      && !this.disabled
      && !this.isSending
    );
  }

  get textareaPlaceholder(): string {
    if (this.canAcceptAiSuggestion) {
      return '';
    }

    return this.selectedFile ? 'Adicionar legenda (opcional)' : 'Digite uma mensagem';
  }

  get textareaSizerContent(): string {
    const content = this.canAcceptAiSuggestion ? this.aiSuggestion : this.draftText;
    return `${content || ' '}
`;
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
    this.scheduleLayoutSync();
  }

  private clearPreview(): void {
    if (this.filePreviewUrl) {
      URL.revokeObjectURL(this.filePreviewUrl);
      this.filePreviewUrl = null;
    }
  }

  private closeTransientPopovers(except?: 'emoji' | 'quickReply' | 'attach'): void {
    const emojiWasOpen = this.isEmojiPickerOpen;

    if (except !== 'emoji') {
      this.isEmojiPickerOpen = false;
    }

    if (except !== 'attach') {
      this.isAttachMenuOpen = false;
    }

    if (except !== 'quickReply') {
      this.closeQuickReplyMenu();
    }

    if (emojiWasOpen !== this.isEmojiPickerOpen) {
      this.scheduleLayoutSync();
    }
  }

  private scheduleLayoutSync(): void {
    if (this.layoutFrameId !== null) {
      window.cancelAnimationFrame(this.layoutFrameId);
    }

    this.layoutFrameId = window.requestAnimationFrame(() => {
      this.layoutFrameId = null;
      this.syncTextareaHeight();
    });
  }

  private syncTextareaHeight(): void {
    const textarea = this.textarea?.nativeElement;
    if (!textarea) {
      return;
    }

    const styles = window.getComputedStyle(textarea);
    const lineHeight = parseFloat(styles.lineHeight) || 20;
    const paddingTop = parseFloat(styles.paddingTop) || 0;
    const paddingBottom = parseFloat(styles.paddingBottom) || 0;
    const borderTopWidth = parseFloat(styles.borderTopWidth) || 0;
    const borderBottomWidth = parseFloat(styles.borderBottomWidth) || 0;
    const minHeight = parseFloat(styles.minHeight) || DEFAULT_TEXTAREA_MIN_HEIGHT_PX;
    const maxHeight = Math.round(
      lineHeight * MAX_VISIBLE_TEXTAREA_LINES
      + paddingTop
      + paddingBottom
      + borderTopWidth
      + borderBottomWidth
    );

    textarea.style.height = 'auto';
    const nextHeight = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  private syncBulkPanelClearance(): void {
    const host = this.hostElement.nativeElement;
    const height = host.offsetHeight;
    if (height <= 0) {
      this.clearBulkPanelClearance();
      return;
    }

    const clearance = Math.max(DEFAULT_BULK_PANEL_CLEARANCE_PX, height + BULK_PANEL_CLEARANCE_GAP_PX);
    document.documentElement.style.setProperty(BULK_PANEL_CLEARANCE_VAR, `${clearance}px`);
  }

  private clearBulkPanelClearance(): void {
    document.documentElement.style.removeProperty(BULK_PANEL_CLEARANCE_VAR);
  }
}
