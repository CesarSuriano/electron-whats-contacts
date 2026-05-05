import { NO_ERRORS_SCHEMA, SimpleChange } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { AppLabel } from '../../../../models/app-label.model';
import { WhatsappContact } from '../../../../models/whatsapp.model';
import { LabelService } from '../../../../services/label.service';
import { ManagerLaunchService } from '../../../../services/manager-launch.service';
import { WhatsappStateService } from '../../services/whatsapp-state.service';
import { ChatHeaderComponent } from './chat-header.component';

const makeContact = (overrides: Partial<WhatsappContact> = {}): WhatsappContact => ({
  jid: '5511987654321@c.us',
  phone: '5511987654321',
  name: 'Ana Silva',
  found: true,
  ...overrides
});

const makeAppLabel = (overrides: Partial<AppLabel> = {}): AppLabel => ({
  id: 'app-1',
  name: 'Etiqueta',
  color: '#ef4444',
  createdAt: new Date().toISOString(),
  ...overrides
});

describe('ChatHeaderComponent', () => {
  let fixture: ComponentFixture<ChatHeaderComponent>;
  let component: ChatHeaderComponent;
  let stateSpy: jasmine.SpyObj<WhatsappStateService>;
  let labelServiceSpy: jasmine.SpyObj<LabelService>;
  let managerLaunchSpy: jasmine.SpyObj<ManagerLaunchService>;
  let labelsByJid$: BehaviorSubject<AppLabel[]>;

  beforeEach(async () => {
    stateSpy = jasmine.createSpyObj('WhatsappStateService', ['requestPhoto']);
    labelsByJid$ = new BehaviorSubject<AppLabel[]>([]);
    labelServiceSpy = jasmine.createSpyObj('LabelService', ['watchLabelsForJid', 'toggleLabelOnJid']);
    labelServiceSpy.watchLabelsForJid.and.returnValue(labelsByJid$.asObservable());
    managerLaunchSpy = jasmine.createSpyObj('ManagerLaunchService', ['openLabelManager']);

    await TestBed.configureTestingModule({
      declarations: [ChatHeaderComponent],
      providers: [
        { provide: WhatsappStateService, useValue: stateSpy },
        { provide: LabelService, useValue: labelServiceSpy },
        { provide: ManagerLaunchService, useValue: managerLaunchSpy }
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

  it('combines app labels with imported WhatsApp labels and keeps only three visible', () => {
    component.contact = makeContact({ labels: ['VIP WhatsApp'] });
    component.whatsappLabels = [
      { id: 'wa-vip', name: 'VIP WhatsApp', hexColor: '#25D366' },
      { id: 'wa-fidelidade', name: 'Fidelidade', hexColor: '#128c7e', chatJids: ['5511987654321@c.us'] }
    ];
    labelsByJid$.next([
      makeAppLabel({ id: 'app-1', name: 'Cliente quente', color: '#ef4444' }),
      makeAppLabel({ id: 'app-2', name: 'Orçamento', color: '#f59e0b' })
    ]);

    component.ngOnChanges({
      contact: new SimpleChange(null, component.contact, true)
    });

    expect(component.visibleLabels.map(label => label.name)).toEqual([
      'Cliente quente',
      'Orçamento',
      'Fidelidade'
    ]);
    expect(component.hiddenLabels.map(label => label.name)).toEqual(['VIP WhatsApp']);
  });

  it('asks for confirmation before removing an app label', () => {
    component.contact = makeContact();
    labelsByJid$.next([makeAppLabel({ id: 'app-1', name: 'Cliente quente', color: '#ef4444' })]);

    component.ngOnChanges({
      contact: new SimpleChange(null, component.contact, true)
    });

    component.requestRemoveLabel(component.visibleLabels[0]);

    expect(component.pendingRemovalLabel?.name).toBe('Cliente quente');
    expect(labelServiceSpy.toggleLabelOnJid).not.toHaveBeenCalled();

    component.confirmRemoveLabel();

    expect(labelServiceSpy.toggleLabelOnJid).toHaveBeenCalledWith('5511987654321@c.us', 'app-1');
    expect(component.pendingRemovalLabel).toBeNull();
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

    it('does not show linked-id as phone when contact jid is @lid', () => {
      component.contact = makeContact({
        jid: '120363999999999999@lid',
        phone: '120363999999999999'
      });

      expect(component.phoneFormatted).toBe('');
    });

    it('prefers jid number when phone field looks like internal linked-id', () => {
      component.contact = makeContact({
        jid: '5511987654321@c.us',
        phone: '120363999999999999'
      });

      expect(component.phoneFormatted).toBe('+55 (11) 98765-4321');
    });

    it('prefers canonical Brazilian mobile variant when phone and jid differ only by ninth digit', () => {
      component.contact = makeContact({
        jid: '551187654321@c.us',
        phone: '5511987654321'
      });

      expect(component.phoneFormatted).toBe('+55 (11) 98765-4321');
    });

    it('prefers the conversation jid when the phone field conflicts with it', () => {
      component.contact = makeContact({
        jid: '5511987654321@c.us',
        phone: '5511912345678'
      });

      expect(component.phoneFormatted).toBe('+55 (11) 98765-4321');
    });
  });
});
