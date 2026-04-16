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

  beforeEach(async () => {
    queue$ = new BehaviorSubject<BulkQueue | null>(null);
    bulkSendSpy = jasmine.createSpyObj('BulkSendService', ['pause', 'resume', 'skipCurrent', 'cancel'], {
      queue$: queue$.asObservable()
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

  it('cancel delegates to service when confirmed', () => {
    spyOn(window, 'confirm').and.returnValue(true);
    component.cancel();
    expect(bulkSendSpy.cancel).toHaveBeenCalled();
  });

  it('cancel does not delegate to service when not confirmed', () => {
    spyOn(window, 'confirm').and.returnValue(false);
    component.cancel();
    expect(bulkSendSpy.cancel).not.toHaveBeenCalled();
  });
});
