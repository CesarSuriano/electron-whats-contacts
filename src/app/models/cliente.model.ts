export type BirthdayStatus = 'today' | 'upcoming' | 'none';

export interface Cliente {
  id: number;
  nome: string;
  cpf: string;
  telefone: string;
  dataCadastro: string;
  dataNascimento: string;
  birthdayStatus: BirthdayStatus;
}

export type SortColumn = 'nome' | 'cpf' | 'telefone' | 'dataCadastro' | 'dataNascimento';
export type SortDirection = 'asc' | 'desc';

export interface ClientesLoadResult {
  clientes: Cliente[];
  loadedAt: Date;
  fileName: string | null;
}