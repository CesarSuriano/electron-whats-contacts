import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ManagerLaunchService {
  private readonly quickReplySubject = new Subject<void>();
  private readonly labelSubject = new Subject<void>();

  readonly openQuickReplyManager$ = this.quickReplySubject.asObservable();
  readonly openLabelManager$ = this.labelSubject.asObservable();

  openQuickReplyManager(): void {
    this.quickReplySubject.next();
  }

  openLabelManager(): void {
    this.labelSubject.next();
  }
}
