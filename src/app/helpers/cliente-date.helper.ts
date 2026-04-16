import { BirthdayStatus, Cliente, SortColumn, SortDirection } from '../models/cliente.model';

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function parseBrazilianDate(dateString: string): Date | null {
  if (!dateString) {
    return null;
  }

  const parts = dateString.split('/');
  if (parts.length !== 3) {
    return null;
  }

  const [dayStr, monthStr, yearStr] = parts;
  const day = Number(dayStr);
  const month = Number(monthStr) - 1;
  const year = Number(yearStr);

  if (isNaN(day) || isNaN(month) || isNaN(year)) {
    return null;
  }

  return new Date(year, month, day);
}

export function daysUntilNextBirthday(dateString: string, reference: Date): number | null {
  let birthDate = parseBrazilianDate(dateString);

  if (!birthDate && dateString && /^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    const [year, month, day] = dateString.split('-').map(Number);
    birthDate = new Date(year, month - 1, day);
  }

  if (!birthDate) {
    return null;
  }

  const currentYear = reference.getFullYear();
  const nextBirthday = new Date(currentYear, birthDate.getMonth(), birthDate.getDate());

  if (isSameDay(nextBirthday, reference)) {
    return 0;
  }

  if (nextBirthday < reference) {
    nextBirthday.setFullYear(currentYear + 1);
  }

  const diffMs = nextBirthday.getTime() - reference.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

export function calculateBirthdayStatus(dataNascimento: string, today: Date): BirthdayStatus {
  const diffDays = daysUntilNextBirthday(dataNascimento, today);

  if (diffDays === null) {
    return 'none';
  }

  if (diffDays === 0) {
    return 'today';
  }

  if (diffDays > 0 && diffDays <= 7) {
    return 'upcoming';
  }

  return 'none';
}

export function compareClientes(
  a: Cliente,
  b: Cliente,
  sortedColumn: SortColumn,
  sortDirection: SortDirection
): number {
  let result = 0;

  switch (sortedColumn) {
    case 'nome':
      result = a.nome.localeCompare(b.nome, 'pt-BR');
      break;
    case 'cpf':
      result = a.cpf.localeCompare(b.cpf, 'pt-BR');
      break;
    case 'telefone':
      result = a.telefone.localeCompare(b.telefone, 'pt-BR');
      break;
    case 'dataCadastro': {
      const dateA = parseBrazilianDate(a.dataCadastro) ?? new Date(0);
      const dateB = parseBrazilianDate(b.dataCadastro) ?? new Date(0);
      result = dateA.getTime() - dateB.getTime();
      break;
    }
    case 'dataNascimento': {
      const today = new Date();
      const daysA = daysUntilNextBirthday(a.dataNascimento, today);
      const daysB = daysUntilNextBirthday(b.dataNascimento, today);
      const safeA = daysA === null ? Number.MAX_SAFE_INTEGER : daysA;
      const safeB = daysB === null ? Number.MAX_SAFE_INTEGER : daysB;
      result = safeA - safeB;
      break;
    }
  }

  return sortDirection === 'asc' ? result : -result;
}

export function getBirthdayRowClass(cliente: Cliente): string {
  if (cliente.birthdayStatus === 'today') {
    return 'row-birthday-today';
  }

  if (cliente.birthdayStatus === 'upcoming') {
    return 'row-birthday-upcoming';
  }

  return '';
}
