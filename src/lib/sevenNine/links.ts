/*
 * 7eve9Chat site links (what t.me is for Telegram).
 *
 * The site (and the Android client) use:
 *   /<username>                     users, and public groups / channels
 *   /gp/<handle or id>              a group
 *   /cl/<handle or id>              a channel
 *   /pv/<handle or id>              a private chat
 *   /invite/<code>                  an invite link
 */

import {SEVEN_NINE_ORIGIN} from '@lib/sevenNine/config';

export const SITE_HOST = new URL(SEVEN_NINE_ORIGIN).host;
export const SITE_LINK = SEVEN_NINE_ORIGIN + '/';
export const SITE_LINK_SHORT = SITE_HOST + '/';

const USERNAME_PATH = /^\/[a-zA-Z0-9][a-zA-Z0-9_]{3,31}\/?$/;
const RESERVED_PATHS = ['admin', 'login', 'register', 'uploads', 'api', 'socket.io'];

export function isSiteHost(hostname: string) {
  hostname = (hostname || '').toLowerCase();
  return hostname === SITE_HOST || hostname === 'www.' + SITE_HOST;
}

/**
 * A site link as the t.me link the rest of the app already understands
 * (`/gp/name` -> `t.me/name`, `/invite/CODE` -> `t.me/+CODE`), or
 * undefined for any other url.
 */
export function mapSiteUrl(url: URL): URL {
  if(!url || !['http:', 'https:'].includes(url.protocol) || !isSiteHost(url.hostname)) {
    return;
  }

  const path = url.pathname || '';
  let mapped: string;
  if(path.startsWith('/invite/') && path.length > 8) {
    mapped = '/+' + path.slice(8);
  } else if(/^\/(gp|cl|pv)\/./.test(path)) {
    mapped = '/' + path.slice(4);
  } else if(USERNAME_PATH.test(path) && !RESERVED_PATHS.includes(path.slice(1).replace(/\/$/, '').toLowerCase())) {
    mapped = path.replace(/\/$/, '');
  } else {
    return;
  }

  return new URL('https://t.me' + mapped + url.search + url.hash);
}
