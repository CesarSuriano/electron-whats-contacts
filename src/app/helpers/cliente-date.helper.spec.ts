import { Cliente } from '../models/cliente.model';
import { getBirthdayRowClass, compareClientes } from './cliente-date.helper';

function makeCliente(overrides: Partial<Cliente> = {}): Cliente {
  return {
    id: 1,
    nome: 'Teste',
    cpf: '000.000.000-00',
    telefone: '(11) 99999-9999',
    dataCadastro: '2023-01-01',
    dataNascimento: '1990-06-15',
    birthdayStatus: 'none',
    ...overrides
  };
}

describe('getBirthdayRowClass', () => {
  const RealDate = Date;

  function mockToday(isoDate: string) {
    const fixed = new Date(isoDate + 'T12:00:00');
    spyOn(globalThis, 'Date').and.callFake(function (...args: unknown[]) {
      return args.length === 0 ? fixed : new RealDate(...(args as ConstructorParameters<typeof Date>));
    } as unknown as DateConstructor);
  }

  afterEach(() => {
    if (jasmine.isSpy(globalThis.Date)) {
      (globalThis.Date as unknown as jasmine.Spy).and.callThrough();
    }
  });

  it('returns row-birthday-today when birthday is today', () => {
    const c = makeCliente({ birthdayStatus: 'today' });
    expect(getBirthdayRowClass(c)).toBe('row-birthday-today');
  });

  it('returns row-birthday-upcoming when birthday is within 7 days', () => {
    const c = makeCliente({ birthdayStatus: 'upcoming' });
    expect(getBirthdayRowClass(c)).toBe('row-birthday-upcoming');
  });

  it('returns empty string when birthday is not today or upcoming', () => {
    const c = makeCliente({ birthdayStatus: 'none' });
    expect(getBirthdayRowClass(c)).toBe('');
  });

  it('returns empty string for empty dataNascimento', () => {
    const c = makeCliente({ dataNascimento: '', birthdayStatus: 'none' });
    expect(getBirthdayRowClass(c)).toBe('');
  });
});

describe('compareClientes', () => {
  it('sorts ascending by nome', () => {
    const a = makeCliente({ nome: 'Ana' });
    const b = makeCliente({ nome: 'Bia' });
    expect(compareClientes(a, b, 'nome', 'asc')).toBeLessThan(0);
    expect(compareClientes(b, a, 'nome', 'asc')).toBeGreaterThan(0);
  });

  it('sorts descending by nome', () => {
    const a = makeCliente({ nome: 'Ana' });
    const b = makeCliente({ nome: 'Bia' });
    expect(compareClientes(a, b, 'nome', 'desc')).toBeGreaterThan(0);
  });

  it('sorts by dataNascimento placing birthdays closest to today first when asc', () => {
    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const a = makeCliente({ dataNascimento: `1990-${mm}-${dd}` }); // today
    const b = makeCliente({ dataNascimento: '1990-01-01' });
    // a birthday is today so it should come first (closer)
    const result = compareClientes(a, b, 'dataNascimento', 'asc');
    expect(result).toBeLessThanOrEqual(0);
  });

  it('returns 0 for equal values', () => {
    const a = makeCliente({ nome: 'Ana' });
    const b = makeCliente({ nome: 'Ana' });
    expect(compareClientes(a, b, 'nome', 'asc')).toBe(0);
  });
});
