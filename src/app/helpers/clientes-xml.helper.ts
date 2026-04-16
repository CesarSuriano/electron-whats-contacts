import { Cliente } from '../models/cliente.model';
import { calculateBirthdayStatus } from './cliente-date.helper';

export function parseClientesFromXml(xmlText: string): Cliente[] {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'application/xml');
  const parserError = xmlDoc.getElementsByTagName('parsererror')[0];

  if (parserError) {
    throw new Error('XML inválido');
  }

  const clienteNodes = Array.from(xmlDoc.getElementsByTagName('cliente'));
  const today = new Date();

  return clienteNodes.map((node, index) => {
    const nome = getTextContent(node, 'razao_social');
    const cpf = getTextContent(node, 'cpf');
    const dataCadastro = getTextContent(node, 'data_cadastro');
    const dataNascimento = getTextContent(node, 'data_nascimento');
    const telefone = getTelefoneFromCliente(node);

    return {
      id: index,
      nome,
      cpf,
      telefone,
      dataCadastro,
      dataNascimento,
      birthdayStatus: calculateBirthdayStatus(dataNascimento, today)
    };
  });
}

function getTextContent(parent: Element, tagName: string): string {
  const element = parent.getElementsByTagName(tagName)[0];
  return element?.textContent?.trim() ?? '';
}

function getTelefoneFromCliente(clienteNode: Element): string {
  const contatosNode = clienteNode.getElementsByTagName('contatos')[0];
  if (!contatosNode) {
    return '';
  }

  const contatoNodes = Array.from(contatosNode.getElementsByTagName('contato'));
  const principalContato = contatoNodes.find(contato => {
    const tipoContato = getTextContent(contato, 'tipo_contato');
    const principal = getTextContent(contato, 'principal');
    return tipoContato === 'T' && principal === '1';
  });

  if (principalContato) {
    return getTextContent(principalContato, 'descricao');
  }

  if (contatoNodes.length > 0) {
    return getTextContent(contatoNodes[0], 'descricao');
  }

  return '';
}