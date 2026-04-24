import { Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild } from '@angular/core';

import { MessageTemplateService } from '../../services/message-template.service';
import { MessageTemplateEditorConfig, MessageTemplateSaveResult } from '../../models/message-template.model';

type EditorTab = 'edit' | 'preview';

interface TemplateHistoryEntry {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

@Component({
  selector: 'app-message-template-modal',
  templateUrl: './message-template-modal.component.html',
  styleUrls: ['./message-template-modal.component.scss']
})
export class MessageTemplateModalComponent implements OnChanges, OnDestroy {
  @ViewChild('templateTextarea') templateTextarea?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('imageInput') imageInput?: ElementRef<HTMLInputElement>;

  @Input() isOpen = false;
  @Input() isSaving = false;
  @Input() editorConfig: MessageTemplateEditorConfig | null = null;
  @Input() initialTemplate = '';
  @Input() initialImageDataUrl?: string;

  @Output() close = new EventEmitter<void>();
  @Output() save = new EventEmitter<MessageTemplateSaveResult>();

  editableTemplate = '';
  selectedImageDataUrl?: string;
  activeTab: EditorTab = 'edit';
  isEmojiPickerExpanded = false;
  quickAccessEmojis: string[] = [];
  allEmojiOptions: string[] = [];
  readonly defaultQuickAccessEmojis = ['🎉', '🎁', '✨', '🥳', '🛍️', '⭐', '☺️', '🙏'];
  readonly baseEmojiOptions = [
    '🎉', '🎁', '✨', '🥳', '🛍️', '⭐', '☺️', '🙏', '💖', '🎄', '😍', '🤩', '❤️', '😊', '🌟',
    '👏', '💐', '🎈', '💫', '😄', '😎', '🤍', '💌', '🫶', '🌹', '🍀', '🔥', '🥰', '🎊', '🍾'
  ];

  private history: TemplateHistoryEntry[] = [];
  private historyIndex = -1;
  private isRestoringHistory = false;
  private pendingHistoryEntry: TemplateHistoryEntry | null = null;
  private historyCommitTimer: number | null = null;

  constructor(private messageTemplateService: MessageTemplateService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['initialTemplate'] || changes['isOpen']) {
      this.resetEditorState();
    }
  }

  ngOnDestroy(): void {
    this.clearPendingHistoryCommit();
  }

  get canUndo(): boolean {
    return this.historyIndex > 0;
  }

  get canRedo(): boolean {
    return this.historyIndex >= 0 && this.historyIndex < this.history.length - 1;
  }

  get previewHtml(): string {
    return this.renderPreview(this.editableTemplate);
  }

  get additionalEmojiOptions(): string[] {
    return this.allEmojiOptions.filter(emoji => !this.quickAccessEmojis.includes(emoji));
  }

  applyBold(): void {
    this.wrapSelection('*', '*');
  }

  applyItalic(): void {
    this.wrapSelection('_', '_');
  }

  insertNameToken(): void {
    this.insertText('{nome}');
  }

  insertLineBreak(): void {
    this.insertText('\\n');
  }

  insertEmoji(emoji: string): void {
    this.messageTemplateService.registerEmojiUsage(emoji);
    this.insertText(emoji);
  }

  addCustomEmoji(): void {
    const customEmoji = window.prompt('Digite o emoji que deseja adicionar aos seus atalhos:', '😊');
    if (!customEmoji || !customEmoji.trim()) {
      return;
    }

    const normalizedEmoji = customEmoji.trim();
    this.messageTemplateService.saveCustomEmoji(normalizedEmoji);
    this.messageTemplateService.registerEmojiUsage(normalizedEmoji);
    this.insertText(normalizedEmoji);
  }

  selectTab(tab: EditorTab): void {
    this.activeTab = tab;

    if (tab === 'edit') {
      requestAnimationFrame(() => {
        this.templateTextarea?.nativeElement.focus();
      });
    }
  }

  toggleEmojiPicker(): void {
    this.isEmojiPickerExpanded = !this.isEmojiPickerExpanded;
  }

  onTemplateInput(): void {
    const textarea = this.templateTextarea?.nativeElement;
    if (!textarea || this.isRestoringHistory) {
      return;
    }

    this.scheduleHistorySnapshot({
      value: this.editableTemplate,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd
    });
  }

  onTextareaKeydown(event: KeyboardEvent): void {
    const isUndoShortcut = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z';
    const isRedoShortcut =
      (event.ctrlKey || event.metaKey) &&
      ((event.shiftKey && event.key.toLowerCase() === 'z') || event.key.toLowerCase() === 'y');

    if (isUndoShortcut) {
      event.preventDefault();
      this.undo();
      return;
    }

    if (isRedoShortcut) {
      event.preventDefault();
      this.redo();
    }
  }

  undo(): void {
    this.flushPendingHistorySnapshot();
    if (!this.canUndo) {
      return;
    }

    this.historyIndex -= 1;
    this.restoreHistoryEntry(this.history[this.historyIndex]);
  }

  redo(): void {
    this.flushPendingHistorySnapshot();
    if (!this.canRedo) {
      return;
    }

    this.historyIndex += 1;
    this.restoreHistoryEntry(this.history[this.historyIndex]);
  }

  chooseImage(): void {
    this.imageInput?.nativeElement.click();
  }

  onImageSelected(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) {
      return;
    }

    if (file.size > 3 * 1024 * 1024) {
      window.alert('A imagem deve ter no máximo 3 MB.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      this.selectedImageDataUrl = reader.result as string;
    };
    reader.readAsDataURL(file);

    if (this.imageInput?.nativeElement) {
      this.imageInput.nativeElement.value = '';
    }
  }

  clearImage(): void {
    this.selectedImageDataUrl = undefined;
    if (this.imageInput?.nativeElement) {
      this.imageInput.nativeElement.value = '';
    }
  }

  saveTemplate(): void {
    this.flushPendingHistorySnapshot();
    this.save.emit({ text: this.editableTemplate, imageDataUrl: this.selectedImageDataUrl });
  }

  private wrapSelection(prefix: string, suffix: string): void {
    const textarea = this.templateTextarea?.nativeElement;
    if (!textarea) {
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const rawSelected = this.editableTemplate.slice(start, end);
    const leadingSpaces = rawSelected.length - rawSelected.trimStart().length;
    const trailingSpaces = rawSelected.length - rawSelected.trimEnd().length;
    const inner = rawSelected.trim() || 'texto';
    const replacement = `${' '.repeat(leadingSpaces)}${prefix}${inner}${suffix}${' '.repeat(trailingSpaces)}`;
    const adjustedStart = start + leadingSpaces;

    this.replaceRange(start, end, replacement, leadingSpaces + prefix.length, suffix.length + trailingSpaces, rawSelected.trim().length > 0);
  }

  private insertText(text: string): void {
    const textarea = this.templateTextarea?.nativeElement;
    if (!textarea) {
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    this.replaceRange(start, end, text, text.length, 0, false);
  }

  private replaceRange(
    start: number,
    end: number,
    replacement: string,
    selectionStartOffset: number,
    selectionEndOffset: number,
    preserveSelection: boolean
  ): void {
    const textarea = this.templateTextarea?.nativeElement;
    if (!textarea) {
      return;
    }

    this.flushPendingHistorySnapshot();

    this.editableTemplate =
      this.editableTemplate.slice(0, start) +
      replacement +
      this.editableTemplate.slice(end);

    requestAnimationFrame(() => {
      textarea.focus();
      const nextStart = preserveSelection ? start + selectionStartOffset : start + selectionStartOffset;
      const nextEnd = preserveSelection
        ? start + replacement.length - selectionEndOffset
        : start + replacement.length;
      textarea.setSelectionRange(nextStart, nextEnd);
      this.pushHistorySnapshot({
        value: this.editableTemplate,
        selectionStart: nextStart,
        selectionEnd: nextEnd
      });
    });
  }

  private resetEditorState(): void {
    if (!this.isOpen) {
      return;
    }

    this.clearPendingHistoryCommit();
    this.editableTemplate = this.initialTemplate;
    this.selectedImageDataUrl = this.initialImageDataUrl;
    this.activeTab = 'edit';
    this.isEmojiPickerExpanded = false;
    this.syncAvailableEmojis();
    this.syncQuickAccessEmojis();
    this.history = [];
    this.historyIndex = -1;
    this.pushHistorySnapshot({
      value: this.editableTemplate,
      selectionStart: this.editableTemplate.length,
      selectionEnd: this.editableTemplate.length
    });
  }

  private syncQuickAccessEmojis(): void {
    this.quickAccessEmojis = this.messageTemplateService.getQuickAccessEmojis(
      this.defaultQuickAccessEmojis,
      this.allEmojiOptions
    );
  }

  private syncAvailableEmojis(): void {
    this.allEmojiOptions = this.messageTemplateService.getAllEmojis(this.baseEmojiOptions);
  }

  private scheduleHistorySnapshot(entry: TemplateHistoryEntry): void {
    this.pendingHistoryEntry = entry;

    if (this.historyCommitTimer !== null) {
      window.clearTimeout(this.historyCommitTimer);
    }

    this.historyCommitTimer = window.setTimeout(() => {
      this.flushPendingHistorySnapshot();
    }, 160);
  }

  private flushPendingHistorySnapshot(): void {
    if (this.historyCommitTimer !== null) {
      window.clearTimeout(this.historyCommitTimer);
      this.historyCommitTimer = null;
    }

    if (!this.pendingHistoryEntry) {
      return;
    }

    this.pushHistorySnapshot(this.pendingHistoryEntry);
    this.pendingHistoryEntry = null;
  }

  private clearPendingHistoryCommit(): void {
    if (this.historyCommitTimer !== null) {
      window.clearTimeout(this.historyCommitTimer);
      this.historyCommitTimer = null;
    }

    this.pendingHistoryEntry = null;
  }

  private pushHistorySnapshot(entry: TemplateHistoryEntry): void {
    const currentEntry = this.history[this.historyIndex];
    if (
      currentEntry &&
      currentEntry.value === entry.value &&
      currentEntry.selectionStart === entry.selectionStart &&
      currentEntry.selectionEnd === entry.selectionEnd
    ) {
      return;
    }

    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(entry);

    if (this.history.length > 100) {
      this.history.shift();
    }

    this.historyIndex = this.history.length - 1;
  }

  private restoreHistoryEntry(entry: TemplateHistoryEntry): void {
    const textarea = this.templateTextarea?.nativeElement;
    this.isRestoringHistory = true;
    this.editableTemplate = entry.value;

    requestAnimationFrame(() => {
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(entry.selectionStart, entry.selectionEnd);
      }

      this.isRestoringHistory = false;
    });
  }

  private renderPreview(template: string): string {
    const escapedTemplate = this.escapeHtml(template)
      .replace(/\{nome\}/g, 'Maria')
      .replace(/\\n/g, '<br>')
      .replace(/\n/g, '<br>');

    return escapedTemplate
      .replace(/\*(.+?)\*/g, '<strong>$1</strong>')
      .replace(/_(.+?)_/g, '<em>$1</em>');
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}