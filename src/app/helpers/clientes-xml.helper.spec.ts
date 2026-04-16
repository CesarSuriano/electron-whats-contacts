import { parseClientesFromXml } from './clientes-xml.helper';

function xmlWith(clienteXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><clientes>${clienteXml}</clientes>`;
}

function singleCliente(overrides: Partial<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    razao_social: 'Maria Silva',
    cpf: '123.456.789-00',
    data_cadastro: '2023-01-15',
    data_nascimento: '1990-05-20',
    ...overrides
  };

  const fieldsXml = Object.entries(fields)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('');

  return `<cliente>${fieldsXml}</cliente>`;
}

function clienteWithContatos(contactXmls: string[]): string {
  const contatosXml = contactXmls.map(c => `<contato>${c}</contato>`).join('');
  return `<cliente>
    <razao_social>João</razao_social>
    <cpf>000</cpf>
    <data_cadastro>2020-01-01</data_cadastro>
    <data_nascimento>1985-03-10</data_nascimento>
    <contatos>${contatosXml}</contatos>
  </cliente>`;
}

describe('parseClientesFromXml', () => {
  it('parses a single cliente with basic fields', () => {
    const result = parseClientesFromXml(xmlWith(singleCliente()));
    expect(result.length).toBe(1);
    const c = result[0];
    expect(c.nome).toBe('Maria Silva');
    expect(c.cpf).toBe('123.456.789-00');
    expect(c.dataCadastro).toBe('2023-01-15');
    expect(c.dataNascimento).toBe('1990-05-20');
  });

  it('assigns sequential ids starting from 0', () => {
    const xml = xmlWith(singleCliente() + singleCliente({ razao_social: 'Pedro' }));
    const result = parseClientesFromXml(xml);
    expect(result[0].id).toBe(0);
    expect(result[1].id).toBe(1);
  });

  it('returns empty array for XML with no clientes', () => {
    const result = parseClientesFromXml(xmlWith(''));
    expect(result).toEqual([]);
  });

  it('throws on invalid XML', () => {
    expect(() => parseClientesFromXml('not xml at all <<')).toThrowError('XML inválido');
  });

  it('picks the principal telephone (tipo_contato=T, principal=1)', () => {
    const xml = xmlWith(clienteWithContatos([
      '<tipo_contato>E</tipo_contato><principal>1</principal><descricao>email@test.com</descricao>',
      '<tipo_contato>T</tipo_contato><principal>1</principal><descricao>(11) 98765-4321</descricao>',
      '<tipo_contato>T</tipo_contato><principal>0</principal><descricao>(11) 11111-1111</descricao>'
    ]));
    const [c] = parseClientesFromXml(xml);
    expect(c.telefone).toBe('(11) 98765-4321');
  });

  it('falls back to first contato when no principal telephone exists', () => {
    const xml = xmlWith(clienteWithContatos([
      '<tipo_contato>E</tipo_contato><principal>0</principal><descricao>fallback@test.com</descricao>'
    ]));
    const [c] = parseClientesFromXml(xml);
    expect(c.telefone).toBe('fallback@test.com');
  });

  it('returns empty telefone when contatos node is absent', () => {
    const xml = xmlWith(singleCliente());
    const [c] = parseClientesFromXml(xml);
    expect(c.telefone).toBe('');
  });

  it('sets birthdayStatus based on dataNascimento', () => {
    const today = new Date();
    const monthStr = String(today.getMonth() + 1).padStart(2, '0');
    const dayStr = String(today.getDate()).padStart(2, '0');
    const todayDateStr = `1990-${monthStr}-${dayStr}`;

    const xml = xmlWith(singleCliente({ data_nascimento: todayDateStr }));
    const [c] = parseClientesFromXml(xml);
    expect(c.birthdayStatus).toBe('today');
  });

  it('trims whitespace from field values', () => {
    const xml = xmlWith(`<cliente>
      <razao_social>  Spaces  </razao_social>
      <cpf>  </cpf>
      <data_cadastro></data_cadastro>
      <data_nascimento></data_nascimento>
    </cliente>`);
    const [c] = parseClientesFromXml(xml);
    expect(c.nome).toBe('Spaces');
    expect(c.cpf).toBe('');
  });
});
