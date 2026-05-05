import { Component, ElementRef, EventEmitter, HostListener, Input, OnChanges, OnDestroy, Output, SimpleChanges } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { AppLabel, SUGGESTED_LABEL_COLORS } from '../../../../models/app-label.model';
import { WhatsappContact, WhatsappLabel } from '../../../../models/whatsapp.model';
import { LabelService } from '../../../../services/label.service';
import { ContactLabelDisplayItem, resolveAppLabelDisplayItems, resolveWhatsappContactLabelDisplayItems } from '../../helpers/contact-label-display.helper';

interface PopoverLabelItem extends ContactLabelDisplayItem {
  interactive: boolean;
  selected: boolean;
}

@Component({
  selector: 'app-label-picker-popover',
  templateUrl: './label-picker-popover.component.html',
  styleUrls: ['./label-picker-popover.component.scss']
})
export class LabelPickerPopoverComponent implements OnChanges, OnDestroy {
  @Input() isOpen = false;
  @Input() jid: string | null = null;
  @Input() contact: WhatsappContact | null = null;
  @Input() whatsappLabels: WhatsappLabel[] = [];
  @Output() close = new EventEmitter<void>();
  @Output() manage = new EventEmitter<void>();

  labels: AppLabel[] = [];
  selectedIds = new Set<string>();
  searchTerm = '';
  isCreating = false;
  newLabelName = '';
  newLabelColor = SUGGESTED_LABEL_COLORS[0];
  readonly suggestedColors = SUGGESTED_LABEL_COLORS;
  pendingRemovalLabel: PopoverLabelItem | null = null;

  private readonly destroy$ = new Subject<void>();

  constructor(private labelService: LabelService, private hostRef: ElementRef<HTMLElement>) {
    this.labelService.state$.pipe(takeUntil(this.destroy$)).subscribe(({ labels, assignments }) => {
      this.labels = [...labels].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      this.refreshSelection(assignments);
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['jid'] || changes['isOpen'] || changes['contact'] || changes['whatsappLabels']) {
      this.refreshSelection(this.labelService.assignments);
      if (this.isOpen) {
        this.searchTerm = '';
        this.isCreating = false;
        this.newLabelName = '';
        this.newLabelColor = this.labelService.suggestNextColor();
        this.pendingRemovalLabel = null;
      }
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  get filteredLabels(): PopoverLabelItem[] {
    const term = this.searchTerm.trim().toLowerCase();
    if (!term) {
      return this.displayLabels;
    }
    return this.displayLabels.filter(label => label.name.toLowerCase().includes(term));
  }

  get removeConfirmationText(): string {
    if (!this.pendingRemovalLabel) {
      return '';
    }

    return `Tem certeza que deseja remover a etiqueta ${this.pendingRemovalLabel.name} deste contato?`;
  }

  onLabelClick(label: PopoverLabelItem): void {
    if (!this.jid || !label.interactive || !label.appLabelId || label.selected) {
      return;
    }

    this.labelService.toggleLabelOnJid(this.jid, label.appLabelId);
  }

  requestRemoveLabel(label: PopoverLabelItem, event?: MouseEvent): void {
    event?.stopPropagation();
    if (!label.interactive || !label.selected) {
      return;
    }

    this.pendingRemovalLabel = label;
  }

  closeRemoveDialog(): void {
    this.pendingRemovalLabel = null;
  }

  confirmRemoveLabel(): void {
    if (!this.jid || !this.pendingRemovalLabel?.appLabelId) {
      this.pendingRemovalLabel = null;
      return;
    }

    this.labelService.toggleLabelOnJid(this.jid, this.pendingRemovalLabel.appLabelId);
    this.pendingRemovalLabel = null;
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

    this.pendingRemovalLabel = null;
  }

  private get displayLabels(): PopoverLabelItem[] {
    const appItems = resolveAppLabelDisplayItems(this.labels).map(label => ({
      ...label,
      interactive: true,
      selected: Boolean(label.appLabelId && this.selectedIds.has(label.appLabelId))
    }));
    const whatsappItems = resolveWhatsappContactLabelDisplayItems(this.contact, this.whatsappLabels).map(label => ({
      ...label,
      interactive: false,
      selected: true
    }));

    return [...appItems, ...whatsappItems];
  }

  private refreshSelection(assignments: { [jid: string]: string[] }): void {
    if (!this.jid) {
      this.selectedIds = new Set();
      return;
    }
    this.selectedIds = new Set(assignments[this.jid] || []);
  }
}
