import { Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'app-bulk-action-bar',
  templateUrl: './bulk-action-bar.component.html',
  styleUrls: ['./bulk-action-bar.component.scss']
})
export class BulkActionBarComponent {
  @Input() selectedCount = 0;
  @Input() totalVisible = 0;
  @Input() allSelected = false;
  @Input() disabled = false;

  @Output() selectAll = new EventEmitter<void>();
  @Output() clearSelection = new EventEmitter<void>();
  @Output() exitMode = new EventEmitter<void>();
  @Output() openBulkSend = new EventEmitter<void>();
  @Output() openSchedule = new EventEmitter<void>();
}
