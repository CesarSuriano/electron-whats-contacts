import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ClientesTableComponent } from './clientes-table.component';
import { Cliente } from '../../models/cliente.model';
import { CommonModule } from '@angular/common';

function makeCliente(id: number, nome: string): Cliente {
  return { id, nome, cpf: '000', telefone: '(11) 99999-9999', dataCadastro: '2023-01-01', dataNascimento: '1990-06-15', birthdayStatus: 'none' };
}

describe('ClientesTableComponent', () => {
  let component: ClientesTableComponent;
  let fixture: ComponentFixture<ClientesTableComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CommonModule],
      declarations: [ClientesTableComponent]
    }).compileComponents();
    fixture = TestBed.createComponent(ClientesTableComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('getSortArrow returns empty when column is not sorted', () => {
    component.sortedColumn = 'nome';
    expect(component.getSortArrow('cpf')).toBe('');
  });

  it('getSortArrow returns ▲ for asc on sorted column', () => {
    component.sortedColumn = 'nome';
    component.sortDirection = 'asc';
    expect(component.getSortArrow('nome')).toBe('▲');
  });

  it('getSortArrow returns ▼ for desc on sorted column', () => {
    component.sortedColumn = 'nome';
    component.sortDirection = 'desc';
    expect(component.getSortArrow('nome')).toBe('▼');
  });

  it('requestSort emits sortChange', () => {
    spyOn(component.sortChange, 'emit');
    component.requestSort('nome');
    expect(component.sortChange.emit).toHaveBeenCalledWith('nome');
  });

  it('trackByCliente returns cliente id', () => {
    const c = makeCliente(42, 'Test');
    expect(component.trackByCliente(0, c)).toBe(42);
  });

  it('selectionMode defaults to false', () => {
    expect(component.selectionMode).toBeFalse();
  });

  it('actionsDisabled defaults to false', () => {
    expect(component.actionsDisabled).toBeFalse();
  });

  it('selectionToggle emits when row is clicked in selection mode', () => {
    spyOn(component.selectionToggle, 'emit');
    component.selectionMode = true;
    component.clientes = [makeCliente(1, 'Ana')];
    fixture.detectChanges();
    const row = fixture.nativeElement.querySelector('tbody tr') as HTMLElement;
    row.click();
    expect(component.selectionToggle.emit).toHaveBeenCalledWith(1);
  });

  it('renders correct number of rows', () => {
    component.clientes = [makeCliente(1, 'A'), makeCliente(2, 'B'), makeCliente(3, 'C')];
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('tbody tr');
    expect(rows.length).toBe(3);
  });

  it('highlights recent non-birthday clients in green', () => {
    component.clientes = [makeCliente(1, 'Ana')];
    component.recentClienteIds = new Set([1]);

    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('tbody tr') as HTMLElement;
    expect(row.classList.contains('clientes-table__row--recent')).toBeTrue();
  });

  it('keeps birthday highlight ahead of recent highlight', () => {
    component.clientes = [{ ...makeCliente(1, 'Ana'), birthdayStatus: 'today' }];
    component.recentClienteIds = new Set([1]);

    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('tbody tr') as HTMLElement;
    expect(row.classList.contains('clientes-table__row--today')).toBeTrue();
    expect(row.classList.contains('clientes-table__row--recent')).toBeFalse();
  });

  it('preserves the status highlight when a birthday row is selected', () => {
    component.selectionMode = true;
    component.selectedClienteIds = new Set([1]);
    component.clientes = [{ ...makeCliente(1, 'Ana'), birthdayStatus: 'today' }];

    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('tbody tr') as HTMLElement;
    expect(row.classList.contains('clientes-table__row--selected')).toBeTrue();
    expect(row.classList.contains('clientes-table__row--today')).toBeTrue();
  });
});
