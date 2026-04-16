import { Injectable } from '@angular/core';

import { Cliente } from '../models/cliente.model';
import { MessageTemplateImages, MessageTemplateType, MessageTemplates } from '../models/message-template.model';
import { DEFAULT_MESSAGE_TEMPLATES, renderMessageTemplate } from '../helpers/message-template.helper';

@Injectable({
  providedIn: 'root'
})
export class MessageTemplateService {
  private readonly storageKey = 'messageTemplates';
  private readonly imageStorageKey = 'messageTemplateImages';
  private readonly emojiUsageStorageKey = 'messageTemplateEmojiUsage';
  private readonly customEmojiStorageKey = 'messageTemplateCustomEmojis';
  private cachedTemplates: MessageTemplates | null = null;

  getTemplates(): MessageTemplates {
    if (this.cachedTemplates) {
      return this.cachedTemplates;
    }

    const storedTemplates = this.readStoredTemplates();
    this.cachedTemplates = storedTemplates ?? { ...DEFAULT_MESSAGE_TEMPLATES };
    return this.cachedTemplates;
  }

  getTemplate(type: MessageTemplateType): string {
    return this.getTemplates()[type];
  }

  saveTemplate(type: MessageTemplateType, template: string): MessageTemplates {
    const nextTemplates: MessageTemplates = {
      ...this.getTemplates(),
      [type]: template
    };

    this.cachedTemplates = nextTemplates;

    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this.storageKey, JSON.stringify(nextTemplates));
    }

    return nextTemplates;
  }

  getTemplateImage(type: MessageTemplateType): string | undefined {
    return this.readStoredImages()[type];
  }

  saveTemplateImage(type: MessageTemplateType, dataUrl: string | undefined): void {
    const images = this.readStoredImages();
    if (dataUrl) {
      images[type] = dataUrl;
    } else {
      delete images[type];
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this.imageStorageKey, JSON.stringify(images));
    }
  }

  renderTemplate(type: MessageTemplateType, cliente: Cliente): string {
    return renderMessageTemplate(this.getTemplate(type), cliente);
  }

  getQuickAccessEmojis(defaultEmojis: string[], allEmojis: string[], limit = 8): string[] {
    const usageEntries = Object.entries(this.readEmojiUsage())
      .sort(([, leftCount], [, rightCount]) => rightCount - leftCount)
      .map(([emoji]) => emoji)
      .filter(emoji => allEmojis.includes(emoji));

    const orderedEmojis = [...usageEntries, ...defaultEmojis];
    return Array.from(new Set(orderedEmojis)).slice(0, limit);
  }

  registerEmojiUsage(emoji: string): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    const usage = this.readEmojiUsage();
    usage[emoji] = (usage[emoji] ?? 0) + 1;
    localStorage.setItem(this.emojiUsageStorageKey, JSON.stringify(usage));
  }

  getAllEmojis(defaultEmojis: string[]): string[] {
    return Array.from(new Set([...defaultEmojis, ...this.readCustomEmojis()]));
  }

  saveCustomEmoji(emoji: string): string[] {
    const normalizedEmoji = emoji.trim();
    if (!normalizedEmoji) {
      return this.readCustomEmojis();
    }

    const nextCustomEmojis = Array.from(new Set([...this.readCustomEmojis(), normalizedEmoji]));

    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this.customEmojiStorageKey, JSON.stringify(nextCustomEmojis));
    }

    return nextCustomEmojis;
  }

  private readStoredTemplates(): MessageTemplates | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }

    const rawTemplates = localStorage.getItem(this.storageKey);
    if (!rawTemplates) {
      return null;
    }

    try {
      const parsedTemplates = JSON.parse(rawTemplates) as Partial<MessageTemplates>;
      return {
        birthday: parsedTemplates.birthday || DEFAULT_MESSAGE_TEMPLATES.birthday,
        review: parsedTemplates.review || DEFAULT_MESSAGE_TEMPLATES.review
      };
    } catch (error) {
      console.error('Erro ao ler templates de mensagem salvos', error);
      return null;
    }
  }

  private readStoredImages(): MessageTemplateImages {
    if (typeof localStorage === 'undefined') {
      return {};
    }
    try {
      const raw = localStorage.getItem(this.imageStorageKey);
      return raw ? JSON.parse(raw) as MessageTemplateImages : {};
    } catch {
      return {};
    }
  }

  private readEmojiUsage(): Record<string, number> {
    if (typeof localStorage === 'undefined') {
      return {};
    }

    const rawUsage = localStorage.getItem(this.emojiUsageStorageKey);
    if (!rawUsage) {
      return {};
    }

    try {
      return JSON.parse(rawUsage) as Record<string, number>;
    } catch (error) {
      console.error('Erro ao ler histórico de emojis usados', error);
      return {};
    }
  }

  private readCustomEmojis(): string[] {
    if (typeof localStorage === 'undefined') {
      return [];
    }

    const rawCustomEmojis = localStorage.getItem(this.customEmojiStorageKey);
    if (!rawCustomEmojis) {
      return [];
    }

    try {
      const parsedCustomEmojis = JSON.parse(rawCustomEmojis) as string[];
      return parsedCustomEmojis.filter(emoji => typeof emoji === 'string' && emoji.trim().length > 0);
    } catch (error) {
      console.error('Erro ao ler emojis personalizados salvos', error);
      return [];
    }
  }
}