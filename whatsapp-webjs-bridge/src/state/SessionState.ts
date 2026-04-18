import type { SessionSnapshot, SessionStatus } from '../domain/types.js';

export class SessionState {
  private _status: SessionStatus = 'initializing';
  private _qr: string | null = null;
  private _lastError: string = '';

  constructor(private readonly instanceName: string, private readonly jidProvider: () => string) {}

  get status(): SessionStatus {
    return this._status;
  }

  set status(value: SessionStatus) {
    this._status = value;
  }

  get qr(): string | null {
    return this._qr;
  }

  set qr(value: string | null) {
    this._qr = value;
  }

  get lastError(): string {
    return this._lastError;
  }

  set lastError(value: string) {
    this._lastError = value;
  }

  isReady(): boolean {
    return this._status === 'ready';
  }

  snapshot(): SessionSnapshot {
    return {
      instanceName: this.instanceName,
      status: this._status,
      jid: this._status === 'ready' ? this.jidProvider() : '',
      hasQr: Boolean(this._qr),
      qr: this._qr,
      lastError: this._lastError
    };
  }
}
