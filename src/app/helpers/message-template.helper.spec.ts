import { Cliente } from '../models/cliente.model';
import {
  DEFAULT_MESSAGE_TEMPLATES,
  MESSAGE_TEMPLATE_EDITOR_CONFIG,
  getFirstName,
  renderMessageTemplate
} from './message-template.helper';

function makeCliente(nome: string): Cliente {
  return { id: 1, nome, cpf: '', telefone: '', dataCadastro: '', dataNascimento: '', birthdayStatus: 'none' };
}

describe('DEFAULT_MESSAGE_TEMPLATES', () => {
  it('contains birthday and review templates', () => {
    expect(DEFAULT_MESSAGE_TEMPLATES.birthday).toBeTruthy();
    expect(DEFAULT_MESSAGE_TEMPLATES.review).toBeTruthy();
  });

  it('birthday template contains {nome} placeholder', () => {
    expect(DEFAULT_MESSAGE_TEMPLATES.birthday).toContain('{nome}');
  });
});

describe('MESSAGE_TEMPLATE_EDITOR_CONFIG', () => {
  it('has config for birthday and review types', () => {
    expect(MESSAGE_TEMPLATE_EDITOR_CONFIG['birthday']).toBeDefined();
    expect(MESSAGE_TEMPLATE_EDITOR_CONFIG['review']).toBeDefined();
  });

  it('birthday config type matches key', () => {
    expect(MESSAGE_TEMPLATE_EDITOR_CONFIG['birthday'].type).toBe('birthday');
  });

  it('review config type matches key', () => {
    expect(MESSAGE_TEMPLATE_EDITOR_CONFIG['review'].type).toBe('review');
  });
});

describe('getFirstName', () => {
  it('returns capitalised first word', () => {
    expect(getFirstName('MARIA SILVA')).toBe('Maria');
  });

  it('returns empty string for empty input', () => {
    expect(getFirstName('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(getFirstName('   ')).toBe('');
  });

  it('handles single-word name', () => {
    expect(getFirstName('joão')).toBe('João');
  });

  it('handles already-capitalised name', () => {
    expect(getFirstName('Pedro Santos')).toBe('Pedro');
  });
});

describe('renderMessageTemplate', () => {
  it('replaces {nome} with first name', () => {
    const result = renderMessageTemplate('Olá, {nome}!', makeCliente('Carlos Lima'));
    expect(result).toBe('Olá, Carlos!');
  });

  it('replaces all occurrences of {nome}', () => {
    const result = renderMessageTemplate('{nome} e {nome}', makeCliente('Ana'));
    expect(result).toBe('Ana e Ana');
  });

  it('uses full trimmed name when first name extraction fails', () => {
    const result = renderMessageTemplate('Olá, {nome}!', makeCliente('  '));
    // getFirstName('  ') returns '', so falls back to cliente.nome.trim() which is ''
    expect(result).toBe('Olá, !');
  });

  it('replaces escaped \\n with actual newline', () => {
    const result = renderMessageTemplate('linha1\\nlinha2', makeCliente('Ana'));
    expect(result).toBe('linha1\nlinha2');
  });

  it('works with template having no placeholders', () => {
    const result = renderMessageTemplate('Sem substitutos', makeCliente('Ana'));
    expect(result).toBe('Sem substitutos');
  });
});
