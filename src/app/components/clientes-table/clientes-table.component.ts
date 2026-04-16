import { Component, EventEmitter, Input, Output } from '@angular/core';

import { Cliente, SortColumn, SortDirection } from '../../models/cliente.model';
import { getBirthdayRowClass } from '../../helpers/cliente-date.helper';

@Component({
  selector: 'app-clientes-table',
  templateUrl: './clientes-table.component.html',
  styleUrls: ['./clientes-table.component.scss']
})
export class ClientesTableComponent {
  @Input() clientes: Cliente[] = [];
  @Input() sortedColumn: SortColumn = 'dataNascimento';
  @Input() sortDirection: SortDirection = 'asc';
  @Input() isYearEndButtonAvailable = false;
  @Input() selectionMode = false;
  @Input() selectedClienteIds = new Set<number>();
  @Input() actionsDisabled = false;

  @Output() sortChange = new EventEmitter<SortColumn>();
  @Output() birthdayClick = new EventEmitter<Cliente>();
  @Output() reviewClick = new EventEmitter<Cliente>();
  @Output() yearEndClick = new EventEmitter<Cliente>();
  @Output() selectionToggle = new EventEmitter<number>();

  requestSort(column: SortColumn): void {
    this.sortChange.emit(column);
  }

  getSortArrow(column: SortColumn): string {
    if (this.sortedColumn !== column) {
      return '';
    }

    return this.sortDirection === 'asc' ? '▲' : '▼';
  }

  getRowClass(cliente: Cliente): string {
    return getBirthdayRowClass(cliente);
  }

  trackByCliente(_: number, cliente: Cliente): number {
    return cliente.id;
  }
}
