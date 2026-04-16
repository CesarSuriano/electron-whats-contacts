import { Cliente } from '../models/cliente.model';
import { buildBirthdayMessage, buildReviewMessage, buildYearEndMessage } from './cliente-message.helper';

function makeCliente(nome: string): Cliente {
  return { id: 1, nome, cpf: '', telefone: '', dataCadastro: '', dataNascimento: '', birthdayStatus: 'none' };
}

describe('buildBirthdayMessage', () => {
  it('uses first name capitalised when full name given', () => {
    const msg = buildBirthdayMessage(makeCliente('MARIA SILVA'));
    expect(msg).toContain('Parabéns, Maria!');
  });

  it('uses single-word name as-is when no spaces', () => {
    const msg = buildBirthdayMessage(makeCliente('João'));
    expect(msg).toContain('Parabéns, João!');
  });

  it('uses full trimmed name when extraction yields empty string', () => {
    // An all-whitespace name after trim is empty; falls back to rawName.trim()
    const msg = buildBirthdayMessage(makeCliente('  '));
    expect(msg).toContain('Parabéns,');
  });

  it('contains discount and validity information', () => {
    const msg = buildBirthdayMessage(makeCliente('Ana'));
    expect(msg).toContain('15% de desconto');
    expect(msg).toContain('7 dias');
  });
});

describe('buildReviewMessage', () => {
  it('includes first name when available', () => {
    const msg = buildReviewMessage(makeCliente('Carlos Santos'));
    expect(msg).toContain('Carlos! Tudo bem?');
  });

  it('falls back gracefully to "Tudo bem?" when name is empty', () => {
    const msg = buildReviewMessage(makeCliente(''));
    expect(msg).toContain('Tudo bem?');
    expect(msg).not.toContain('! Tudo bem?');
  });

  it('contains the Google review link', () => {
    const msg = buildReviewMessage(makeCliente('Ana'));
    expect(msg).toContain('https://g.page/r/');
  });

  it('contains UNIQ STORE branding', () => {
    const msg = buildReviewMessage(makeCliente('Ana'));
    expect(msg).toContain('UNIQ STORE');
  });
});

describe('buildYearEndMessage', () => {
  it('includes first name', () => {
    const msg = buildYearEndMessage(makeCliente('Fernanda Lima'));
    expect(msg).toContain('Fernanda');
  });

  it('contains 2026 reference', () => {
    const msg = buildYearEndMessage(makeCliente('Ana'));
    expect(msg).toContain('2026');
  });

  it('uses full name when first name extraction fails (whitespace only)', () => {
    const msg = buildYearEndMessage(makeCliente('  '));
    expect(msg).toContain('Olá,');
  });
});
