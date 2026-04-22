import { Component, ElementRef, EventEmitter, HostListener, Input, OnChanges, Output, SimpleChanges, ViewChild } from '@angular/core';

import { QuickReply } from '../../../../models/quick-reply.model';
import { QuickReplyService } from '../../../../services/quick-reply.service';

@Component({
  selector: 'app-quick-reply-menu',
  templateUrl: './quick-reply-menu.component.html',
  styleUrls: ['./quick-reply-menu.component.scss']
})
export class QuickReplyMenuComponent implements OnChanges {
  @Input() isOpen = false;
  @Input() query = '';
  @Input() contactName = '';

  @Output() select = new EventEmitter<QuickReply>();
  @Output() close = new EventEmitter<void>();
  @Output() manage = new EventEmitter<void>();

  @ViewChild('listEl') listEl?: ElementRef<HTMLUListElement>;

  results: QuickReply[] = [];
  highlightedIndex = 0;

  constructor(private quickReplies: QuickReplyService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['query'] || changes['isOpen']) {
      this.refreshResults();
    }
  }

  refreshResults(): void {
    this.results = this.quickReplies.search(this.query);
    if (this.highlightedIndex >= this.results.length) {
      this.highlightedIndex = 0;
    }
  }

  moveHighlight(delta: number): boolean {
    if (!this.results.length) {
      return false;
    }
    const next = (this.highlightedIndex + delta + this.results.length) % this.results.length;
    this.highlightedIndex = next;
    this.scrollHighlightedIntoView();
    return true;
  }

  selectHighlighted(): boolean {
    const item = this.results[this.highlightedIndex];
    if (!item) {
      return false;
    }
    this.select.emit(item);
    return true;
  }

  selectAt(index: number): void {
    const item = this.results[index];
    if (item) {
      this.highlightedIndex = index;
      this.select.emit(item);
    }
  }

  renderPreview(content: string): string {
    if (!content) {
      return '';
    }
    const name = (this.contactName || '').trim();
    return content.replace(/\{nome\}/gi, name || '{nome}');
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.isOpen) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest('.quick-reply-menu') || target?.closest('[data-quick-reply-anchor]')) {
      return;
    }
    this.close.emit();
  }

  private scrollHighlightedIntoView(): void {
    const el = this.listEl?.nativeElement;
    if (!el) {
      return;
    }
    const item = el.querySelectorAll('li')[this.highlightedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }
}
