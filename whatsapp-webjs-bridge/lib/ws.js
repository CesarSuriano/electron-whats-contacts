/**
 * WebSocket server for real-time push events.
 * Broadcasts typed JSON messages to all connected clients.
 *
 * Event types:
 *   new_message   — inbound/outbound message
 *   message_ack   — delivery/read status change
 *   contacts_updated — contacts list changed (after refresh)
 *   session_state — WhatsApp session status change
 */

import { WebSocketServer } from 'ws';

let wss = null;
const HEARTBEAT_INTERVAL_MS = 30000;
let heartbeatTimer = null;

export function createWebSocketServer(httpServer, { allowedOrigins = [] } = {}) {
  wss = new WebSocketServer({
    server: httpServer,
    verifyClient: ({ origin }) => {
      if (!origin || origin === 'null') return true;           // Electron file://
      if (origin.startsWith('file://')) return true;
      if (allowedOrigins.includes('*')) return true;
      return allowedOrigins.includes(origin);
    }
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => { /* silent */ });
  });

  heartbeatTimer = setInterval(() => {
    if (!wss) return;
    wss.clients.forEach(ws => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  });

  return wss;
}

export function broadcast(type, payload) {
  if (!wss) return;

  const message = JSON.stringify({ type, payload });
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
}
