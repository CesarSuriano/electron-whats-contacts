import { WebSocket, WebSocketServer } from 'ws';
import type { Server as HttpServer } from 'http';

const HEARTBEAT_INTERVAL_MS = 30000;
const SNAPSHOT_REPLAY_ORDER: BroadcastType[] = ['labels_updated', 'session_state'];
const SNAPSHOT_TYPES = new Set<BroadcastType>(SNAPSHOT_REPLAY_ORDER);

export type BroadcastType =
  | 'new_message'
  | 'message_ack'
  | 'contacts_updated'
  | 'labels_updated'
  | 'session_state';

type TrackedWebSocket = WebSocket & { isAlive?: boolean };

export interface WebSocketBroadcasterOptions {
  allowedOrigins?: string[];
}

export class WebSocketBroadcaster {
  private wss: WebSocketServer | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private snapshotMessages = new Map<BroadcastType, string>();

  attach(httpServer: HttpServer, options: WebSocketBroadcasterOptions = {}): WebSocketServer {
    const allowedOrigins = options.allowedOrigins ?? [];

    this.wss = new WebSocketServer({
      server: httpServer,
      verifyClient: (info: { origin: string }) => {
        const origin = info.origin;
        if (!origin || origin === 'null') return true;
        if (origin.startsWith('file://')) return true;
        if (allowedOrigins.includes('*')) return true;
        return allowedOrigins.includes(origin);
      }
    });

    this.wss.on('connection', (socket: WebSocket) => {
      const tracked = socket as TrackedWebSocket;
      tracked.isAlive = true;
      tracked.on('pong', () => {
        tracked.isAlive = true;
      });
      tracked.on('error', () => {
        // silent
      });

      SNAPSHOT_REPLAY_ORDER.forEach(type => {
        const snapshot = this.snapshotMessages.get(type);
        if (snapshot) {
          tracked.send(snapshot);
        }
      });
    });

    this.heartbeatTimer = setInterval(() => {
      if (!this.wss) return;
      this.wss.clients.forEach(socket => {
        const tracked = socket as TrackedWebSocket;
        if (!tracked.isAlive) {
          tracked.terminate();
          return;
        }
        tracked.isAlive = false;
        tracked.ping();
      });
    }, HEARTBEAT_INTERVAL_MS);

    this.wss.on('close', () => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    });

    return this.wss;
  }

  broadcast(type: BroadcastType, payload: unknown): void {
    if (!this.wss) return;

    const message = JSON.stringify({ type, payload });
    if (SNAPSHOT_TYPES.has(type)) {
      this.snapshotMessages.set(type, message);
    }
    this.wss.clients.forEach(socket => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
      }
    });
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }
}
