import { NO_ERRORS_SCHEMA, SimpleChange } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { WhatsappContact } from '../../../../models/whatsapp.model';
import { WhatsappStateService } from '../../services/whatsapp-state.service';
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
  let stateSpy: jasmine.SpyObj<WhatsappStateService>;

  beforeEach(async () => {
    stateSpy = jasmine.createSpyObj('WhatsappStateService', ['requestPhoto']);

    await TestBed.configureTestingModule({
      declarations: [ChatHeaderComponent],
      providers: [
        { provide: WhatsappStateService, useValue: stateSpy }
      ],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(ChatHeaderComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  it('requests photo for selected contact when photo is still unknown', () => {
    component.contact = makeContact({ photoUrl: undefined });

    component.ngOnChanges({
      contact: new SimpleChange(null, component.contact, true)
    });

    expect(stateSpy.requestPhoto).toHaveBeenCalledWith('5511987654321@c.us');
  });

  it('requests photo when the selected contact carries null photoUrl', () => {
    component.contact = makeContact({ photoUrl: null });

    component.ngOnChanges({
      contact: new SimpleChange(null, component.contact, true)
    });

    expect(stateSpy.requestPhoto).toHaveBeenCalledWith('5511987654321@c.us');
  });

  it('requests photo for selected group when photo is still unknown', () => {
    component.contact = makeContact({
      jid: '120363000000000000@g.us',
      phone: '',
      name: 'Grupo de trabalho',
      isGroup: true,
      photoUrl: undefined
    });

    component.ngOnChanges({
      contact: new SimpleChange(null, component.contact, true)
    });

    expect(stateSpy.requestPhoto).toHaveBeenCalledWith('120363000000000000@g.us');
  });

  it('does not request photo again when contact already has photoUrl', () => {
    component.contact = makeContact({ photoUrl: 'data:image/jpeg;base64,abc' });

    component.ngOnChanges({
      contact: new SimpleChange(null, component.contact, true)
    });

    expect(stateSpy.requestPhoto).not.toHaveBeenCalled();
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
