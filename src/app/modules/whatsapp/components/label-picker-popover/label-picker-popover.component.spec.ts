import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { BehaviorSubject } from 'rxjs';

import { AppLabel, AppLabelAssignments } from '../../../../models/app-label.model';
import { WhatsappContact } from '../../../../models/whatsapp.model';
import { LabelService } from '../../../../services/label.service';
import { LabelPickerPopoverComponent } from './label-picker-popover.component';

const makeAppLabel = (overrides: Partial<AppLabel> = {}): AppLabel => ({
  id: 'app-1',
  name: 'Etiqueta App',
  color: '#ef4444',
  createdAt: new Date().toISOString(),
  ...overrides
});

const makeContact = (overrides: Partial<WhatsappContact> = {}): WhatsappContact => ({
  jid: '5511987654321@c.us',
  phone: '5511987654321',
  name: 'Ana Silva',
  found: true,
  ...overrides
});

describe('LabelPickerPopoverComponent', () => {
  let fixture: ComponentFixture<LabelPickerPopoverComponent>;
  let component: LabelPickerPopoverComponent;
  let labelServiceSpy: jasmine.SpyObj<LabelService>;
  let stateSubject: BehaviorSubject<{ labels: AppLabel[]; assignments: AppLabelAssignments }>;

  beforeEach(async () => {
    stateSubject = new BehaviorSubject<{ labels: AppLabel[]; assignments: AppLabelAssignments }>({
      labels: [],
      assignments: {}
    });

    labelServiceSpy = jasmine.createSpyObj('LabelService', ['toggleLabelOnJid', 'createLabel', 'suggestNextColor'], {
      state$: stateSubject.asObservable(),
      assignments: {}
    });
    labelServiceSpy.suggestNextColor.and.returnValue('#ef4444');

    await TestBed.configureTestingModule({
      declarations: [LabelPickerPopoverComponent],
      imports: [FormsModule],
      providers: [
        { provide: LabelService, useValue: labelServiceSpy }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(LabelPickerPopoverComponent);
    component = fixture.componentInstance;
    component.isOpen = true;
    component.jid = '5511987654321@c.us';
    component.contact = makeContact({ labels: ['VIP WhatsApp'] });
    component.whatsappLabels = [
      { id: 'wa-vip', name: 'VIP WhatsApp', hexColor: '#25D366' },
      { id: 'wa-fidelidade', name: 'Fidelidade', hexColor: '#128c7e', chatJids: ['5511987654321@c.us'] }
    ];

    stateSubject.next({
      labels: [
        makeAppLabel({ id: 'app-1', name: 'Cliente quente', color: '#ef4444' }),
        makeAppLabel({ id: 'app-2', name: 'Orçamento', color: '#f59e0b' })
      ],
      assignments: {
        '5511987654321@c.us': ['app-1']
      }
    });
    (labelServiceSpy as any).assignments = {
      '5511987654321@c.us': ['app-1']
    };

    fixture.detectChanges();
  });

  it('shows app and imported WhatsApp labels together in the popover', () => {
    expect(component.filteredLabels.map(label => label.name)).toEqual([
      'Cliente quente',
      'Orçamento',
      'Fidelidade',
      'VIP WhatsApp'
    ]);
  });

  it('does not toggle imported WhatsApp labels', () => {
    const imported = component.filteredLabels.find(label => label.source === 'whatsapp');

    expect(imported).toBeTruthy();

    component.onLabelClick(imported!);

    expect(labelServiceSpy.toggleLabelOnJid).not.toHaveBeenCalled();
  });

  it('asks for confirmation before removing an assigned app label', () => {
    const assignedAppLabel = component.filteredLabels.find(label => label.source === 'app' && label.selected);

    expect(assignedAppLabel).toBeTruthy();

    component.requestRemoveLabel(assignedAppLabel!);

    expect(component.pendingRemovalLabel?.name).toBe('Cliente quente');
    expect(labelServiceSpy.toggleLabelOnJid).not.toHaveBeenCalled();

    component.confirmRemoveLabel();

    expect(labelServiceSpy.toggleLabelOnJid).toHaveBeenCalledWith('5511987654321@c.us', 'app-1');
    expect(component.pendingRemovalLabel).toBeNull();
  });
});