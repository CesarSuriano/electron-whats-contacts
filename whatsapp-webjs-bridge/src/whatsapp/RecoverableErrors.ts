const RECOVERABLE_INIT_ERROR = /Execution context was destroyed|Target closed|Session closed|auth timeout/i;
const RECOVERABLE_PROCESS_CONTEXT_ERROR = /Execution context was destroyed|Target closed|Session closed|Attempted to use detached Frame|Protocol error\s*\(Runtime\.callFunctionOn\)/i;
const LOCAL_AUTH_LOCK_ERROR = /EBUSY: resource busy or locked/i;
const LOCAL_AUTH_LOCK_PATH = /LocalAuth\.js|first_party_sets\.db-journal/i;

function getCombinedErrorText(error: unknown): string {
  const message = String((error as { message?: unknown } | null)?.message || error || '');
  const stack = String((error as { stack?: unknown } | null)?.stack || '');
  return `${message}\n${stack}`.trim();
}

export function getErrorMessage(error: unknown): string {
  return String((error as { message?: unknown } | null)?.message || error || '');
}

export function isRecoverableInitError(error: unknown): boolean {
  return RECOVERABLE_INIT_ERROR.test(getCombinedErrorText(error));
}

export function isRecoverableLocalAuthLockError(error: unknown): boolean {
  const combined = getCombinedErrorText(error);
  return LOCAL_AUTH_LOCK_ERROR.test(combined) && LOCAL_AUTH_LOCK_PATH.test(combined);
}

export function isRecoverableProcessError(error: unknown): boolean {
  return isRecoverableLocalAuthLockError(error) || RECOVERABLE_PROCESS_CONTEXT_ERROR.test(getCombinedErrorText(error));
}
