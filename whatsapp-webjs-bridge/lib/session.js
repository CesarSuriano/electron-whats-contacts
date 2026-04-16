/**
 * WhatsApp client session lifecycle management.
 * Call init(client, sessionState, instanceName) once the client is created.
 */

import { normalizeJid } from './utils.js';

let _client = null;
let _sessionState = null;
let _instanceName = '';
let initializePromise = null;

export function init(client, sessionState, instanceName) {
  _client = client;
  _sessionState = sessionState;
  _instanceName = instanceName;
}

export function getInstanceSummary() {
  const connected = _sessionState.status === 'ready';
  return {
    name: _instanceName,
    token: 'local-session',
    connected,
    jid: connected ? normalizeJid(_client?.info?.wid?._serialized || '') : '',
    webhook: ''
  };
}

export function getSessionSnapshot() {
  return {
    instanceName: _instanceName,
    status: _sessionState.status,
    hasQr: Boolean(_sessionState.qr),
    qr: _sessionState.qr,
    lastError: _sessionState.lastError
  };
}

export async function ensureClientInitialized() {
  if (initializePromise) {
    return initializePromise;
  }

  _sessionState.status = 'initializing';
  _sessionState.lastError = '';

  initializePromise = _client.initialize()
    .catch(error => {
      _sessionState.status = 'init_error';
      _sessionState.lastError = error?.message || 'Falha ao inicializar cliente';
      throw error;
    })
    .finally(() => {
      initializePromise = null;
    });

  return initializePromise;
}

export async function disconnectClientSession() {
  try {
    await _client.logout();
  } catch {
    // ignore logout errors
  }

  try {
    await _client.destroy();
  } catch {
    // ignore destroy errors
  }

  _sessionState.status = 'disconnected';
  _sessionState.qr = null;
  _sessionState.lastError = '';
}
