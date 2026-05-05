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