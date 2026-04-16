import { TestBed } from '@angular/core/testing';
import { PendingBulkSendService } from './pending-bulk-send.service';
import { Cliente } from '../models/cliente.model';

function makeCliente(): Cliente {
  return { id: 1, nome: 'A', cpf: '', telefone: '', dataCadastro: '', dataNascimento: '', birthdayStatus: 'none' };
}

describe('PendingBulkSendService', () => {
  let service: PendingBulkSendService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PendingBulkSendService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('consume returns null when nothing was set', () => {
    expect(service.consume()).toBeNull();
  });

  it('set then consume returns the pending bulk', () => {
    const payload = { templateType: 'birthday' as const, clientes: [makeCliente()] };
    service.set(payload);
    const result = service.consume();
    expect(result).toEqual(payload);
  });

  it('consume clears the stored value (one-shot)', () => {
    service.set({ templateType: 'review', clientes: [makeCliente()] });
    service.consume();
    expect(service.consume()).toBeNull();
  });

  it('second set overwrites previous', () => {
    service.set({ templateType: 'birthday', clientes: [] });
    service.set({ templateType: 'review', clientes: [makeCliente()] });
    const result = service.consume();
    expect(result?.templateType).toBe('review');
  });
});
