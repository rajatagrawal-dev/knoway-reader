import { isTauri } from "@tauri-apps/api/core";
import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  readFile,
  readTextFile,
  remove,
  rename,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { createDesktopStorage, type DesktopFs } from "./desktop";
import { createIndexedDbStorage } from "./indexedDb";
import type { LibraryStorage } from "./types";

export type { DocDataKind, DocumentMeta, LibraryStorage, ReadingView } from "./types";

// The Tauri fs plugin, with every path relative to the app data folder
// (e.g. ~/Library/Application Support/com.knowayreader.app on macOS). The
// capability in src-tauri/capabilities/default.json scopes it to
// $APPDATA/library/**.
const tauriFs: DesktopFs = {
  exists: (path) => exists(path, { baseDir: BaseDirectory.AppData }),
  mkdir: (path) => mkdir(path, { baseDir: BaseDirectory.AppData, recursive: true }),
  readDir: async (path) =>
    (await readDir(path, { baseDir: BaseDirectory.AppData })).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
    })),
  readFile: (path) => readFile(path, { baseDir: BaseDirectory.AppData }),
  writeFile: (path, data) => writeFile(path, data, { baseDir: BaseDirectory.AppData }),
  readTextFile: (path) => readTextFile(path, { baseDir: BaseDirectory.AppData }),
  writeTextFile: (path, data) => writeTextFile(path, data, { baseDir: BaseDirectory.AppData }),
  rename: (from, to) =>
    rename(from, to, { oldPathBaseDir: BaseDirectory.AppData, newPathBaseDir: BaseDirectory.AppData }),
  remove: (path) => remove(path, { baseDir: BaseDirectory.AppData, recursive: true }),
};

let storage: LibraryStorage | null = null;

// Files on disk in the desktop app; IndexedDB in a browser.
export function getStorage(): LibraryStorage {
  storage ??= isTauri() ? createDesktopStorage(tauriFs) : createIndexedDbStorage();
  return storage;
}
