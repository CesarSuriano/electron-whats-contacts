import { Component, ElementRef, EventEmitter, HostListener, Input, OnChanges, OnDestroy, Output, SimpleChanges } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { AppLabel, SUGGESTED_LABEL_COLORS } from '../../../../models/app-label.model';
import { LabelService } from '../../../../services/label.service';

@Component({
  selector: 'app-label-picker-popover',
  templateUrl: './label-picker-popover.component.html',
  styleUrls: ['./label-picker-popover.component.scss']
})
export class LabelPickerPopoverComponent implements OnChanges, OnDestroy {
  @Input() isOpen = false;
  @Input() jid: string | null = null;
  @Output() close = new EventEmitter<void>();
  @Output() manage = new EventEmitter<void>();

  labels: AppLabel[] = [];
  selectedIds = new Set<string>();
  searchTerm = '';
  isCreating = false;
  newLabelName = '';
  newLabelColor = SUGGESTED_LABEL_COLORS[0];
  readonly suggestedColors = SUGGESTED_LABEL_COLORS;

  private readonly destroy$ = new Subject<void>();

  constructor(private labelService: LabelService, private hostRef: ElementRef<HTMLElement>) {
    this.labelService.state$.pipe(takeUntil(this.destroy$)).subscribe(({ labels, assignments }) => {
      this.labels = [...labels].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      this.refreshSelection(assignments);
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['jid'] || changes['isOpen']) {
      this.refreshSelection(this.labelService.assignments);
      if (this.isOpen) {
        this.searchTerm = '';
        this.isCreating = false;
        this.newLabelName = '';
        this.newLabelColor = this.labelService.suggestNextColor();
      }
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  get filteredLabels(): AppLabel[] {
    const term = this.searchTerm.trim().toLowerCase();
    if (!term) {
      return this.labels;
    }
    return this.labels.filter(label => label.name.toLowerCase().includes(term));
  }

  toggleLabel(label: AppLabel): void {
    if (!this.jid) {
      return;
    }
    this.labelService.toggleLabelOnJid(this.jid, label.id);
  }

  isSelected(label: AppLabel): boolean {
    return this.selectedIds.has(label.id);
  }

  startCreate(): void {
    this.isCreating = true;
    this.newLabelName = this.searchTerm.trim();
    this.newLabelColor = this.labelService.suggestNextColor();
  }

  cancelCreate(): void {
    this.isCreating = false;
    this.newLabelName = '';
  }

  confirmCreate(): void {
    const name = this.newLabelName.trim();
    if (!name || !this.jid) {
      return;
    }
    const created = this.labelService.createLabel(name, this.newLabelColor);
    this.labelService.toggleLabelOnJid(this.jid, created.id);
    this.isCreating = false;
    this.newLabelName = '';
    this.searchTerm = '';
  }

  pickColor(color: string): void {
    this.newLabelColor = color;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.isOpen) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }
    // Use composedPath/closest to handle elements that may have been detached
    // by Angular change detection during the same click cycle (e.g. *ngIf swap).
    const path = (event.composedPath && event.composedPath()) || [];
    for (const node of path) {
      if (node instanceof HTMLElement) {
        if (node.hasAttribute && (node.hasAttribute('data-label-popover') || node.hasAttribute('data-label-anchor'))) {
          return;
        }
      }
    }
    if (target.closest && (target.closest('[data-label-popover]') || target.closest('[data-label-anchor]'))) {
      return;
    }
    this.close.emit();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.isOpen) {
      this.close.emit();
    }
  }

  private refreshSelection(assignments: { [jid: string]: string[] }): void {
    if (!this.jid) {
      this.selectedIds = new Set();
      return;
    }
    this.selectedIds = new Set(assignments[this.jid] || []);
  }
}
