import { Injectable } from '@angular/core';

import { WhatsappMessage } from '../../../models/whatsapp.model';

const STORAGE_KEY = 'uniq-system.assistant-feedback.v1';
const MAX_FEEDBACK_ITEMS = 200;

export type AssistantFeedbackProvider = 'gem' | 'gemini';
export type AssistantFeedbackRating = 'up' | 'down';

export interface AssistantFeedbackEntry {
  id: string;
  provider: AssistantFeedbackProvider;
  rating: AssistantFeedbackRating;
  contactJid: string;
  contactName: string;
  contextKey: string;
  suggestion: string;
  createdAt: string;
  suggestionIndex: number;
  suggestionTotal: number;
  messages: Array<{
    id: string;
    sender: 'vendedora' | 'cliente';
    text: string;
    sentAt: string;
  }>;
}

@Injectable({
  providedIn: 'root'
})
export class AssistantFeedbackService {
  record(entry: {
    provider: AssistantFeedbackProvider;
    rating: AssistantFeedbackRating;
    contactJid: string;
    contactName: string;
    contextKey: string;
    suggestion: string;
    suggestionIndex?: number;
    suggestionTotal?: number;
    messages: WhatsappMessage[];
  }): AssistantFeedbackEntry {
    const nextEntry: AssistantFeedbackEntry = {
      id: this.generateId(),
      provider: entry.provider,
      rating: entry.rating,
      contactJid: entry.contactJid,
      contactName: entry.contactName,
      contextKey: entry.contextKey,
      suggestion: entry.suggestion.trim(),
      createdAt: new Date().toISOString(),
      suggestionIndex: Math.max(1, entry.suggestionIndex || 1),
      suggestionTotal: Math.max(1, entry.suggestionTotal || 1),
      messages: entry.messages
        .filter(message => Boolean(message.text?.trim()))
        .slice(-12)
        .map(message => ({
          id: message.id,
          sender: message.isFromMe ? 'vendedora' : 'cliente',
          text: message.text.trim(),
          sentAt: message.sentAt
        }))
    };

    const current = this.readAll();
    const next = [nextEntry, ...current].slice(0, MAX_FEEDBACK_ITEMS);
    this.persist(next);
    return nextEntry;
  }

  list(): AssistantFeedbackEntry[] {
    return this.readAll();
  }

  private readAll(): AssistantFeedbackEntry[] {
    if (typeof localStorage === 'undefined') {
      return [];
    }

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return [];
      }

      const parsed = JSON.parse(raw) as AssistantFeedbackEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private persist(entries: AssistantFeedbackEntry[]): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  }

  private generateId(): string {
    return `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}