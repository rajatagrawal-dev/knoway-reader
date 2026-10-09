import type { DocDataKind, DocumentMeta, LibraryStorage } from "./types.ts";

// In-memory storage: the reference implementation of the LibraryStorage
// contract, used by tests. Values are cloned on the way in and out so a
// caller mutating what it got back can't change what's stored — the same
// guarantee the real backends get from serializing.
export function createMemoryStorage(): LibraryStorage {
  const metas = new Map<string, DocumentMeta>();
  const files = new Map<string, Uint8Array>();
  const data = new Map<string, unknown>();
  const dataKey = (docId: string, kind: DocDataKind) => `${docId}/${kind}`;

  return {
    async listDocuments() {
      return [...metas.values()].map((meta) => structuredClone(meta));
    },
    async getMeta(docId) {
      const meta = metas.get(docId);
      return meta ? structuredClone(meta) : null;
    },
    async putMeta(meta) {
      metas.set(meta.docId, structuredClone(meta));
    },
    async getFile(docId) {
      const bytes = files.get(docId);
      return bytes ? bytes.slice() : null;
    },
    async putFile(docId, bytes) {
      files.set(docId, bytes.slice());
    },
    async getData<T>(docId: string, kind: DocDataKind) {
      const key = dataKey(docId, kind);
      return data.has(key) ? (structuredClone(data.get(key)) as T) : null;
    },
    async putData(docId, kind, value) {
      data.set(dataKey(docId, kind), structuredClone(value));
    },
    async removeDocument(docId) {
      metas.delete(docId);
      files.delete(docId);
      for (const key of [...data.keys()]) {
        if (key.startsWith(`${docId}/`)) data.delete(key);
      }
    },
  };
}
