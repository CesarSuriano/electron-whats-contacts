import { Component, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Output, SimpleChanges } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { AppLabel } from '../../../../models/app-label.model';
import { LabelService } from '../../../../services/label.service';
import { ManagerLaunchService } from '../../../../services/manager-launch.service';

interface BulkLabelRow {
  label: AppLabel;
  count: number;
  state: 'all' | 'some' | 'none';
}

@Component({
  selector: 'app-bulk-label-modal',
  templateUrl: './bulk-label-modal.component.html',
  styleUrls: ['./bulk-label-modal.component.scss']
})
export class BulkLabelModalComponent implements OnInit, OnChanges, OnDestroy {
  @Input() isOpen = false;
  @Input() jids: string[] = [];

  @Output() close = new EventEmitter<void>();

  rows: BulkLabelRow[] = [];

  private readonly destroy$ = new Subject<void>();

  constructor(private labelService: LabelService, private managerLaunch: ManagerLaunchService) {}

  ngOnInit(): void {
    this.labelService.state$.pipe(takeUntil(this.destroy$)).subscribe(() => this.rebuild());
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isOpen'] || changes['jids']) {
      this.rebuild();
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  trackById(_: number, row: BulkLabelRow): string {
    return row.label.id;
  }

  /**
   * One-click toggle:
   * - none -> apply to all selected
   * - some -> apply to all selected (“normalize”)
   * - all  -> remove from all selected
   */
  onRowToggle(row: BulkLabelRow): void {
    if (!this.jids.length) {
      return;
    }
    if (row.state === 'all') {
      this.labelService.applyLabelToJids(row.label.id, this.jids, false);
    } else {
      this.labelService.applyLabelToJids(row.label.id, this.jids, true);
    }
  }

  removeFromAll(row: BulkLabelRow, event: Event): void {
    event.stopPropagation();
    if (!this.jids.length) {
      return;
    }
    this.labelService.applyLabelToJids(row.label.id, this.jids, false);
  }

  openManager(): void {
    this.managerLaunch.openLabelManager();
  }

  private rebuild(): void {
    if (!this.isOpen) {
      this.rows = [];
      return;
    }
    const labels = this.labelService.labels.slice().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    const total = this.jids.length;
    this.rows = labels.map(label => {
      const count = this.labelService.countJidsWithLabel(label.id, this.jids);
      let state: 'all' | 'some' | 'none' = 'none';
      if (count === total && total > 0) {
        state = 'all';
      } else if (count > 0) {
        state = 'some';
      }
      return { label, count, state };
    });
  }
}
