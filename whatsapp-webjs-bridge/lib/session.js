/**
 * WhatsApp client session lifecycle management.
 * Call init(client, sessionState, instanceName) once the client is created.
 */

import { getOwnJid } from './jid.js';

let _client = null;
let _sessionState = null;
let _instanceName = '';
let initializePromise = null;

const RETRYABLE_INIT_ERROR = /Execution context was destroyed|Target closed|Session closed/i;
const INIT_RETRY_DELAY_MS = 900;

function isRetryableInitError(error) {
  const message = String(error?.message || '');
  return RETRYABLE_INIT_ERROR.test(message);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function initializeWithRetry(maxAttempts = 2) {
  let attempt = 1;
  while (attempt <= maxAttempts) {
    try {
      await _client.initialize();
      return;
    } catch (error) {
      const canRetry = attempt < maxAttempts && isRetryableInitError(error);
      if (!canRetry) {
        throw error;
      }

      await wait(INIT_RETRY_DELAY_MS * attempt);
      attempt += 1;
    }
  }
}

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
    jid: connected ? getOwnJid() : '',
    webhook: ''
  };
}

export function getSessionSnapshot() {
  return {
    instanceName: _instanceName,
    status: _sessionState.status,
    jid: _sessionState.status === 'ready' ? getOwnJid() : '',
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

  initializePromise = initializeWithRetry()
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
  // Let next connect start from a clean initialization cycle.
  initializePromise = null;

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
