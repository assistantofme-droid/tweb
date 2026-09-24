/*
 * Minimal REST client for the 7eve9Chat backend (JSON + multipart uploads,
 * bearer-token auth).
 *
 * Own-message echoes: the backend emits "new_message" to every participant,
 * the sender included, before it answers the send request. Telegram never
 * echoes a client's own send back (the send response carries the message), so
 * while a send is in flight socket messages wait (see SocketBridge), and
 * messages this client sent are dropped once the response has them.
 */

import {SEVEN_NINE_API} from '@lib/sevenNine/config';
import {RestException} from '@lib/sevenNine/errors';

export type MultipartFile = {
  field: string,
  blob: Blob,
  fileName: string
};

const REQUEST_TIMEOUT = 30e3;
const UPLOAD_TIMEOUT = 10 * 60e3;
const OWN_SENT_LIMIT = 500;
const MONGO_ID_FIELD = /"_id"\s*:\s*"([0-9a-f]{24})"/g;

function isOwnSendPath(method: string, path: string) {
  return method === 'POST' && (
    path === '/messages' ||
    path === '/messages/forward' ||
    path === '/business/quick-replies/messages'
  );
}

export default class RestHttp {
  private ownSendsInFlight = 0;
  private ownSentIds: Set<string> = new Set();

  constructor(private getToken: () => string) {}

  public isOwnSendInFlight() {
    return this.ownSendsInFlight > 0;
  }

  public wasSentByThisClient(mongoId: string) {
    return !!mongoId && this.ownSentIds.has(mongoId);
  }

  private rememberOwnSent(text: string) {
    if(!text) return;
    MONGO_ID_FIELD.lastIndex = 0;
    let match: RegExpExecArray;
    while(match = MONGO_ID_FIELD.exec(text)) {
      this.ownSentIds.add(match[1]);
    }

    if(this.ownSentIds.size > OWN_SENT_LIMIT) {
      const excess = this.ownSentIds.size - OWN_SENT_LIMIT;
      let i = 0;
      for(const id of this.ownSentIds) {
        if(i++ >= excess) break;
        this.ownSentIds.delete(id);
      }
    }
  }

  private async fetchText(method: string, path: string, init: RequestInit, auth: boolean, timeout: number) {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      ...(init.headers as Record<string, string>)
    };

    const token = auth ? this.getToken() : undefined;
    if(token) {
      headers['Authorization'] = 'Bearer ' + token;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const ownSend = isOwnSendPath(method, path);
    if(ownSend) ++this.ownSendsInFlight;
    try {
      const response = await fetch(SEVEN_NINE_API + path, {
        ...init,
        method,
        headers,
        signal: controller.signal
      });

      const text = await response.text();
      if(!response.ok) {
        let message = 'Request failed';
        try {
          const json = text ? JSON.parse(text) : undefined;
          message = json?.message || json?.error || message;
        } catch(err) {}

        throw new RestException(response.status, message);
      }

      if(ownSend) {
        this.rememberOwnSent(text);
      }

      return text;
    } finally {
      clearTimeout(timer);
      if(ownSend) --this.ownSendsInFlight;
    }
  }

  public requestText(method: string, path: string, body?: any, auth = true) {
    return this.fetchText(method, path, body === undefined ? {} : {
      body: JSON.stringify(body),
      headers: {'Content-Type': 'application/json'}
    }, auth, REQUEST_TIMEOUT);
  }

  public async request<T = any>(method: string, path: string, body?: any, auth = true): Promise<T> {
    const text = await this.requestText(method, path, body, auth);
    try {
      const json = text ? JSON.parse(text) : {};
      return (json && typeof(json) === 'object' ? json : {}) as T;
    } catch(err) {
      return {} as T;
    }
  }

  public async requestArray<T = any>(method: string, path: string, body?: any, auth = true): Promise<T[]> {
    const text = await this.requestText(method, path, body, auth);
    try {
      const json = text ? JSON.parse(text) : [];
      return Array.isArray(json) ? json : [];
    } catch(err) {
      return [];
    }
  }

  // multipart/form-data upload (the backend's multer-based endpoints)
  public async requestMultipart<T = any>(
    method: string,
    path: string,
    fields: Record<string, any>,
    files: MultipartFile[]
  ): Promise<T> {
    const formData = new FormData();
    for(const key in fields) {
      const value = fields[key];
      if(value === undefined || value === null) continue;
      formData.append(key, typeof(value) === 'object' ? JSON.stringify(value) : String(value));
    }

    for(const file of files) {
      formData.append(file.field, file.blob, file.fileName);
    }

    const text = await this.fetchText(method, path, {body: formData}, true, UPLOAD_TIMEOUT);
    try {
      const json = text ? JSON.parse(text) : {};
      return (json && typeof(json) === 'object' ? json : {}) as T;
    } catch(err) {
      return {} as T;
    }
  }
}
