import { Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild } from '@angular/core';

import {
  normalizeMessageTemplateForEditing,
  renderMessageTemplateEditorHtml,
  renderMessageTemplatePreviewHtml
} from '../../helpers/message-template.helper';
import { MessageTemplateService } from '../../services/message-template.service';
import { MessageTemplateEditorConfig, MessageTemplateSaveResult } from '../../models/message-template.model';

type EditorTab = 'edit' | 'preview';

interface TemplateHistoryEntry {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

interface EditorSelectionState {
  start: number;
  end: number;
}

@Component({
  selector: 'app-message-template-modal',
  templateUrl: './message-template-modal.component.html',
  styleUrls: ['./message-template-modal.component.scss']
})
export class MessageTemplateModalComponent implements OnChanges, OnDestroy {
  @ViewChild('templateEditor') templateEditor?: ElementRef<HTMLDivElement>;
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
  private isComposing = false;
  private isSyncingEditorDom = false;
  private pendingHistoryEntry: TemplateHistoryEntry | null = null;
  private historyCommitTimer: number | null = null;
  private editorSelection: EditorSelectionState = { start: 0, end: 0 };

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
    return renderMessageTemplatePreviewHtml(this.editableTemplate);
  }

  get additionalEmojiOptions(): string[] {
    return this.allEmojiOptions.filter(emoji => !this.quickAccessEmojis.includes(emoji));
  }

  applyBold(): void {
    this.runEditorCommand(() => this.wrapSelection('*', '*'));
  }

  applyItalic(): void {
    this.runEditorCommand(() => this.wrapSelection('_', '_'));
  }

  insertNameToken(): void {
    this.runEditorCommand(() => this.insertText('{nome}'));
  }

  insertLineBreak(): void {
    this.runEditorCommand(() => this.insertText('\n'));
  }

  insertEmoji(emoji: string): void {
    this.messageTemplateService.registerEmojiUsage(emoji);
    this.runEditorCommand(() => this.insertText(emoji));
  }

  addCustomEmoji(): void {
    const customEmoji = window.prompt('Digite o emoji que deseja adicionar aos seus atalhos:', '😊');
    if (!customEmoji || !customEmoji.trim()) {
      return;
    }

    const normalizedEmoji = customEmoji.trim();
    this.messageTemplateService.saveCustomEmoji(normalizedEmoji);
    this.messageTemplateService.registerEmojiUsage(normalizedEmoji);
    this.runEditorCommand(() => this.insertText(normalizedEmoji));
  }

  selectTab(tab: EditorTab): void {
    this.activeTab = tab;

    if (tab === 'edit') {
      requestAnimationFrame(() => {
        this.syncEditorContent(this.editorSelection, true);
      });
    }
  }

  toggleEmojiPicker(): void {
    this.isEmojiPickerExpanded = !this.isEmojiPickerExpanded;
  }

  onEditorCompositionStart(): void {
    this.isComposing = true;
  }

  onEditorCompositionEnd(): void {
    this.isComposing = false;
    this.onEditorInput();
  }

  onEditorInput(): void {
    const editor = this.templateEditor?.nativeElement;
    if (!editor || this.isRestoringHistory || this.isSyncingEditorDom || this.isComposing) {
      return;
    }

    const selection = this.captureEditorSelection() ?? this.editorSelection;
    this.editableTemplate = this.serializeEditorText(editor, editor);
    this.editorSelection = selection;
    this.syncEditorContent(selection);

    this.scheduleHistorySnapshot({
      value: this.editableTemplate,
      selectionStart: selection.start,
      selectionEnd: selection.end
    });
  }

  onModalKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || !this.isOpen) {
      return;
    }

    const hasPrimaryModifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeModal();
      return;
    }

    if (hasPrimaryModifier && key === 'enter') {
      event.preventDefault();
      this.saveTemplate();
      return;
    }

    if (hasPrimaryModifier && event.shiftKey && key === 'p') {
      event.preventDefault();
      this.selectTab('preview');
      return;
    }

    if (hasPrimaryModifier && event.shiftKey && key === 'e') {
      event.preventDefault();
      this.selectTab('edit');
    }
  }

  onEditorKeydown(event: KeyboardEvent): void {
    const isUndoShortcut = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z';
    const isRedoShortcut =
      (event.ctrlKey || event.metaKey) &&
      ((event.shiftKey && event.key.toLowerCase() === 'z') || event.key.toLowerCase() === 'y');

    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      this.applyBold();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      this.applyItalic();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      this.insertNameToken();
      return;
    }

    if (isUndoShortcut) {
      event.preventDefault();
      this.undo();
      return;
    }

    if (isRedoShortcut) {
      event.preventDefault();
      this.redo();
      return;
    }

    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      this.insertLineBreak();
    }
  }

  onEditorPaste(event: ClipboardEvent): void {
    event.preventDefault();
    const pastedText = event.clipboardData?.getData('text/plain') || '';
    if (!pastedText) {
      return;
    }

    this.runEditorCommand(() => this.insertText(pastedText.replace(/\r\n?/g, '\n')));
  }

  syncSelectionStateFromEditor(): void {
    const selection = this.captureEditorSelection();
    if (selection) {
      this.editorSelection = selection;
    }
  }

  preserveEditorSelection(event: MouseEvent): void {
    if (this.activeTab !== 'edit') {
      return;
    }

    event.preventDefault();
    this.templateEditor?.nativeElement.focus();
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

  closeModal(): void {
    this.close.emit();
  }

  saveTemplate(): void {
    if (this.isSaving) {
      return;
    }

    this.flushPendingHistorySnapshot();
    this.save.emit({ text: this.editableTemplate, imageDataUrl: this.selectedImageDataUrl });
  }

  private wrapSelection(prefix: string, suffix: string): void {
    const { start, end } = this.getCurrentSelection();
    const rawSelected = this.editableTemplate.slice(start, end);
    const leadingSpaces = rawSelected.length - rawSelected.trimStart().length;
    const trailingSpaces = rawSelected.length - rawSelected.trimEnd().length;
    const inner = rawSelected.trim() || 'texto';
    const replacement = `${' '.repeat(leadingSpaces)}${prefix}${inner}${suffix}${' '.repeat(trailingSpaces)}`;

    this.replaceRange(start, end, replacement, leadingSpaces + prefix.length, suffix.length + trailingSpaces, rawSelected.trim().length > 0);
  }

  private insertText(text: string): void {
    const { start, end } = this.getCurrentSelection();
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
    this.flushPendingHistorySnapshot();

    this.editableTemplate =
      this.editableTemplate.slice(0, start) +
      replacement +
      this.editableTemplate.slice(end);

    const nextStart = preserveSelection ? start + selectionStartOffset : start + selectionStartOffset;
    const nextEnd = preserveSelection
      ? start + replacement.length - selectionEndOffset
      : start + replacement.length;

    this.editorSelection = { start: nextStart, end: nextEnd };

    requestAnimationFrame(() => {
      this.syncEditorContent(this.editorSelection, true);
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
    this.editableTemplate = normalizeMessageTemplateForEditing(this.initialTemplate);
    this.selectedImageDataUrl = this.initialImageDataUrl;
    this.activeTab = 'edit';
    this.isEmojiPickerExpanded = false;
    this.syncAvailableEmojis();
    this.syncQuickAccessEmojis();
    this.history = [];
    this.historyIndex = -1;
    this.editorSelection = {
      start: this.editableTemplate.length,
      end: this.editableTemplate.length
    };
    this.pushHistorySnapshot({
      value: this.editableTemplate,
      selectionStart: this.editableTemplate.length,
      selectionEnd: this.editableTemplate.length
    });

    requestAnimationFrame(() => {
      this.syncEditorContent(this.editorSelection, true);
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
    this.isRestoringHistory = true;
    this.editableTemplate = entry.value;
    this.editorSelection = {
      start: entry.selectionStart,
      end: entry.selectionEnd
    };

    requestAnimationFrame(() => {
      this.syncEditorContent(this.editorSelection, true);
      this.isRestoringHistory = false;
    });
  }

  private runEditorCommand(command: () => void): void {
    if (this.activeTab !== 'edit') {
      this.activeTab = 'edit';
      requestAnimationFrame(() => {
        this.syncEditorContent(this.editorSelection, true);
        command();
      });
      return;
    }

    command();
  }

  private getCurrentSelection(): EditorSelectionState {
    const selection = this.captureEditorSelection();
    if (selection) {
      this.editorSelection = selection;
      return selection;
    }

    return this.editorSelection;
  }

  private captureEditorSelection(): EditorSelectionState | null {
    const editor = this.templateEditor?.nativeElement;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) {
      return null;
    }

    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
      return null;
    }

    return {
      start: this.measureOffsetFromEditorStart(editor, range.startContainer, range.startOffset),
      end: this.measureOffsetFromEditorStart(editor, range.endContainer, range.endOffset)
    };
  }

  private measureOffsetFromEditorStart(editor: HTMLDivElement, container: Node, offset: number): number {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.setEnd(container, offset);
    return range.toString().length;
  }

  private syncEditorContent(selection = this.editorSelection, shouldFocus = false): void {
    const editor = this.templateEditor?.nativeElement;
    if (!editor) {
      return;
    }

    const clampedSelection = this.clampSelection(selection);
    this.isSyncingEditorDom = true;
    editor.innerHTML = renderMessageTemplateEditorHtml(this.editableTemplate);

    if (shouldFocus) {
      editor.focus();
    }

    this.setEditorSelection(clampedSelection);
    this.isSyncingEditorDom = false;
  }

  private clampSelection(selection: EditorSelectionState): EditorSelectionState {
    const maxOffset = this.editableTemplate.length;
    const start = Math.max(0, Math.min(selection.start, maxOffset));
    const end = Math.max(start, Math.min(selection.end, maxOffset));
    return { start, end };
  }

  private setEditorSelection(selection: EditorSelectionState): void {
    const editor = this.templateEditor?.nativeElement;
    const browserSelection = window.getSelection();
    if (!editor || !browserSelection) {
      return;
    }

    const startPoint = this.findTextNodePosition(editor, selection.start);
    const endPoint = this.findTextNodePosition(editor, selection.end);
    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    browserSelection.removeAllRanges();
    browserSelection.addRange(range);
    this.editorSelection = selection;
  }

  private findTextNodePosition(editor: HTMLDivElement, targetOffset: number): { node: Node; offset: number } {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let remaining = Math.max(0, targetOffset);
    let lastNode: Node | null = null;

    while (walker.nextNode()) {
      const currentNode = walker.currentNode;
      const length = currentNode.textContent?.length ?? 0;
      lastNode = currentNode;

      if (remaining <= length) {
        return { node: currentNode, offset: remaining };
      }

      remaining -= length;
    }

    if (lastNode) {
      return {
        node: lastNode,
        offset: lastNode.textContent?.length ?? 0
      };
    }

    return { node: editor, offset: 0 };
  }

  private serializeEditorText(node: Node, editorRoot: HTMLDivElement): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent || '').replace(/\u00a0/g, ' ');
    }

    if (!(node instanceof HTMLElement)) {
      return '';
    }

    if (node.tagName === 'BR') {
      return '\n';
    }

    const childText = Array.from(node.childNodes)
      .map(childNode => this.serializeEditorText(childNode, editorRoot))
      .join('');

    if (node !== editorRoot && ['DIV', 'P', 'LI'].includes(node.tagName) && node.nextSibling && !childText.endsWith('\n')) {
      return `${childText}\n`;
    }

    return childText;
  }
}
