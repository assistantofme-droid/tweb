/*
 * Stable TL ids for backend (MongoDB) objects.
 *
 * TL peers are numeric, the backend addresses everything by 24-hex ObjectId.
 * Users and conversations get a 52-bit id (safe as a JS number), messages an
 * int32 that keeps backend order, media a 60-bit id (a Long, kept as a string).
 */

import tsNow from '@helpers/tsNow';

const MONGO_ID_REGEXP = /^[0-9a-f]{24}$/i;

export function isMongoId(id: string): boolean {
  return typeof(id) === 'string' && MONGO_ID_REGEXP.test(id);
}

function hashString(str: string): number {
  let hash = 0;
  for(let i = 0; i < str.length; ++i) {
    hash = (Math.imul(hash, 31) + str.charCodeAt(i)) | 0;
  }

  return Math.abs(hash);
}

/**
 * User / group / channel id: the last 52 bits of the ObjectId (always > 0).
 */
export function idFromMongoId(mongoId: string): number {
  const tail = mongoId.length > 13 ? mongoId.slice(-13) : mongoId;
  const id = parseInt(tail, 16);
  if(Number.isNaN(id)) {
    return hashString(mongoId) || 1;
  }

  return id || 1;
}

/**
 * Message id. Messages created by the backend carry a global sequence number
 * in their ObjectId (timestamp | "7e9c" | seq), which keeps them in
 * chronological order. Anything else falls back to the 28-bit tail.
 * Always positive: negative ids are local, not yet sent, messages.
 */
export function idFromMongoIdInt32(mongoId: string): number {
  if(mongoId?.length === 24 && mongoId.slice(8, 16).toLowerCase() === '37653963') {
    const seq = parseInt(mongoId.slice(16), 16);
    if(!Number.isNaN(seq)) {
      return (seq & 0x7FFFFFFF) || 1;
    }
  }

  const tail = mongoId.length > 7 ? mongoId.slice(-7) : mongoId;
  const id = parseInt(tail, 16);
  if(Number.isNaN(id)) {
    return (hashString(mongoId) & 0x0FFFFFFF) || 1;
  }

  return (id & 0x0FFFFFFF) || 1;
}

function fnv1a(str: string, seed: number) {
  let hash = seed >>> 0;
  for(let i = 0; i < str.length; ++i) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  return hash >>> 0;
}

/**
 * Photo / document id for a media URL (52-bit, as a decimal Long string).
 * The same URL always gets the same id.
 */
export function idForUrl(url: string): string {
  const high = fnv1a(url, 2166136261) & 0x3FFFFFF;
  const low = fnv1a(url, 0x7E9C7E9C) & 0x3FFFFFF;
  return ((high * 0x4000000 + low) || 1).toString();
}

export function parseIsoToEpochSeconds(iso: string): number {
  if(!iso) {
    return tsNow(true);
  }

  const time = Date.parse(iso);
  return Number.isNaN(time) ? tsNow(true) : Math.floor(time / 1000);
}

export function toIsoString(seconds: number) {
  return new Date(seconds * 1000).toISOString();
}
