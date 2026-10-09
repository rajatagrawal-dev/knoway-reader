import type { DocDataKind, DocumentMeta, LibraryStorage } from "./types.ts";

// Web storage: the same LibraryStorage contract on IndexedDB. The desktop
// app uses plain files instead (desktop.ts); this backend exists so the
// browser build keeps working, and is kept deliberately small.

const DB_NAME = "musereader";
const DB_VERSION = 1;
const DOCUMENTS = "documents"; // DocumentMeta, keyed by docId
const FILES = "files"; // PDF bytes, keyed by docId
const DOC_DATA = "docData"; // any DocDataKind value, keyed by `${docId}/${kind}`

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Resolves once the transaction has committed, not merely once its request
// succeeded — a save isn't done until it's durable.
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(DOCUMENTS)) db.createObjectStore(DOCUMENTS, { keyPath: "docId" });
    if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
    if (!db.objectStoreNames.contains(DOC_DATA)) db.createObjectStore(DOC_DATA);
  };
  return promisify(request);
}

export function createIndexedDbStorage(): LibraryStorage {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => {
    dbPromise ??= openDatabase();
    dbPromise.catch(() => {
      dbPromise = null;
    });
    return dbPromise;
  };

  const get = async <T>(store: string, key: IDBValidKey): Promise<T | null> => {
    const tx = (await db()).transaction(store, "readonly");
    const value = await promisify(tx.objectStore(store).get(key));
    return (value ?? null) as T | null;
  };

  const put = async (store: string, value: unknown, key?: IDBValidKey): Promise<void> => {
    const tx = (await db()).transaction(store, "readwrite");
    const objectStore = tx.objectStore(store);
    // An inline-key store (DOCUMENTS) must not be passed a key at all.
    if (key === undefined) objectStore.put(value);
    else objectStore.put(value, key);
    await committed(tx);
  };

  const dataKey = (docId: string, kind: DocDataKind) => `${docId}/${kind}`;

  return {
    async listDocuments() {
      const tx = (await db()).transaction(DOCUMENTS, "readonly");
      return promisify(tx.objectStore(DOCUMENTS).getAll() as IDBRequest<DocumentMeta[]>);
    },
    getMeta(docId) {
      return get<DocumentMeta>(DOCUMENTS, docId);
    },
    putMeta(meta) {
      return put(DOCUMENTS, meta);
    },
    getFile(docId) {
      return get<Uint8Array>(FILES, docId);
    },
    async putFile(docId, bytes) {
      // The browser may evict site data under storage pressure unless asked
      // not to; the first import is when there's something worth keeping.
      void navigator.storage?.persist?.().catch(() => false);
      return put(FILES, bytes, docId);
    },
    getData<T>(docId: string, kind: DocDataKind) {
      return get<T>(DOC_DATA, dataKey(docId, kind));
    },
    putData(docId, kind, value) {
      return put(DOC_DATA, value, dataKey(docId, kind));
    },
    async removeDocument(docId) {
      const tx = (await db()).transaction([DOCUMENTS, FILES, DOC_DATA], "readwrite");
      tx.objectStore(DOCUMENTS).delete(docId);
      tx.objectStore(FILES).delete(docId);
      // Every `${docId}/…` key: "0" is the character right after "/".
      tx.objectStore(DOC_DATA).delete(IDBKeyRange.bound(`${docId}/`, `${docId}0`, false, true));
      await committed(tx);
    },
  };
}
