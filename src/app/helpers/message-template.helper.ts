import { Cliente } from '../models/cliente.model';
import { MessageTemplateEditorConfig, MessageTemplateType, MessageTemplates } from '../models/message-template.model';

const NAME_TOKEN = '{nome}';

export const DEFAULT_MESSAGE_TEMPLATES: MessageTemplates = {
  birthday:
    '🎉 Parabéns, {nome}! 🎉\n' +
    'A Uniq Store celebra com você esse momento especial! Como forma de agradecimento por fazer parte da nossa história, preparamos um presente exclusivo 🎁: *15% de desconto em toda a loja!*\n\n' +
    'Este presente *é válido por 7 dias após a data do seu aniversário!*🎈\n\n' +
    'Aproveite e venha garantir suas peças favoritas! 🥳🛍️✨',
  review:
    'Olá, {nome}! Tudo bem?\n' +
    'É o Henrique da *UNIQ STORE*! Muito obrigado por ter vindo nos visitar ☺️\n\n' +
    'Gostaríamos de saber *como foi a sua experiência* — isso nos ajuda a continuar evoluindo e também auxilia outras pessoas a conhecerem nosso trabalho✨\n' +
    '👉 https://g.page/r/CWG8pJKMCXEaEAE/review\n\n' +
    'Muito obrigado pela confiança e carinho!\n' +
    'Atenciosamente,\n' +
    'Equipe *UNIQ STORE*'
};

export const MESSAGE_TEMPLATE_EDITOR_CONFIG: Record<MessageTemplateType, MessageTemplateEditorConfig> = {
  birthday: {
    type: 'birthday',
    title: 'Editar mensagem de parabéns',
    description: 'Essa mensagem será usada no botão Parabéns.'
  },
  review: {
    type: 'review',
    title: 'Editar mensagem de avaliação',
    description: 'Essa mensagem será usada no botão Avaliação.'
  }
};

export function normalizeMessageTemplateForEditing(template: string): string {
  return (template || '').replace(/\r\n?/g, '\n').replace(/\\n/g, '\n');
}

export function renderMessageTemplatePreviewHtml(template: string, previewName = 'Maria'): string {
  return renderFormattedMessageHtml(normalizeMessageTemplateForEditing(template), {
    showFormattingMarkers: false,
    tokenHtml: `<span class="message-template-preview-personalization">${escapeHtml(previewName)}</span>`
  });
}

export function renderMessageTemplateEditorHtml(template: string): string {
  return renderFormattedMessageHtml(normalizeMessageTemplateForEditing(template), {
    showFormattingMarkers: true,
    tokenHtml: `<span class="message-template-token">${escapeHtml(NAME_TOKEN)}</span>`
  });
}

export function renderMessageTemplate(template: string, cliente: Cliente): string {
  const nameForMessage = getFirstName(cliente.nome) || cliente.nome.trim();

  return normalizeMessageTemplateForEditing(template).replace(/\{nome\}/g, nameForMessage);
}

export function getFirstName(rawName: string): string {
  const firstNamePart = (rawName || '').trim().split(/\s+/)[0] || '';
  const firstNameLower = firstNamePart.toLocaleLowerCase('pt-BR');

  return firstNameLower
    ? firstNameLower.charAt(0).toLocaleUpperCase('pt-BR') + firstNameLower.slice(1)
    : '';
}

function renderFormattedMessageHtml(
  template: string,
  options: { showFormattingMarkers: boolean; tokenHtml: string }
): string {
  const escapedTemplate = escapeHtml(template);
  const withTokens = escapedTemplate.replace(/\{nome\}/g, options.tokenHtml);
  const withBold = withTokens.replace(/\*([\s\S]+?)\*/g, (_match, inner) => {
    return options.showFormattingMarkers
      ? `<span class="message-template-format-marker">*</span><strong class="message-template-format-strong">${inner}</strong><span class="message-template-format-marker">*</span>`
      : `<strong>${inner}</strong>`;
  });

  return withBold.replace(/_([\s\S]+?)_/g, (_match, inner) => {
    return options.showFormattingMarkers
      ? `<span class="message-template-format-marker">_</span><em class="message-template-format-italic">${inner}</em><span class="message-template-format-marker">_</span>`
      : `<em>${inner}</em>`;
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
