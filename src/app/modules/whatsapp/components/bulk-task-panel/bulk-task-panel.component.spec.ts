import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { BulkQueue, BulkSendService } from '../../services/bulk-send.service';
import { BulkTaskPanelComponent } from './bulk-task-panel.component';

const makeQueue = (overrides: Partial<BulkQueue> = {}): BulkQueue => ({
  template: 'Olá {nome}',
  items: [
    { jid: 'a@c.us', name: 'Ana', status: 'done' },
    { jid: 'b@c.us', name: 'Bob', status: 'pending' },
    { jid: 'c@c.us', name: 'Cia', status: 'skipped' }
  ],
  isPaused: false,
  createdAt: new Date().toISOString(),
  ...overrides
});

describe('BulkTaskPanelComponent', () => {
  let fixture: ComponentFixture<BulkTaskPanelComponent>;
  let component: BulkTaskPanelComponent;
  let queue$: BehaviorSubject<BulkQueue | null>;
  let bulkSendSpy: jasmine.SpyObj<BulkSendService>;
  let canSendCurrent = true;
  let isSendingCurrent = false;

  beforeEach(async () => {
    queue$ = new BehaviorSubject<BulkQueue | null>(null);
    bulkSendSpy = jasmine.createSpyObj('BulkSendService', ['pause', 'resume', 'skipCurrent', 'cancel', 'sendCurrent'], {
      queue$: queue$.asObservable(),
      canSendCurrent: true,
      isSendingCurrent: false
    });
    Object.defineProperty(bulkSendSpy, 'canSendCurrent', {
      configurable: true,
      get: () => canSendCurrent
    });
    Object.defineProperty(bulkSendSpy, 'isSendingCurrent', {
      configurable: true,
      get: () => isSendingCurrent
    });

    await TestBed.configureTestingModule({
      declarations: [BulkTaskPanelComponent],
      providers: [{ provide: BulkSendService, useValue: bulkSendSpy }],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(BulkTaskPanelComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  it('queue is null initially', () => {
    expect(component.queue).toBeNull();
  });

  it('updates queue when service emits', () => {
    const q = makeQueue();
    queue$.next(q);
    expect(component.queue).toEqual(q);
    expect(component.visibleItems).toEqual(q.items);
  });

  it('resets isMinimized when queue becomes null', () => {
    queue$.next(makeQueue());
    component.isMinimized = true;
    queue$.next(null);
    expect(component.isMinimized).toBeFalse();
  });

  describe('progress getter', () => {
    it('returns zeroes when no queue', () => {
      const p = component.progress;
      expect(p).toEqual({ done: 0, total: 0, percent: 0 });
    });

    it('counts done and skipped as completed', () => {
      queue$.next(makeQueue());
      const p = component.progress;
      expect(p.total).toBe(3);
      expect(p.done).toBe(2); // 'done' + 'skipped'
      expect(p.percent).toBe(67);
    });

    it('returns 0 percent for empty items array', () => {
      queue$.next(makeQueue({ items: [] }));
      expect(component.progress.percent).toBe(0);
    });

    it('returns 100 percent when all items done', () => {
      queue$.next(makeQueue({
        items: [
          { jid: 'a@c.us', name: 'A', status: 'done' },
          { jid: 'b@c.us', name: 'B', status: 'done' }
        ]
      }));
      expect(component.progress.percent).toBe(100);
    });
  });

  it('limits rendered contacts when the queue is very large', () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      jid: `${index}@c.us`,
      name: `Contato ${index}`,
      status: index === 18 ? 'current' as const : index < 18 ? 'done' as const : 'pending' as const
    }));

    queue$.next(makeQueue({ items }));

    expect(component.visibleItems.length).toBe(18);
    expect(component.hiddenItemCount).toBe(22);
  });

  it('toggleMinimize flips isMinimized', () => {
    expect(component.isMinimized).toBeFalse();
    component.toggleMinimize();
    expect(component.isMinimized).toBeTrue();
    component.toggleMinimize();
    expect(component.isMinimized).toBeFalse();
  });

  it('pause delegates to service', () => {
    component.pause();
    expect(bulkSendSpy.pause).toHaveBeenCalled();
  });

  it('resume delegates to service', () => {
    component.resume();
    expect(bulkSendSpy.resume).toHaveBeenCalled();
  });

  it('skip delegates to service', () => {
    component.skip();
    expect(bulkSendSpy.skipCurrent).toHaveBeenCalled();
  });

  it('send delegates to service', () => {
    component.send();
    expect(bulkSendSpy.sendCurrent).toHaveBeenCalled();
  });

  it('Enter sends the current item when focus is outside interactive controls', () => {
    queue$.next(makeQueue());
    canSendCurrent = true;

    component.onKeydown({ key: 'Enter', preventDefault: jasmine.createSpy('preventDefault'), target: document.body } as unknown as KeyboardEvent);

    expect(bulkSendSpy.sendCurrent).toHaveBeenCalled();
  });

  it('ignores Escape because skip now requires click', () => {
    queue$.next(makeQueue());

    component.onKeydown({ key: 'Escape', preventDefault: jasmine.createSpy('preventDefault') } as unknown as KeyboardEvent);

    expect(bulkSendSpy.skipCurrent).not.toHaveBeenCalled();
  });

  it('cancel opens the in-app confirm overlay without blocking the renderer', () => {
    isSendingCurrent = false;
    queue$.next(makeQueue());
    component.cancel();
    expect(component.isCancelConfirmOpen).toBeTrue();
    expect(bulkSendSpy.cancel).not.toHaveBeenCalled();
  });

  it('confirmCancel delegates to service and closes the overlay', () => {
    isSendingCurrent = false;
    queue$.next(makeQueue());
    component.cancel();
    component.confirmCancel();
    expect(bulkSendSpy.cancel).toHaveBeenCalled();
    expect(component.isCancelConfirmOpen).toBeFalse();
  });

  it('dismissCancel closes the overlay without cancelling', () => {
    isSendingCurrent = false;
    queue$.next(makeQueue());
    component.cancel();
    component.dismissCancel();
    expect(bulkSendSpy.cancel).not.toHaveBeenCalled();
    expect(component.isCancelConfirmOpen).toBeFalse();
  });

  it('cancel is blocked while the current item is sending', () => {
    queue$.next(makeQueue());
    isSendingCurrent = true;
    component.cancel();
    expect(component.isCancelConfirmOpen).toBeFalse();
  });

  it('resets the confirm overlay when the queue clears', () => {
    isSendingCurrent = false;
    queue$.next(makeQueue());
    component.cancel();
    expect(component.isCancelConfirmOpen).toBeTrue();
    queue$.next(null);
    expect(component.isCancelConfirmOpen).toBeFalse();
  });

  it('Escape closes the confirm overlay when open', () => {
    isSendingCurrent = false;
    queue$.next(makeQueue());
    component.cancel();

    component.onKeydown({ key: 'Escape', preventDefault: jasmine.createSpy('preventDefault') } as unknown as KeyboardEvent);

    expect(component.isCancelConfirmOpen).toBeFalse();
  });

  it('ignores Enter while the current item is still sending', () => {
    queue$.next(makeQueue());
    canSendCurrent = false;
    isSendingCurrent = true;

    component.onKeydown({ key: 'Enter', preventDefault: jasmine.createSpy('preventDefault'), target: document.body } as unknown as KeyboardEvent);

    expect(bulkSendSpy.sendCurrent).not.toHaveBeenCalled();
  });

  it('disables skip, cancel and send while the current item is still sending', () => {
    queue$.next(makeQueue());
    canSendCurrent = false;
    isSendingCurrent = true;
    fixture.detectChanges();

    const buttons = Array.from(fixture.nativeElement.querySelectorAll('.btn-control')) as HTMLButtonElement[];

    expect(buttons[1].disabled).toBeTrue();
    expect(buttons[2].disabled).toBeTrue();
    expect(buttons[3].disabled).toBeTrue();
  });

  it('renders the four bulk action buttons with shortcuts', () => {
    queue$.next(makeQueue());
    fixture.detectChanges();

    const buttons = Array.from(fixture.nativeElement.querySelectorAll('.btn-control')) as HTMLButtonElement[];
    const controls = buttons.map(button => {
      const label = button.querySelector('.btn-control__label')?.textContent?.trim();
      const shortcut = button.querySelector('.btn-control__shortcut')?.textContent?.trim();
      return shortcut ? `${label} ${shortcut}` : label;
    });

    expect(controls).toEqual([
      'Pausar',
      'Pular',
      'Cancelar',
      'Enviar Enter'
    ]);
  });
});
