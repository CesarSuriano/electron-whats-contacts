import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ScheduleListLauncherService {
  private pendingOpenCount = 0;
  private readonly openSubject = new Subject<void>();

  get openRequests$(): Observable<void> {
    return this.openSubject.asObservable();
  }

  requestOpen(): void {
    this.pendingOpenCount += 1;
    this.openSubject.next();
  }

  consumePendingOpen(): boolean {
    if (this.pendingOpenCount <= 0) {
      return false;
    }

    this.pendingOpenCount -= 1;
    return true;
  }
}