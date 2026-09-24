/*
 * Small per-account key/value persistence for the REST bridge (peer <->
 * conversation ids, media URLs...), so a reload can keep using the objects the
 * app restored from its own cache.
 */

import debounce from '@helpers/schedulers/debounce';

const DB_NAME = 'sevenNine';
const STORE_NAME = 'kv';
const SAVE_DELAY = 500;

let dbPromise: Promise<IDBDatabase>;
function openDatabase() {
  return dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = undefined;
      reject(request.error);
    };
  });
}

function runRequest<T>(mode: IDBTransactionMode, callback: (store: IDBObjectStore) => IDBRequest<T>) {
  return openDatabase().then((db) => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = callback(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

export default class BridgeStore {
  private dirty: Map<string, () => any> = new Map();

  constructor(private accountNumber: number) {}

  private key(name: string) {
    return this.accountNumber + ':' + name;
  }

  public async load<T>(name: string): Promise<T> {
    try {
      return await runRequest<T>('readonly', (store) => store.get(this.key(name)));
    } catch(err) {
      return undefined;
    }
  }

  /**
   * Saves `getValue()` a bit later (many changes are coalesced into one write).
   */
  public save(name: string, getValue: () => any) {
    this.dirty.set(name, getValue);
    this.flushDebounced();
  }

  private flushDebounced = debounce(() => this.flush(), SAVE_DELAY, false, true);

  public flush() {
    const entries = [...this.dirty];
    this.dirty.clear();
    return Promise.all(entries.map(([name, getValue]) => {
      return runRequest('readwrite', (store) => store.put(getValue(), this.key(name))).catch(() => {});
    }));
  }

  public async clear() {
    this.dirty.clear();
    try {
      const keys = await runRequest<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
      const prefix = this.accountNumber + ':';
      await Promise.all(keys
      .filter((key) => typeof(key) === 'string' && key.startsWith(prefix))
      .map((key) => runRequest('readwrite', (store) => store.delete(key))));
    } catch(err) {}
  }
}
