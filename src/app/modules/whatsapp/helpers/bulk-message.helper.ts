export function renderBulkTemplate(template: string, contactName: string): string {
  const firstName = getFirstName(contactName);
  const replacement = firstName || contactName.trim() || '';

  return template
    .replace(/\{nome\}/g, replacement)
    .replace(/\\n/g, '\n');
}

function getFirstName(rawName: string): string {
  const firstNamePart = (rawName || '').trim().split(/\s+/)[0] || '';
  const firstNameLower = firstNamePart.toLocaleLowerCase('pt-BR');

  return firstNameLower
    ? firstNameLower.charAt(0).toLocaleUpperCase('pt-BR') + firstNameLower.slice(1)
    : '';
}
