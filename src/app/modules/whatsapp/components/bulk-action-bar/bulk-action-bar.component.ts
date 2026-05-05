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
  /** Mostra o botão "Editar mensagem" — só faz sentido depois que o usuário
   *  já abriu o modal de mensagem em massa pelo menos uma vez. */
  @Input() canEditBulkMessage = false;

  @Output() selectAll = new EventEmitter<void>();
  @Output() clearSelection = new EventEmitter<void>();
  @Output() exitMode = new EventEmitter<void>();
  @Output() openBulkSend = new EventEmitter<void>();
  @Output() openSchedule = new EventEmitter<void>();
  @Output() openLabels = new EventEmitter<void>();
  @Output() editBulkMessage = new EventEmitter<void>();
}
