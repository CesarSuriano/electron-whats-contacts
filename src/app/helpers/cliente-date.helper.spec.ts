import { Cliente } from '../models/cliente.model';
import {
  buildRecentClienteIdSet,
  calculateBirthdayStatus,
  compareClientes,
  daysUntilNextBirthday,
  getBirthdayRowClass,
  parseClienteDate
} from './cliente-date.helper';

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

describe('birthday date calculations', () => {
  it('parses cliente dates in Brazilian and ISO formats', () => {
    expect(parseClienteDate('25/04/2026')?.getTime()).toBe(new Date(2026, 3, 25).getTime());
    expect(parseClienteDate('2026-04-25')?.getTime()).toBe(new Date(2026, 3, 25).getTime());
  });

  it('keeps tomorrow as 1 day away even late at night', () => {
    const reference = new Date(2026, 3, 25, 23, 59, 59);

    expect(daysUntilNextBirthday('1990-04-26', reference)).toBe(1);
    expect(calculateBirthdayStatus('1990-04-26', reference)).toBe('upcoming');
  });

  it('recognizes today correctly regardless of hour', () => {
    const reference = new Date(2026, 3, 25, 23, 59, 59);

    expect(daysUntilNextBirthday('1990-04-25', reference)).toBe(0);
    expect(calculateBirthdayStatus('1990-04-25', reference)).toBe('today');
  });
});

describe('compareClientes', () => {
  const RealDate = Date;

  afterEach(() => {
    if (jasmine.isSpy(globalThis.Date)) {
      (globalThis.Date as unknown as jasmine.Spy).and.callThrough();
    }
  });

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

  it('keeps birthdays from tomorrow after today even near midnight', () => {
    const fixedNow = new RealDate(2026, 3, 25, 23, 59, 59);
    spyOn(globalThis, 'Date').and.callFake(function (...args: unknown[]) {
      if (args.length === 0) {
        return new RealDate(fixedNow.getTime());
      }

      return new RealDate(...(args as ConstructorParameters<typeof Date>));
    } as unknown as DateConstructor);

    const todayBirthday = makeCliente({ dataNascimento: '1990-04-25' });
    const tomorrowBirthday = makeCliente({ dataNascimento: '1990-04-26' });

    expect(compareClientes(todayBirthday, tomorrowBirthday, 'dataNascimento', 'asc')).toBeLessThan(0);
  });

  it('returns 0 for equal values', () => {
    const a = makeCliente({ nome: 'Ana' });
    const b = makeCliente({ nome: 'Ana' });
    expect(compareClientes(a, b, 'nome', 'asc')).toBe(0);
  });

  it('sorts by dataCadastro placing the most recent clients first when desc', () => {
    const recent = makeCliente({ dataCadastro: '2026-04-25' });
    const older = makeCliente({ dataCadastro: '2026-04-20' });

    expect(compareClientes(recent, older, 'dataCadastro', 'desc')).toBeLessThan(0);
  });
});

describe('buildRecentClienteIdSet', () => {
  it('returns all clients registered on the most recent day', () => {
    const clientes = [
      makeCliente({ id: 1, dataCadastro: '2026-04-24' }),
      makeCliente({ id: 2, dataCadastro: '25/04/2026' }),
      makeCliente({ id: 3, dataCadastro: '2026-04-25' })
    ];

    expect(buildRecentClienteIdSet(clientes)).toEqual(new Set([2, 3]));
  });
});
