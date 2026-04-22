import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { AppLabel, SUGGESTED_LABEL_COLORS } from '../../models/app-label.model';
import { LabelService } from '../../services/label.service';

@Component({
  selector: 'app-label-manager-modal',
  templateUrl: './label-manager-modal.component.html',
  styleUrls: ['./label-manager-modal.component.scss']
})
export class LabelManagerModalComponent implements OnInit, OnDestroy {
  @Input() isOpen = false;
  @Output() close = new EventEmitter<void>();

  labels: AppLabel[] = [];
  usageCounts = new Map<string, number>();
  newName = '';
  newColor = SUGGESTED_LABEL_COLORS[0];
  errorMessage = '';
  readonly suggestedColors = SUGGESTED_LABEL_COLORS;

  private readonly destroy$ = new Subject<void>();

  constructor(private labelService: LabelService) {}

  ngOnInit(): void {
    this.labelService.state$.pipe(takeUntil(this.destroy$)).subscribe(({ labels, assignments }) => {
      this.labels = [...labels].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      this.newColor = this.labelService.suggestNextColor();

      const counts = new Map<string, number>();
      Object.values(assignments).forEach(ids => {
        ids.forEach(id => counts.set(id, (counts.get(id) || 0) + 1));
      });
      this.usageCounts = counts;
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  pickColor(color: string): void {
    this.newColor = color;
  }

  create(): void {
    const name = this.newName.trim();
    if (!name) {
      this.errorMessage = 'Informe um nome para a etiqueta.';
      return;
    }
    this.labelService.createLabel(name, this.newColor);
    this.newName = '';
    this.errorMessage = '';
  }

  rename(label: AppLabel, value: string): void {
    const next = value.trim();
    if (!next || next === label.name) {
      return;
    }
    this.labelService.updateLabel(label.id, { name: next });
  }

  changeColor(label: AppLabel, color: string): void {
    this.labelService.updateLabel(label.id, { color });
  }

  remove(label: AppLabel): void {
    const usage = this.usageCounts.get(label.id) || 0;
    const message = usage > 0
      ? `Excluir a etiqueta "${label.name}"? Ela será removida de ${usage} contato(s).`
      : `Excluir a etiqueta "${label.name}"?`;
    if (!window.confirm(message)) {
      return;
    }
    this.labelService.removeLabel(label.id);
  }

  usageOf(label: AppLabel): number {
    return this.usageCounts.get(label.id) || 0;
  }

  trackById(_: number, label: AppLabel): string {
    return label.id;
  }
}
