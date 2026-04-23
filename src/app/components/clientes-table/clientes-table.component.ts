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
  @Input() selectionMode = false;
  @Input() selectedClienteIds = new Set<number>();
  @Input() actionsDisabled = false;

  @Output() sortChange = new EventEmitter<SortColumn>();
  @Output() birthdayClick = new EventEmitter<Cliente>();
  @Output() reviewClick = new EventEmitter<Cliente>();
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

  getInitials(name: string): string {
    return name
      .split(' ')
      .map(token => token.trim())
      .filter(Boolean)
      .slice(0, 2)
      .map(token => token[0]?.toUpperCase() ?? '')
      .join('');
  }

  getBirthdayLabel(cliente: Cliente): string {
    if (cliente.birthdayStatus === 'today') {
      return 'Aniversário hoje';
    }

    if (cliente.birthdayStatus === 'upcoming') {
      return 'Próximos 7 dias';
    }

    return 'Cadastro ativo';
  }

  trackByCliente(_: number, cliente: Cliente): number {
    return cliente.id;
  }
}
