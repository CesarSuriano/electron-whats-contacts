import { renderBulkTemplate } from './bulk-message.helper';

describe('renderBulkTemplate', () => {
  it('replaces {nome} with capitalised first name', () => {
    const result = renderBulkTemplate('Olá, {nome}!', 'CARLOS SANTOS');
    expect(result).toBe('Olá, Carlos!');
  });

  it('replaces all occurrences of {nome}', () => {
    const result = renderBulkTemplate('{nome} e {nome}', 'Ana Lima');
    expect(result).toBe('Ana e Ana');
  });

  it('uses full trimmed name as replacement when name is single-word', () => {
    const result = renderBulkTemplate('Oi {nome}!', 'Fernanda');
    expect(result).toBe('Oi Fernanda!');
  });

  it('uses trimmed contactName when first name extraction results in empty string', () => {
    // Whitespace-only name: getFirstName returns '', falls back to contactName.trim() which is ''
    const result = renderBulkTemplate('Oi {nome}', '  ');
    expect(result).toBe('Oi ');
  });

  it('converts escaped \\n to actual newline character', () => {
    const result = renderBulkTemplate('Olá\\nTudo bem?', 'Ana');
    expect(result).toBe('Olá\nTudo bem?');
  });

  it('leaves template unchanged when there are no placeholders', () => {
    const result = renderBulkTemplate('Mensagem fixa.', 'Ana');
    expect(result).toBe('Mensagem fixa.');
  });

  it('handles empty contactName by using empty replacement', () => {
    const result = renderBulkTemplate('Oi {nome}!', '');
    expect(result).toBe('Oi !');
  });
});
