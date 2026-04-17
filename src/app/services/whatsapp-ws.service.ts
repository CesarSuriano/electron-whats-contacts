import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';

export interface WsMessage<T = unknown> {
  type: string;
  payload: T;
}

const WS_URL = 'ws://localhost:3344';
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;

@Injectable({ providedIn: 'root' })
export class WhatsappWsService implements OnDestroy {
  private socket: WebSocket | null = null;
  private readonly messagesSubject = new Subject<WsMessage>();
  private readonly connectedSubject = new Subject<boolean>();
  private reconnectTimer: number | null = null;
  private reconnectDelay = RECONNECT_DELAY_MS;
  private intentionalClose = false;

  readonly messages$: Observable<WsMessage> = this.messagesSubject.asObservable();
  readonly connected$: Observable<boolean> = this.connectedSubject.asObservable();

  constructor(private zone: NgZone) {}

  ngOnDestroy(): void {
    this.disconnect();
  }

  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.intentionalClose = false;
    this.createSocket();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  /** Observable for a specific event type. */
  on<T = unknown>(type: string): Observable<T> {
    return this.messages$.pipe(
      filter(msg => msg.type === type),
      map(msg => msg.payload as T)
    );
  }

  private createSocket(): void {
    try {
      this.socket = new WebSocket(WS_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.zone.run(() => {
        this.reconnectDelay = RECONNECT_DELAY_MS;
        this.connectedSubject.next(true);
      });
    };

    this.socket.onmessage = (event) => {
      try {
        const parsed: WsMessage = JSON.parse(event.data);
        if (parsed && typeof parsed.type === 'string') {
          this.zone.run(() => this.messagesSubject.next(parsed));
        }
      } catch {
        // ignore malformed messages
      }
    };

    this.socket.onclose = () => {
      this.zone.run(() => this.connectedSubject.next(false));
      this.socket = null;

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    this.socket.onerror = () => {
      // onclose will fire after onerror
    };
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.createSocket();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, MAX_RECONNECT_DELAY_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
