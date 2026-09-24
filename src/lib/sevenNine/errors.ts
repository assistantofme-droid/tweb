/*
 * Backend errors -> Telegram API errors, so the app shows its own texts
 * (slow mode timer, "sending media isn't allowed", invalid code, ...).
 */

export class RestException extends Error {
  constructor(public statusCode: number, public serverMessage: string) {
    super(`HTTP ${statusCode}: ${serverMessage}`);
  }
}

// Features the backend has no equivalent of: code 406 keeps them silent
// (no error toasts), see ApiManager.invokeApi.
export const UNIMPLEMENTED_PREFIX = 'REST_BRIDGE_UNIMPLEMENTED';

export function tlError(code: number, type: string, message?: string): ApiError {
  const error: ApiError = {code, type: type as ErrorType};
  if(message) {
    error.message = message;
  }

  return error;
}

export function unimplementedError(method: string) {
  return tlError(406, UNIMPLEMENTED_PREFIX + ':' + method);
}

// Network / unexpected failures: silent, the failed action shows the problem
export function genericError(err: any): ApiError {
  if(err && typeof(err) === 'object' && 'type' in err && 'code' in err) {
    return err as ApiError;
  }

  if(err instanceof RestException) {
    return restError(err.statusCode, err.serverMessage);
  }

  const message = err instanceof Error ? err.message : String(err);
  return tlError(406, 'NETWORK_ERROR', message);
}

export function restError(statusCode: number, message: string): ApiError {
  const m = message || '';
  const lower = m.toLowerCase();
  if(/^[A-Z][A-Z0-9_]+$/.test(m)) {
    return tlError(400, m);
  }

  if(statusCode === 401) {
    // an expired / revoked session logs out (ApiManager does that on 401),
    // anything else is a plain permission error
    return /token|jwt|session|not authorized, no/i.test(m) ?
      tlError(401, 'AUTH_KEY_UNREGISTERED', m) :
      tlError(403, 'CHAT_ADMIN_REQUIRED', m);
  }

  if(statusCode === 429 && lower.includes('slow mode')) {
    const wait = m.match(/(\d+)/);
    return tlError(420, 'SLOWMODE_WAIT_' + (wait ? wait[1] : '10'));
  }

  if(statusCode === 429) {
    return tlError(420, 'FLOOD_WAIT_10', m);
  }

  const mapped: [string, number, string][] = [
    ['banned from this group', 400, 'USER_BANNED_IN_CHANNEL'],
    ['restricted from sending messages', 403, 'CHAT_WRITE_FORBIDDEN'],
    ['restricted from sending media', 403, 'CHAT_SEND_MEDIA_FORBIDDEN'],
    ['restricted from sending files', 403, 'CHAT_SEND_DOCS_FORBIDDEN'],
    ['restricted from sending voice', 403, 'CHAT_SEND_VOICES_FORBIDDEN'],
    ['restricted from creating polls', 403, 'CHAT_SEND_POLL_FORBIDDEN'],
    ['restricted from sending gifs', 403, 'CHAT_SEND_GIFS_FORBIDDEN'],
    ['only admins can send messages in a channel', 403, 'CHAT_ADMIN_REQUIRED']
  ];

  for(const [needle, code, type] of mapped) {
    if(lower.includes(needle)) {
      return tlError(code, type, m);
    }
  }

  return tlError(statusCode >= 500 ? 406 : statusCode, 'REQUEST_FAILED', m);
}

export function isSilentError(error: ApiError) {
  const type = error?.type as string;
  return !!type && (
    type.startsWith(UNIMPLEMENTED_PREFIX) ||
    type === 'NETWORK_ERROR' ||
    type === 'REQUEST_FAILED'
  );
}
