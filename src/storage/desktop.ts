import type { DocDataKind, DocumentMeta, LibraryStorage } from "./types.ts";

// Desktop storage: plain files under the app data folder, one folder per
// document —
//
//   library/<docId>/source.pdf     the imported copy of the PDF
//   library/<docId>/meta.json      DocumentMeta
//   library/<docId>/<kind>.json    one file per DocDataKind
//
// No quota, nothing a webview reset can evict, and backing up is copying a
// folder. The fs API is injected (index.ts binds the Tauri plugin to the app
// data directory) so this can be unit-tested against an in-memory fake.

export interface DesktopFs {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>; // recursive; fine if it already exists
  readDir(path: string): Promise<{ name: string; isDirectory: boolean }[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>; // replaces `to` if it exists
  remove(path: string): Promise<void>; // recursive
}

const ROOT = "library";

// A docId becomes a directory name, so only accept what computeDocId
// produces — never a path that could climb out of the library.
function docDir(docId: string): string {
  if (!/^[0-9a-f]{64}$/.test(docId)) throw new Error(`Invalid document id: ${docId}`);
  return `${ROOT}/${docId}`;
}

export function createDesktopStorage(fs: DesktopFs): LibraryStorage {
  // Writes to one path run one at a time, in order: two overlapping saves of
  // the same file would otherwise race on its temp file.
  const queues = new Map<string, Promise<void>>();
  const serialize = (path: string, write: () => Promise<void>): Promise<void> => {
    const previous = queues.get(path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(write);
    queues.set(path, next);
    void next.finally(() => {
      if (queues.get(path) === next) queues.delete(path);
    }).catch(() => {});
    return next;
  };

  // Write to a temp file, then rename over the real one, so a crash
  // mid-write leaves the previous version intact rather than a truncated
  // file.
  const writeAtomic = (dir: string, name: string, write: (path: string) => Promise<void>) => {
    const path = `${dir}/${name}`;
    return serialize(path, async () => {
      await fs.mkdir(dir);
      const temp = `${path}.tmp`;
      await write(temp);
      await fs.rename(temp, path);
    });
  };

  // Missing → null. A file that exists but doesn't parse throws: treating
  // it as empty would let the next save overwrite whatever it held.
  const readJson = async <T>(path: string): Promise<T | null> => {
    if (!(await fs.exists(path))) return null;
    return JSON.parse(await fs.readTextFile(path)) as T;
  };

  return {
    async listDocuments() {
      if (!(await fs.exists(ROOT))) return [];
      const entries = await fs.readDir(ROOT);
      const metas: DocumentMeta[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory || !/^[0-9a-f]{64}$/.test(entry.name)) continue;
        try {
          const meta = await readJson<DocumentMeta>(`${ROOT}/${entry.name}/meta.json`);
          if (meta) metas.push(meta);
        } catch {
          // One unreadable document shouldn't hide the rest of the library.
        }
      }
      return metas;
    },
    async getMeta(docId) {
      return readJson<DocumentMeta>(`${docDir(docId)}/meta.json`);
    },
    async putMeta(meta) {
      const json = JSON.stringify(meta);
      return writeAtomic(docDir(meta.docId), "meta.json", (path) => fs.writeTextFile(path, json));
    },
    async getFile(docId) {
      const path = `${docDir(docId)}/source.pdf`;
      return (await fs.exists(path)) ? fs.readFile(path) : null;
    },
    async putFile(docId, bytes) {
      return writeAtomic(docDir(docId), "source.pdf", (path) => fs.writeFile(path, bytes));
    },
    async getData<T>(docId: string, kind: DocDataKind) {
      return readJson<T>(`${docDir(docId)}/${kind}.json`);
    },
    async putData(docId, kind, value) {
      const json = JSON.stringify(value);
      return writeAtomic(docDir(docId), `${kind}.json`, (path) => fs.writeTextFile(path, json));
    },
    async removeDocument(docId) {
      const dir = docDir(docId);
      if (await fs.exists(dir)) await fs.remove(dir);
    },
  };
}
