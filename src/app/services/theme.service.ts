import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _isDark$ = new BehaviorSubject<boolean>(
    document.body.classList.contains('theme-dark')
  );

  readonly isDark$ = this._isDark$.asObservable();

  get isDark(): boolean {
    return this._isDark$.value;
  }

  toggle(): void {
    const next = !this._isDark$.value;
    this._isDark$.next(next);
    document.body.classList.toggle('theme-dark', next);
  }
}
