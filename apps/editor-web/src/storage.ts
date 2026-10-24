import type { HostStorage } from '@fdw/editor-ui';

// The keys of the storage, as on the desktop, where they name files.
const storageKey = /^[\w.-]+$/;

function checkKey(key: string): void {
  if (!storageKey.test(key) || key.startsWith('.')) {
    throw new Error(`Invalid storage key: ${key}`);
  }
}

const storeName = 'documents';

// Resolves with the result of the request once its transaction is done.
function done<T>(transaction: IDBTransaction, request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () =>
      reject(transaction.error ?? new Error('The transaction was aborted'));
  });
}

/**
 * The storage of the web editor: the documents in IndexedDB, by key, as
 * JSON text, the same values the files of the desktop keep.
 */
export function indexedDbStorage(name = 'fdw-editor'): HostStorage {
  let opened: Promise<IDBDatabase> | undefined;
  const database = () =>
    (opened ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore(storeName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  return {
    async read(key) {
      checkKey(key);
      const transaction = (await database()).transaction(storeName);
      const request = transaction.objectStore(storeName).get(key);
      const text = (await done(transaction, request)) as string | undefined;
      return text === undefined ? undefined : (JSON.parse(text) as unknown);
    },
    async write(key, value) {
      checkKey(key);
      const transaction = (await database()).transaction(
        storeName,
        'readwrite',
      );
      const store = transaction.objectStore(storeName);
      await done(transaction, store.put(JSON.stringify(value), key));
    },
  };
}

/**
 * A storage that keeps nothing between page loads: the editors of the
 * documentation start from the default layout at each visit.
 */
export function memoryStorage(): HostStorage {
  const documents = new Map<string, string>();
  return {
    async read(key) {
      checkKey(key);
      const text = documents.get(key);
      return text === undefined ? undefined : (JSON.parse(text) as unknown);
    },
    async write(key, value) {
      checkKey(key);
      documents.set(key, JSON.stringify(value));
    },
  };
}
