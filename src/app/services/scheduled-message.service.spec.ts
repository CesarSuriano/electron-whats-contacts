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
});