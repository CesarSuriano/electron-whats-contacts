import { ScheduledMessageService } from './scheduled-message.service';

describe('ScheduledMessageService', () => {
  let service: ScheduledMessageService;

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date('2026-04-24T10:00:00.000Z'));
    localStorage.removeItem('uniq-system.scheduled-messages');
    service = new ScheduledMessageService();
  });

  afterEach(() => {
    service.ngOnDestroy();
    localStorage.removeItem('uniq-system.scheduled-messages');
    jasmine.clock().uninstall();
  });

  it('suppresses the upcoming notification while a schedule is executing', () => {
    const schedule = service.create({
      scheduledAt: '2026-04-24T10:10:00.000Z',
      recurrence: 'none',
      template: 'Oi',
      contacts: []
    });

    (service as any).checkUpcoming();
    expect(service.getById(schedule.id)?.status).toBe('notified');

    service.beginExecution(schedule.id);
    (service as any).checkUpcoming();

    expect(service.getById(schedule.id)?.status).toBe('pending');
    expect((service as any).upcomingSubject.value).toBeNull();
  });

  it('marks the schedule done when execution completes', () => {
    const schedule = service.create({
      scheduledAt: '2026-04-24T10:10:00.000Z',
      recurrence: 'none',
      template: 'Oi',
      contacts: []
    });

    service.beginExecution(schedule.id);
    service.completeExecution(schedule.id);

    expect(service.getById(schedule.id)?.status).toBe('done');
  });

  it('does not remind again after dismissing the current occurrence', () => {
    const schedule = service.create({
      scheduledAt: '2026-04-24T10:10:00.000Z',
      recurrence: 'none',
      template: 'Oi',
      contacts: []
    });

    (service as any).checkUpcoming();
    expect(service.getById(schedule.id)?.status).toBe('notified');

    service.dismissNotification(schedule.id);
    (service as any).checkUpcoming();

    expect(service.getById(schedule.id)?.status).toBe('pending');
    expect(service.getById(schedule.id)?.reminderDismissedForScheduledAt).toBe('2026-04-24T10:10:00.000Z');
    expect((service as any).upcomingSubject.value).toBeNull();
  });

  describe('interrupted bulk sends', () => {
    const remaining = [
      { jid: '5522@c.us', name: 'Bia', phone: '5522' },
      { jid: '5533@c.us', name: 'Caio', phone: '5533' }
    ];

    it('saves the remaining contacts as an interrupted entry that never triggers a reminder', () => {
      const entry = service.saveInterruptedBulk({
        template: 'Oi {nome}',
        remainingContacts: remaining,
        processedCount: 1,
        totalCount: 3
      })!;

      expect(entry.contacts).toEqual(remaining);
      expect(entry.interruptedBulk).toEqual({ interruptedAt: '2026-04-24T10:00:00.000Z', sentCount: 1, totalCount: 3 });

      (service as any).checkUpcoming();
      expect(service.getById(entry.id)?.status).toBe('pending');
      expect((service as any).upcomingSubject.value).toBeNull();
    });

    it('updates the same entry with cumulative progress when a continuation is interrupted again', () => {
      const entry = service.saveInterruptedBulk({
        template: 'Oi',
        remainingContacts: remaining,
        processedCount: 1,
        totalCount: 3
      })!;
      service.beginExecution(entry.id);

      const updated = service.saveInterruptedBulk({
        template: 'Oi',
        remainingContacts: [remaining[1]],
        processedCount: 1,
        totalCount: 2,
        sourceScheduleId: entry.id
      })!;

      expect(updated.id).toBe(entry.id);
      expect(updated.contacts).toEqual([remaining[1]]);
      expect(updated.interruptedBulk?.sentCount).toBe(2);
      expect(updated.interruptedBulk?.totalCount).toBe(3);
      expect(service.getAll().length).toBe(1);
    });

    it('completes the source schedule when its execution is interrupted', () => {
      const schedule = service.create({
        scheduledAt: '2026-04-24T09:00:00.000Z',
        recurrence: 'none',
        template: 'Oi',
        contacts: []
      });
      service.beginExecution(schedule.id);

      service.saveInterruptedBulk({
        template: 'Oi',
        remainingContacts: remaining,
        processedCount: 1,
        totalCount: 3,
        sourceScheduleId: schedule.id
      });

      expect(service.getById(schedule.id)?.status).toBe('done');
      expect(service.getAll().filter(s => s.interruptedBulk).length).toBe(1);
    });

    it('removes the interrupted entry when its continuation is cancelled or completed', () => {
      const cancelled = service.saveInterruptedBulk({ template: 'Oi', remainingContacts: remaining, processedCount: 0, totalCount: 2 })!;
      service.beginExecution(cancelled.id);
      service.cancelExecution(cancelled.id);
      expect(service.getById(cancelled.id)).toBeNull();

      const completed = service.saveInterruptedBulk({ template: 'Oi', remainingContacts: remaining, processedCount: 0, totalCount: 2 })!;
      service.beginExecution(completed.id);
      service.completeExecution(completed.id);
      expect(service.getById(completed.id)).toBeNull();
    });

    it('ignores an interruption with no remaining contacts', () => {
      expect(service.saveInterruptedBulk({ template: 'Oi', remainingContacts: [], processedCount: 2, totalCount: 2 })).toBeNull();
      expect(service.getAll().length).toBe(0);
    });
  });

  it('restores legacy single-image schedules as imageDataUrls arrays', () => {
    localStorage.setItem('uniq-system.scheduled-messages', JSON.stringify([{
      id: 'sch-legacy',
      scheduledAt: '2026-04-24T10:10:00.000Z',
      recurrence: 'none',
      template: 'Oi',
      imageDataUrl: 'data:image/png;base64,legacy',
      contacts: [],
      status: 'pending',
      createdAt: '2026-04-24T10:00:00.000Z'
    }]));

    service.ngOnDestroy();
    service = new ScheduledMessageService();

    expect(service.getById('sch-legacy')?.imageDataUrls).toEqual(['data:image/png;base64,legacy']);
  });
});