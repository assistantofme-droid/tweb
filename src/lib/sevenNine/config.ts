/*
 * 7eve9Chat backend endpoints.
 *
 * The whole app talks to the 7eve9Chat REST + Socket.IO backend (the same one
 * the 7eve9Chat Android client uses) instead of Telegram's MTProto servers.
 * See `restBridge.ts`.
 *
 * VITE_SEVEN_NINE_SITE    the 7eve9Chat site: public links (/username, /gp/..,
 *                         /invite/..) point here. Default https://7eve9craft.ir
 * VITE_SEVEN_NINE_ORIGIN  where the backend (/api, /uploads, /socket.io) is
 *                         reached. Default: the site itself. A path such as
 *                         `/web-k` means this same server, which proxies
 *                         /web-k/api, /web-k/uploads and /web-k/socket.io to the
 *                         site (see deploy/web-k) — no CORS needed.
 */

const DEFAULT_SITE = 'https://7eve9craft.ir';

const trimSlashes = (url: string) => url.replace(/\/+$/, '');

function resolveOrigin(value: string) {
  return trimSlashes(value.startsWith('/') ? self.location.origin + value : value);
}

export const SEVEN_NINE_SITE = trimSlashes(import.meta.env.VITE_SEVEN_NINE_SITE || DEFAULT_SITE);
export const SEVEN_NINE_ORIGIN = resolveOrigin(import.meta.env.VITE_SEVEN_NINE_ORIGIN || SEVEN_NINE_SITE);
export const SEVEN_NINE_API = SEVEN_NINE_ORIGIN + '/api';
export const SEVEN_NINE_UPLOADS = SEVEN_NINE_ORIGIN + '/uploads/';
// Socket.IO takes the host and the path apart: a path in the URL would be a namespace
export const SEVEN_NINE_SOCKET = new URL(SEVEN_NINE_ORIGIN).origin;
export const SEVEN_NINE_SOCKET_PATH = new URL(SEVEN_NINE_ORIGIN).pathname.replace(/\/+$/, '') + '/socket.io';
export const SEVEN_NINE_APP_NAME = '7eve9Chat';

/** a request to the backend itself (the service worker leaves these alone) */
export function isSevenNineBackendUrl(url: string) {
  return url.startsWith(SEVEN_NINE_API + '/') ||
    url.startsWith(SEVEN_NINE_UPLOADS) ||
    url.startsWith(SEVEN_NINE_SOCKET + SEVEN_NINE_SOCKET_PATH + '/');
}

// Everything is served from one "data center"
export const SEVEN_NINE_DC_ID = 2;

// The app starts in Persian (English stays one tap away)
export const SEVEN_NINE_DEFAULT_LANG_CODE = 'fa';
