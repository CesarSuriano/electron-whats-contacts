import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { WhatsappContact } from '../../../../models/whatsapp.model';
import { ChatHeaderComponent } from './chat-header.component';

const makeContact = (overrides: Partial<WhatsappContact> = {}): WhatsappContact => ({
  jid: '5511987654321@c.us',
  phone: '5511987654321',
  name: 'Ana Silva',
  found: true,
  ...overrides
});

describe('ChatHeaderComponent', () => {
  let fixture: ComponentFixture<ChatHeaderComponent>;
  let component: ChatHeaderComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ChatHeaderComponent],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(ChatHeaderComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  describe('phoneFormatted', () => {
    it('returns empty string when no contact', () => {
      component.contact = null;
      expect(component.phoneFormatted).toBe('');
    });

    it('formats a valid Brazilian mobile number', () => {
      component.contact = makeContact({ phone: '5511987654321' });
      const formatted = component.phoneFormatted;
      expect(formatted).toBeTruthy();
      expect(formatted).not.toBe('5511987654321');
    });

    it('falls back to jid when phone is empty', () => {
      component.contact = makeContact({ phone: '', jid: '5511987654321@c.us' });
      const formatted = component.phoneFormatted;
      expect(formatted).toBeTruthy();
    });

    it('handles landline number (8 digits local)', () => {
      component.contact = makeContact({ phone: '551133334444' });
      const formatted = component.phoneFormatted;
      expect(formatted).toBeTruthy();
    });
  });
});
