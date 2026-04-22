import { WhatsappContact, WhatsappMessage } from '../models/whatsapp.model';

const MESSAGE_SEPARATOR = '|||';
const MESSAGE_SEPARATOR_REGEX = /\s*\|{2,}\s*/g;
const MAX_SUGGESTION_PARTS = 3;
const MAX_PROMPT_CONTEXT_MESSAGES = 12;
const PROMPT_CONTEXT_SESSION_GAP_MS = 3 * 60 * 60 * 1000;
const RESET_CUE_REGEX = /^(oi+|ola+|ol[aá]|opa+|bom dia|boa tarde|boa noite|ol[áa],? tudo bem|oi+,? tudo bem)\W*$/i;
const ASSISTANT_ROLE_PREFIX_REGEX = /^(?:(?:mensagem|resposta|vendedora|vendedor|atendente|assistente|agente|cliente)\s*:\s*)+/i;
const CPF_REGEX = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_REGEX = /(?<!\d)(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)(?:9?\d{4})-?\d{4}(?!\d)/g;
const FULL_DATE_REGEX = /\b\d{2}\/\d{2}\/\d{4}\b/g;
const SENSITIVE_KEYWORD_REGEX = /\b(cpf|telefone|celular|whatsapp|contato|dados|dados pessoais|data de nascimento|nascimento|endere[cç]o|endereco|email|e-mail|nome completo|documento|rg)\b/i;
const THIRD_PARTY_MARKER_REGEX = /\b(dela|dele|de outra pessoa|de outro cliente|de outra cliente|da cliente|do cliente|de um cliente|de uma cliente|de terceiro|de terceiros|dessa cliente|desse cliente)\b/i;
const UNSAFE_DISCLOSURE_REGEX = /\b(cpf|telefone|celular|data de nascimento|nome completo|email|e-mail)\b.{0,40}\b([ée]\b|eh\b|no cadastro|tenho aqui|que tenho|dela\b|dele\b|da cliente|do cliente)\b/i;
const GENERIC_REFERENCE_TOKENS = new Set([
  'cliente', 'clientes', 'loja', 'pedido', 'pedidos', 'entrega', 'envio', 'endereco', 'endereco', 'dados', 'cpf', 'telefone',
  'whatsapp', 'contato', 'numero', 'número', 'pix', 'credito', 'crédito', 'cartao', 'cartão', 'debito', 'débito', 'cep'
]);

export function splitAssistantSuggestionIntoMessages(text: string): string[] {
  return String(text || '')
    .split(MESSAGE_SEPARATOR_REGEX)
    .map(part => sanitizeAssistantSuggestionPart(part))
    .filter(Boolean)
    .slice(0, MAX_SUGGESTION_PARTS);
}

export function sanitizeAssistantSuggestionPart(text: string): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/^'|'$/g, '')
    .replace(ASSISTANT_ROLE_PREFIX_REGEX, '')
    .trim();
}

export function selectRecentConversationMessages(messages: WhatsappMessage[]): WhatsappMessage[] {
  const textMessages = messages.filter(isPromptEligibleMessage);
  if (!textMessages.length) {
    return [];
  }

  const selected: WhatsappMessage[] = [];

  for (let index = textMessages.length - 1; index >= 0; index -= 1) {
    const current = textMessages[index];
    const newer = selected[0];

    if (newer) {
      const currentMs = Date.parse(current.sentAt);
      const newerMs = Date.parse(newer.sentAt);
      if (Number.isFinite(currentMs) && Number.isFinite(newerMs) && newerMs - currentMs > PROMPT_CONTEXT_SESSION_GAP_MS) {
        break;
      }
    }

    selected.unshift(current);

    if (selected.length >= MAX_PROMPT_CONTEXT_MESSAGES) {
      break;
    }
  }

  const resetCueIndex = findRecentConversationResetCueIndex(selected);
  return resetCueIndex >= 0 ? selected.slice(resetCueIndex) : selected;
}

export function hasSensitiveThirdPartyRequest(contact: WhatsappContact, messages: WhatsappMessage[]): boolean {
  const recentInboundTexts = messages
    .filter(message => !message.isFromMe && Boolean(message.text?.trim()))
    .slice(-4)
    .map(message => message.text.trim());

  if (!recentInboundTexts.length) {
    return false;
  }

  const joined = recentInboundTexts.join('\n');
  if (!SENSITIVE_KEYWORD_REGEX.test(joined)) {
    return false;
  }

  if (THIRD_PARTY_MARKER_REGEX.test(joined)) {
    return true;
  }

  return recentInboundTexts.some(text => referencesOtherNamedPerson(text, contact));
}

export function leaksSensitiveDataOutsideConversation(text: string, messages: WhatsappMessage[]): boolean {
  const outputValues = extractSensitiveValues(text);
  if (!outputValues.length) {
    return false;
  }

  const conversationValues = new Set(
    extractSensitiveValues(
      messages
        .map(message => message.text || '')
        .join('\n')
    )
  );

  return outputValues.some(value => !conversationValues.has(value));
}

export function hasUnsafeSensitiveDisclosure(text: string): boolean {
  return UNSAFE_DISCLOSURE_REGEX.test(String(text || ''));
}

export function getSensitiveDataRefusalSuggestion(): string {
  return 'Esses dados eu não posso compartilhar, porque são informações pessoais de cliente. Se você precisar de ajuda com seu pedido ou com alguma informação da loja, me fala que eu te ajudo.';
}

export function getAssistantMessageSeparator(): string {
  return MESSAGE_SEPARATOR;
}

function referencesOtherNamedPerson(text: string, contact: WhatsappContact): boolean {
  const normalizedContact = normalizeComparableText(contact.name || contact.phone || contact.jid || '');
  const referencedNames = Array.from(text.matchAll(/\b(?:da|do|de)\s+([a-zà-ÿ]+(?:\s+[a-zà-ÿ]+){0,2})/gi))
    .map(match => normalizeComparableText(match[1] || ''))
    .filter(Boolean)
    .filter(name => {
      const firstToken = name.split(' ')[0] || '';
      return firstToken && !GENERIC_REFERENCE_TOKENS.has(firstToken);
    });

  if (!referencedNames.length) {
    return false;
  }

  return referencedNames.some(name => !normalizedContact || !normalizedContact.includes(name));
}

function extractSensitiveValues(text: string): string[] {
  const values = new Set<string>();
  const content = String(text || '');

  for (const match of content.match(CPF_REGEX) || []) {
    values.add(normalizeCpf(match));
  }

  for (const match of content.match(EMAIL_REGEX) || []) {
    values.add(match.trim().toLowerCase());
  }

  for (const match of content.match(PHONE_REGEX) || []) {
    const normalized = normalizePhone(match);
    if (normalized) {
      values.add(normalized);
    }
  }

  for (const match of content.match(FULL_DATE_REGEX) || []) {
    values.add(match.trim());
  }

  return Array.from(values);
}

function normalizeCpf(value: string): string {
  return value.replace(/\D/g, '');
}

function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (!digits) {
    return '';
  }

  if (digits.length === 13 && digits.startsWith('55')) {
    return digits.slice(2);
  }

  return digits;
}

function normalizeComparableText(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPromptEligibleMessage(message: WhatsappMessage): boolean {
  const text = String(message.text || '').trim();
  if (!text) {
    return false;
  }

  return !isHiddenMediaPlaceholder(text);
}

function isHiddenMediaPlaceholder(text: string): boolean {
  const normalized = normalizeComparableText(text)
    .replace(/[\[\]<>]/g, '')
    .trim();

  return normalized === 'midia oculta'
    || normalized === 'media omitted'
    || normalized === 'midia';
}

function findRecentConversationResetCueIndex(messages: WhatsappMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.isFromMe) {
      continue;
    }

    if (RESET_CUE_REGEX.test(String(message.text || '').trim())) {
      return index;
    }
  }

  return -1;
}