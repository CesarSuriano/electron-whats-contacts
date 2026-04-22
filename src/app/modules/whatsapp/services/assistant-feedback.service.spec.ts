import { TestBed } from '@angular/core/testing';

import { WhatsappMessage } from '../../../models/whatsapp.model';
import { AssistantFeedbackService } from './assistant-feedback.service';

const STORAGE_KEY = 'uniq-system.assistant-feedback.v1';

function makeMessage(id: string, text: string, isFromMe: boolean): WhatsappMessage {
  return {
    id,
    contactJid: '5511999999999@c.us',
    text,
    sentAt: new Date().toISOString(),
    isFromMe,
    source: 'test'
  };
}

describe('AssistantFeedbackService', () => {
  let service: AssistantFeedbackService;

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    TestBed.configureTestingModule({});
    service = TestBed.inject(AssistantFeedbackService);
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it('persists a feedback entry with a compact message snapshot', () => {
    const entry = service.record({
      provider: 'gem',
      rating: 'down',
      contactJid: '5511999999999@c.us',
      contactName: 'Cliente Teste',
      contextKey: 'ctx-1',
      suggestion: 'Mensagem sugerida',
      suggestionIndex: 1,
      suggestionTotal: 2,
      messages: [
        makeMessage('1', 'Oi', false),
        makeMessage('2', 'Boa tarde!', true)
      ]
    });

    expect(entry.provider).toBe('gem');
    expect(entry.rating).toBe('down');
    expect(entry.messages.length).toBe(2);
    expect(service.list().length).toBe(1);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]').length).toBe(1);
  });
});