import { AppLabel } from '../../../models/app-label.model';
import { WhatsappContact, WhatsappLabel } from '../../../models/whatsapp.model';

export interface ContactLabelDisplayItem {
  key: string;
  name: string;
  color: string;
  removable: boolean;
  source: 'app' | 'whatsapp';
  appLabelId?: string;
}

interface ResolvedWhatsappLabel {
  item: ContactLabelDisplayItem;
  normalizedId: string;
  normalizedName: string;
}

export function resolveAppLabelDisplayItems(appLabels: AppLabel[]): ContactLabelDisplayItem[] {
  return appLabels.map(label => ({
    key: `app:${label.id}`,
    name: label.name,
    color: label.color,
    removable: true,
    source: 'app',
    appLabelId: label.id
  }));
}

export function resolveWhatsappContactLabelDisplayItems(
  contact: WhatsappContact | null,
  whatsappLabels: WhatsappLabel[]
): ContactLabelDisplayItem[] {
  if (!contact) {
    return [];
  }

  const normalizedChatJid = normalizeWhatsappChatJid(contact.jid);
  const labelsById = new Map<string, ContactLabelDisplayItem>();
  const labelsByName = new Map<string, ContactLabelDisplayItem>();
  const resolved = new Map<string, ContactLabelDisplayItem>();

  whatsappLabels.forEach(label => {
    const parsed = resolveWhatsappCatalogLabel(label.id, label.name, label.hexColor);
    if (!parsed) {
      return;
    }

    if (parsed.normalizedId) {
      labelsById.set(parsed.normalizedId, parsed.item);
    }
    labelsByName.set(parsed.normalizedName, parsed.item);

    if ((label.chatJids || []).some(chatJid => normalizeWhatsappChatJid(chatJid) === normalizedChatJid)) {
      resolved.set(parsed.item.key, parsed.item);
    }
  });

  const rawLabels = Array.isArray(contact.labels) ? contact.labels : [];
  rawLabels.forEach(rawLabel => {
    const token = normalizeWhatsappLabelToken(rawLabel);
    if (!token) {
      return;
    }

    const fromCatalog = labelsById.get(token) || labelsByName.get(token);
    if (fromCatalog) {
      resolved.set(fromCatalog.key, fromCatalog);
      return;
    }

    const fallback = resolveWhatsappCatalogLabel('', rawLabel, undefined);
    if (fallback) {
      resolved.set(fallback.item.key, fallback.item);
    }
  });

  return Array.from(resolved.values()).sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
}

export function resolveCombinedContactLabelDisplayItems(
  contact: WhatsappContact | null,
  appLabels: AppLabel[],
  whatsappLabels: WhatsappLabel[]
): ContactLabelDisplayItem[] {
  return [
    ...resolveAppLabelDisplayItems(appLabels),
    ...resolveWhatsappContactLabelDisplayItems(contact, whatsappLabels)
  ];
}

function resolveWhatsappCatalogLabel(idRaw: unknown, nameRaw: unknown, colorRaw: unknown): ResolvedWhatsappLabel | null {
  const id = String(idRaw || '').trim();
  const name = String(nameRaw || '').trim() || id;
  if (!name) {
    return null;
  }

  const normalizedId = normalizeWhatsappLabelToken(id);
  const normalizedName = normalizeWhatsappLabelToken(name);
  const key = normalizedId ? `whatsapp:id:${normalizedId}` : `whatsapp:name:${normalizedName}`;

  return {
    item: {
      key,
      name,
      color: normalizeWhatsappLabelColor(colorRaw),
      removable: false,
      source: 'whatsapp'
    },
    normalizedId,
    normalizedName
  };
}

function normalizeWhatsappChatJid(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeWhatsappLabelToken(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeWhatsappLabelColor(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) {
    return '#128c7e';
  }

  return raw.startsWith('#') ? raw : `#${raw}`;
}