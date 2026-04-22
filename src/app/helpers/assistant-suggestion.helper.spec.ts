import { WhatsappContact, WhatsappMessage } from '../models/whatsapp.model';
import {
  getSensitiveDataRefusalSuggestion,
  hasSensitiveThirdPartyRequest,
  hasUnsafeSensitiveDisclosure,
  leaksSensitiveDataOutsideConversation,
  sanitizeAssistantSuggestionPart,
  selectRecentConversationMessages,
  splitAssistantSuggestionIntoMessages
} from './assistant-suggestion.helper';

const contact: WhatsappContact = {
  jid: '5511999999999@c.us',
  phone: '5511999999999',
  name: 'Folgada',
  found: true
};

function makeMessage(id: string, text: string, isFromMe: boolean): WhatsappMessage {
  return {
    id,
    contactJid: contact.jid,
    text,
    sentAt: new Date().toISOString(),
    isFromMe,
    source: 'test'
  };
}

describe('assistant-suggestion.helper', () => {
  it('splits assistant suggestions into up to three messages', () => {
    expect(splitAssistantSuggestionIntoMessages('Primeira ||| Segunda ||| Terceira ||| Quarta')).toEqual([
      'Primeira',
      'Segunda',
      'Terceira'
    ]);
  });

  it('also splits assistant suggestions when the model returns double pipes', () => {
    expect(splitAssistantSuggestionIntoMessages('Boa tarde! Tudo bem? || As calças da Zoomp estão saindo por 199,90 cada. 😊 || Posso te enviar os modelos disponíveis no seu tamanho?')).toEqual([
      'Boa tarde! Tudo bem?',
      'As calças da Zoomp estão saindo por 199,90 cada. 😊',
      'Posso te enviar os modelos disponíveis no seu tamanho?'
    ]);
  });

  it('strips echoed role prefixes from each suggested message part', () => {
    expect(splitAssistantSuggestionIntoMessages('Vendedora: Bom dia! Tudo bem? ||| Vendedora: Posso te ajudar com alguma coisa?')).toEqual([
      'Bom dia! Tudo bem?',
      'Posso te ajudar com alguma coisa?'
    ]);
  });

  it('sanitizes single-message prefixes like Vendedora before sending to the composer', () => {
    expect(sanitizeAssistantSuggestionPart('Vendedora: Bom dia! Tudo bem? ☺️')).toBe('Bom dia! Tudo bem? ☺️');
  });

  it('keeps only the recent conversation window after a long inactivity gap', () => {
    const messages: WhatsappMessage[] = [
      {
        ...makeMessage('1', 'Quero ver a calça da Zoomp', false),
        sentAt: '2026-04-21T17:41:00.000Z'
      },
      {
        ...makeMessage('2', 'As calças da Zoomp estão saindo por 199,90.', true),
        sentAt: '2026-04-21T17:42:00.000Z'
      },
      {
        ...makeMessage('3', 'Boa noite', false),
        sentAt: '2026-04-22T01:45:00.000Z'
      }
    ];

    expect(selectRecentConversationMessages(messages).map(message => message.id)).toEqual(['3']);
  });

  it('ignores hidden media placeholders in the prompt context window', () => {
    const messages: WhatsappMessage[] = [
      makeMessage('1', 'Ok', false),
      makeMessage('2', '<Mídia oculta>', false),
      makeMessage('3', '[mídia]', true)
    ];

    expect(selectRecentConversationMessages(messages).map(message => message.id)).toEqual(['1']);
  });

  it('resets the prompt context from a recent inbound greeting opener', () => {
    const messages: WhatsappMessage[] = [
      makeMessage('1', 'Quero ver a calça da Zoomp', false),
      makeMessage('2', 'As calças da Zoomp estão saindo por 199,90.', true),
      makeMessage('3', 'Oi', false),
      makeMessage('4', 'Tudo bem?', true)
    ];

    expect(selectRecentConversationMessages(messages).map(message => message.id)).toEqual(['3', '4']);
  });

  it('detects third-party sensitive data requests from the recent inbound context', () => {
    expect(hasSensitiveThirdPartyRequest(contact, [
      makeMessage('1', 'Qual o telefone da Teresa?', false),
      makeMessage('2', 'Me passa o CPF então', false)
    ])).toBeTrue();
  });

  it('flags leaks when the suggestion contains sensitive values absent from the current conversation', () => {
    expect(leaksSensitiveDataOutsideConversation(
      'O CPF dela é 225.445.001-82.',
      [makeMessage('1', 'Me passa o CPF então', false)]
    )).toBeTrue();
  });

  it('flags suspicious disclosure phrasing even without explicit digits', () => {
    expect(hasUnsafeSensitiveDisclosure('O telefone da cliente que tenho aqui no cadastro é esse.')).toBeTrue();
  });

  it('provides a safe refusal suggestion', () => {
    expect(getSensitiveDataRefusalSuggestion()).toContain('não posso compartilhar');
  });
});