/*
 * 7eve9Chat backend endpoints.
 *
 * The whole app talks to the 7eve9Chat REST + Socket.IO backend (the same one
 * the 7eve9Chat Android client uses) instead of Telegram's MTProto servers.
 * See `restBridge.ts`.
 */

const DEFAULT_ORIGIN = 'https://7eve9craft.ir';

export const SEVEN_NINE_ORIGIN = (import.meta.env.VITE_SEVEN_NINE_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '');
export const SEVEN_NINE_API = SEVEN_NINE_ORIGIN + '/api';
export const SEVEN_NINE_SOCKET = SEVEN_NINE_ORIGIN;
export const SEVEN_NINE_APP_NAME = '7eve9Chat';

// Everything is served from one "data center"
export const SEVEN_NINE_DC_ID = 2;
