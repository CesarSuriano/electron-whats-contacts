import type { SessionSnapshot, SessionStatus } from '../domain/types.js';
import { telemetry } from '../telemetry/Telemetry.js';

export class SessionState {
  private _status: SessionStatus = 'initializing';
  private _qr: string | null = null;
  private _lastError: string = '';
  // Telemetria: quando entrou no status atual e quando a bridge subiu, para
  // medir quanto tempo a sessão ficou em cada etapa (ex.: preso carregando).
  private statusSince = Date.now();
  private readonly createdAt = Date.now();

  constructor(private readonly instanceName: string, private readonly jidProvider: () => string) {}

  get status(): SessionStatus {
    return this._status;
  }

  set status(value: SessionStatus) {
    if (value !== this._status) {
      const now = Date.now();
      telemetry.track('session.status', {
        from: this._status,
        to: value,
        msInPrevious: now - this.statusSince,
        msSinceBridgeStart: now - this.createdAt,
        lastError: this._lastError || null
      });
      this.statusSince = now;
    }
    this._status = value;
  }

  get qr(): string | null {
    return this._qr;
  }

  set qr(value: string | null) {
    if (value && !this._qr) {
      telemetry.track('session.qr_shown', { status: this._status, msSinceBridgeStart: Date.now() - this.createdAt });
    }
    this._qr = value;
  }

  get lastError(): string {
    return this._lastError;
  }

  set lastError(value: string) {
    if (value && value !== this._lastError) {
      telemetry.track('session.error_message', { status: this._status, message: value });
    }
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
