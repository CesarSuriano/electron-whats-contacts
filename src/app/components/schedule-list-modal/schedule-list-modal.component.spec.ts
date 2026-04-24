import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';

import { ScheduledMessage } from '../../models/scheduled-message.model';
import { WhatsappContact } from '../../models/whatsapp.model';
import { ScheduleListModalComponent } from './schedule-list-modal.component';

function makeContact(jid: string, name: string, phone: string): WhatsappContact {
  return {
    jid,
    name,
    phone,
    found: true,
    isGroup: false
  };
}

function makeSchedule(id = 'sch-1'): ScheduledMessage {
  return {
    id,
    scheduledAt: '2026-04-24T12:00:00.000Z',
    recurrence: 'none',
    template: 'Mensagem',
    contacts: [],
    status: 'pending',
    createdAt: '2026-04-24T10:00:00.000Z'
  };
}

describe('ScheduleListModalComponent', () => {
  let fixture: ComponentFixture<ScheduleListModalComponent>;
  let component: ScheduleListModalComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ScheduleListModalComponent],
      imports: [FormsModule]
    }).compileComponents();

    fixture = TestBed.createComponent(ScheduleListModalComponent);
    component = fixture.componentInstance;
    component.isOpen = true;
    component.availableContacts = [
      makeContact('5511999999999@c.us', 'Alice', '5511999999999'),
      makeContact('5511888888888@c.us', 'Bob', '5511888888888')
    ];
    component.onStartCreate();
    fixture.detectChanges();
  });

  it('selects the highlighted autocomplete contact on Enter', () => {
    component.onContactInputFocus();
    component.onContactSearchChange('ali');

    const event = new KeyboardEvent('keydown', { key: 'Enter' });
    spyOn(event, 'preventDefault');

    component.onContactSearchKeydown(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(component.editSelectedJids.has('5511999999999@c.us')).toBeTrue();
    expect(component.contactSearch).toBe('');
  });

  it('returns focus to the search input after selecting a contact', fakeAsync(() => {
    component.onContactInputFocus();
    component.onContactSearchChange('ali');
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('.contact-search-input') as HTMLInputElement;
    spyOn(input, 'focus');

    component.onSelectAutocomplete(component.availableContacts[0]);
    tick();

    expect(input.focus).toHaveBeenCalled();
    expect(component.contactInputFocused).toBeTrue();
  }));

  it('asks for confirmation before deleting a schedule', () => {
    spyOn(window, 'confirm').and.returnValue(false);
    spyOn(component.deleteSchedule, 'emit');

    component.onDelete('sch-1');

    expect(window.confirm).toHaveBeenCalled();
    expect(component.deleteSchedule.emit).not.toHaveBeenCalled();
  });

  it('deletes the schedule after confirmation and exits edit mode when needed', () => {
    const schedule = makeSchedule('sch-1');
    component.editingSchedule = schedule;
    component.view = 'edit';
    spyOn(window, 'confirm').and.returnValue(true);
    spyOn(component.deleteSchedule, 'emit');

    component.onDelete('sch-1');

    expect(component.deleteSchedule.emit).toHaveBeenCalledWith('sch-1');
    expect(component.view).toBe('list');
    expect(component.editingSchedule).toBeNull();
  });
});