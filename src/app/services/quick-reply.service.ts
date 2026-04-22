import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

import { QuickReply, QuickReplyDraft } from '../models/quick-reply.model';

const STORAGE_KEY = 'quickReplies';

@Injectable({ providedIn: 'root' })
export class QuickReplyService {
  private readonly itemsSubject = new BehaviorSubject<QuickReply[]>(this.read());

  readonly items$: Observable<QuickReply[]> = this.itemsSubject.asObservable();

  get items(): QuickReply[] {
    return this.itemsSubject.value;
  }

  search(query: string, limit = 8): QuickReply[] {
    const term = (query || '').trim().toLowerCase();
    const items = this.itemsSubject.value;
    if (!term) {
      return items.slice(0, limit);
    }

    return items
      .filter(item => {
        return (
          item.shortcode.toLowerCase().includes(term)
          || (item.title || '').toLowerCase().includes(term)
          || item.content.toLowerCase().includes(term)
        );
      })
      .slice(0, limit);
  }

  create(draft: QuickReplyDraft): QuickReply {
    const item: QuickReply = {
      id: this.generateId(),
      shortcode: this.normalizeShortcode(draft.shortcode),
      title: draft.title?.trim() || undefined,
      content: draft.content,
      imageDataUrl: draft.imageDataUrl,
      updatedAt: new Date().toISOString()
    };

    const next = [...this.itemsSubject.value, item];
    this.persist(next);
    return item;
  }

  update(id: string, draft: QuickReplyDraft): QuickReply | null {
    const items = this.itemsSubject.value;
    const idx = items.findIndex(item => item.id === id);
    if (idx === -1) {
      return null;
    }

    const updated: QuickReply = {
      ...items[idx],
      shortcode: this.normalizeShortcode(draft.shortcode),
      title: draft.title?.trim() || undefined,
      content: draft.content,
      imageDataUrl: draft.imageDataUrl,
      updatedAt: new Date().toISOString()
    };

    const next = [...items];
    next[idx] = updated;
    this.persist(next);
    return updated;
  }

  remove(id: string): void {
    const next = this.itemsSubject.value.filter(item => item.id !== id);
    this.persist(next);
  }

  isShortcodeAvailable(shortcode: string, excludeId?: string): boolean {
    const normalized = this.normalizeShortcode(shortcode);
    if (!normalized) {
      return false;
    }
    return !this.itemsSubject.value.some(item => item.shortcode === normalized && item.id !== excludeId);
  }

  normalizeShortcode(shortcode: string): string {
    return (shortcode || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
  }

  private read(): QuickReply[] {
    if (typeof localStorage === 'undefined') {
      return [];
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private persist(items: QuickReply[]): void {
    this.itemsSubject.next(items);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    }
  }

  private generateId(): string {
    return `qr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
