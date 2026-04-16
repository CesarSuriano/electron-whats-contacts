import { Cliente } from '../models/cliente.model';

export function buildBirthdayMessage(cliente: Cliente): string {
  const nameForMessage = getNameForMessage(cliente.nome);

  return (
    `🎉 Parabéns, ${nameForMessage}! 🎉\n` +
    'A Uniq Store celebra com você esse momento especial! Como forma de agradecimento por fazer parte da nossa história, preparamos um presente exclusivo 🎁: *15% de desconto em toda a loja!*\n\n' +
    'Este presente *é válido por 7 dias após a data do seu aniversário!*🎈\n\n' +
    'Aproveite e venha garantir suas peças favoritas! 🥳🛍️✨'
  );
}

export function buildReviewMessage(cliente: Cliente): string {
  const firstName = getFirstName(cliente.nome);

  return (
    `Olá, ${firstName ? `${firstName}! Tudo bem?` : 'Tudo bem?'}\n` +
    'É o Henrique da *UNIQ STORE*! Muito obrigado por ter vindo nos visitar ☺️\n\n' +
    'Gostaríamos de saber *como foi a sua experiência* — isso nos ajuda a continuar evoluindo e também auxilia outras pessoas a conhecerem nosso trabalho✨\n' +
    '👉 https://g.page/r/CWG8pJKMCXEaEAE/review\n\n' +
    'Muito obrigado pela confiança e carinho!\n' +
    'Atenciosamente,\n' +
    'Equipe *UNIQ STORE*'
  );
}

export function buildYearEndMessage(cliente: Cliente): string {
  const nameForMessage = getNameForMessage(cliente.nome);

  return (
    `Olá, ${nameForMessage} ! 🎄✨\n\n` +
    'Nós, da equipe Uniq Store, *agradecemos* por você ter feito parte da nossa história em 2025❗\n' +
    'Desejamos a você e à sua família um Feliz Natal, boas festas e um Ano Novo repleto de *conquistas, estilo e momentos especiais* 🥂✨\n\n' +
    'Que *2026* seja mais um ano para estarmos juntos🥰'
  );
}

function getNameForMessage(rawName: string): string {
  return getFirstName(rawName) || rawName.trim();
}

function getFirstName(rawName: string): string {
  const firstNamePart = (rawName || '').trim().split(/\s+/)[0] || '';
  const firstNameLower = firstNamePart.toLocaleLowerCase('pt-BR');

  return firstNameLower
    ? firstNameLower.charAt(0).toLocaleUpperCase('pt-BR') + firstNameLower.slice(1)
    : '';
}
