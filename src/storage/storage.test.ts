import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopStorage, type DesktopFs } from "./desktop.ts";
import { DocDataWriter } from "./docDataWriter.ts";
import { computeDocId, legacyKey, migrateLegacy, openDocument, type LegacyStore } from "./documents.ts";
import { createMemoryStorage } from "./memory.ts";
import type { DocumentMeta, LibraryStorage } from "./types.ts";

// An in-memory file system with the semantics desktop.ts relies on:
// recursive mkdir, rename replacing its target, recursive remove. `failOn`
// makes writes to matching paths throw, and `log` records every call.
function fakeFs(options: { failOn?: RegExp } = {}) {
  const files = new Map<string, Uint8Array | string>();
  const dirs = new Set<string>();
  const log: string[] = [];
  const parentDirs = (path: string) => {
    const parts = path.split("/");
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
  };
  const addFile = (path: string, data: Uint8Array | string) => {
    if (options.failOn?.test(path)) throw new Error(`write failed: ${path}`);
    parentDirs(path).forEach((dir) => dirs.add(dir));
    files.set(path, data);
  };
  const fs: DesktopFs = {
    async exists(path) {
      return files.has(path) || dirs.has(path);
    },
    async mkdir(path) {
      log.push(`mkdir ${path}`);
      [...parentDirs(path), path].forEach((dir) => dirs.add(dir));
    },
    async readDir(path) {
      const names = new Map<string, boolean>();
      for (const candidate of [...files.keys(), ...dirs]) {
        if (!candidate.startsWith(`${path}/`)) continue;
        const rest = candidate.slice(path.length + 1);
        const name = rest.split("/")[0];
        names.set(name, (names.get(name) ?? false) || rest.includes("/") || dirs.has(`${path}/${name}`));
      }
      return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
    async readFile(path) {
      const data = files.get(path);
      if (!(data instanceof Uint8Array)) throw new Error(`no file: ${path}`);
      return data;
    },
    async writeFile(path, data) {
      log.push(`write ${path}`);
      addFile(path, data.slice());
    },
    async readTextFile(path) {
      const data = files.get(path);
      if (typeof data !== "string") throw new Error(`no file: ${path}`);
      return data;
    },
    async writeTextFile(path, data) {
      log.push(`write ${path}`);
      addFile(path, data);
    },
    async rename(from, to) {
      log.push(`rename ${from} -> ${to}`);
      const data = files.get(from);
      if (data === undefined) throw new Error(`no file: ${from}`);
      files.delete(from);
      addFile(to, data);
    },
    async remove(path) {
      for (const key of [...files.keys()]) if (key === path || key.startsWith(`${path}/`)) files.delete(key);
      for (const dir of [...dirs]) if (dir === path || dir.startsWith(`${path}/`)) dirs.delete(dir);
    },
  };
  return { fs, files, log };
}

function fakeLegacy(entries: Record<string, string>): LegacyStore & { items: Map<string, string> } {
  const items = new Map(Object.entries(entries));
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

const DOC_ID = "a".repeat(64);
const OTHER_ID = "b".repeat(64);

function meta(docId: string, title = "Book"): DocumentMeta {
  const at = "2026-09-27T00:00:00.000Z";
  return { docId, title, fileName: `${title}.pdf`, byteLength: 3, addedAt: at, openedAt: at };
}

// ---- The LibraryStorage contract, for every backend ----------------------

const backends: [string, () => LibraryStorage][] = [
  ["memory", createMemoryStorage],
  ["desktop", () => createDesktopStorage(fakeFs().fs)],
];

for (const [name, create] of backends) {
  test(`${name}: an empty library lists nothing and reads null`, async () => {
    const storage = create();
    assert.deepEqual(await storage.listDocuments(), []);
    assert.equal(await storage.getMeta(DOC_ID), null);
    assert.equal(await storage.getFile(DOC_ID), null);
    assert.equal(await storage.getData(DOC_ID, "highlights"), null);
  });

  test(`${name}: round-trips meta, file and data per document`, async () => {
    const storage = create();
    await storage.putMeta(meta(DOC_ID));
    await storage.putFile(DOC_ID, new Uint8Array([1, 2, 3]));
    await storage.putData(DOC_ID, "highlights", [{ id: "h1" }]);
    await storage.putData(DOC_ID, "dives", [{ id: "d1" }]);
    await storage.putMeta(meta(OTHER_ID, "Other"));

    assert.deepEqual(await storage.getMeta(DOC_ID), meta(DOC_ID));
    assert.deepEqual([...((await storage.getFile(DOC_ID)) ?? [])], [1, 2, 3]);
    assert.deepEqual(await storage.getData(DOC_ID, "highlights"), [{ id: "h1" }]);
    assert.deepEqual(await storage.getData(DOC_ID, "dives"), [{ id: "d1" }]);
    assert.equal(await storage.getData(OTHER_ID, "highlights"), null);
    const titles = (await storage.listDocuments()).map((m) => m.title).sort();
    assert.deepEqual(titles, ["Book", "Other"]);
  });

  test(`${name}: overwriting a kind replaces it`, async () => {
    const storage = create();
    await storage.putData(DOC_ID, "pins", [{ id: "p1" }]);
    await storage.putData(DOC_ID, "pins", []);
    assert.deepEqual(await storage.getData(DOC_ID, "pins"), []);
  });

  test(`${name}: removing a document removes all of it and nothing else`, async () => {
    const storage = create();
    await storage.putMeta(meta(DOC_ID));
    await storage.putFile(DOC_ID, new Uint8Array([1]));
    await storage.putData(DOC_ID, "glossary", [{ id: "g1" }]);
    await storage.putMeta(meta(OTHER_ID, "Other"));
    await storage.putData(OTHER_ID, "glossary", [{ id: "g2" }]);

    await storage.removeDocument(DOC_ID);

    assert.equal(await storage.getMeta(DOC_ID), null);
    assert.equal(await storage.getFile(DOC_ID), null);
    assert.equal(await storage.getData(DOC_ID, "glossary"), null);
    assert.deepEqual(await storage.getData(OTHER_ID, "glossary"), [{ id: "g2" }]);
  });
}

// ---- Desktop specifics -----------------------------------------------------

test("desktop: lays documents out as one folder of plain files", async () => {
  const { fs, files } = fakeFs();
  const storage = createDesktopStorage(fs);
  await storage.putMeta(meta(DOC_ID));
  await storage.putFile(DOC_ID, new Uint8Array([1]));
  await storage.putData(DOC_ID, "diveHighlights", []);
  assert.deepEqual([...files.keys()].sort(), [
    `library/${DOC_ID}/diveHighlights.json`,
    `library/${DOC_ID}/meta.json`,
    `library/${DOC_ID}/source.pdf`,
  ]);
});

test("desktop: writes go to a temp file first, then replace the real one", async () => {
  const { fs, log } = fakeFs();
  await createDesktopStorage(fs).putData(DOC_ID, "pins", []);
  const path = `library/${DOC_ID}/pins.json`;
  assert.deepEqual(log.slice(-2), [`write ${path}.tmp`, `rename ${path}.tmp -> ${path}`]);
});

test("desktop: a failed write leaves the previous version intact", async () => {
  const { fs } = fakeFs();
  const storage = createDesktopStorage(fs);
  await storage.putData(DOC_ID, "pins", [{ id: "kept" }]);
  const failing = createDesktopStorage({
    ...fs,
    writeTextFile: async (path) => {
      throw new Error(`disk full: ${path}`);
    },
  });
  await assert.rejects(failing.putData(DOC_ID, "pins", []));
  assert.deepEqual(await storage.getData(DOC_ID, "pins"), [{ id: "kept" }]);
});

test("desktop: overlapping saves of one file land in order", async () => {
  const { fs } = fakeFs();
  const storage = createDesktopStorage(fs);
  await Promise.all([1, 2, 3].map((n) => storage.putData(DOC_ID, "pins", [{ id: `v${n}` }])));
  assert.deepEqual(await storage.getData(DOC_ID, "pins"), [{ id: "v3" }]);
});

test("desktop: a corrupt file throws rather than reading as empty", async () => {
  const { fs, files } = fakeFs();
  const storage = createDesktopStorage(fs);
  await storage.putData(DOC_ID, "highlights", []);
  files.set(`library/${DOC_ID}/highlights.json`, "{not json");
  await assert.rejects(storage.getData(DOC_ID, "highlights"));
});

test("desktop: rejects document ids that aren't a content hash", async () => {
  const storage = createDesktopStorage(fakeFs().fs);
  await assert.rejects(storage.getData("../../etc", "highlights"));
  await assert.rejects(storage.putMeta(meta("../x")));
});

test("desktop: one unreadable document doesn't hide the rest of the library", async () => {
  const { fs, files } = fakeFs();
  const storage = createDesktopStorage(fs);
  await storage.putMeta(meta(DOC_ID));
  await storage.putMeta(meta(OTHER_ID, "Other"));
  files.set(`library/${DOC_ID}/meta.json`, "{");
  assert.deepEqual((await storage.listDocuments()).map((m) => m.title), ["Other"]);
});

// ---- Document identity, opening, and legacy migration ----------------------

test("computeDocId is the hex SHA-256 of the bytes", async () => {
  // SHA-256("abc")
  assert.equal(
    await computeDocId(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

const FILE = { name: "Book.pdf", size: 3, lastModified: 1700000000000 };

test("migrateLegacy moves every kind and deletes its legacy key", async () => {
  const storage = createMemoryStorage();
  const legacy = fakeLegacy({
    [legacyKey("pdf-highlights", FILE)]: JSON.stringify([{ id: "h1" }]),
    [legacyKey("pdf-dive-highlights", FILE)]: JSON.stringify([{ id: "dh1" }]),
    [legacyKey("pdf-glossary", FILE)]: JSON.stringify([{ id: "g1" }]),
    "pdf-highlights:Other.pdf:9:1": JSON.stringify([{ id: "elsewhere" }]),
    "highlight-pen": "{}",
  });

  const migrated = await migrateLegacy(storage, DOC_ID, FILE, legacy);

  assert.deepEqual(migrated.sort(), ["diveHighlights", "glossary", "highlights"]);
  assert.deepEqual(await storage.getData(DOC_ID, "highlights"), [{ id: "h1" }]);
  assert.deepEqual(await storage.getData(DOC_ID, "diveHighlights"), [{ id: "dh1" }]);
  assert.deepEqual([...legacy.items.keys()].sort(), ["highlight-pen", "pdf-highlights:Other.pdf:9:1"]);
});

test("migrateLegacy merges into existing data instead of overwriting it", async () => {
  const storage = createMemoryStorage();
  await storage.putData(DOC_ID, "pins", [{ id: "p1", text: "stored" }]);
  const legacy = fakeLegacy({
    [legacyKey("pdf-pins", FILE)]: JSON.stringify([{ id: "p1", text: "legacy" }, { id: "p2" }]),
  });
  await migrateLegacy(storage, DOC_ID, FILE, legacy);
  assert.deepEqual(await storage.getData(DOC_ID, "pins"), [{ id: "p1", text: "stored" }, { id: "p2" }]);
});

test("migrateLegacy keeps the legacy key when it can't parse or write", async () => {
  const badJson = fakeLegacy({ [legacyKey("pdf-pins", FILE)]: "{" });
  await migrateLegacy(createMemoryStorage(), DOC_ID, FILE, badJson);
  assert.equal(badJson.items.size, 1);

  const failing = createDesktopStorage(fakeFs({ failOn: /pins\.json/ }).fs);
  const legacy = fakeLegacy({ [legacyKey("pdf-pins", FILE)]: "[]" });
  assert.deepEqual(await migrateLegacy(failing, DOC_ID, FILE, legacy), []);
  assert.equal(legacy.items.size, 1);
});

test("openDocument imports once, then only marks the document opened", async () => {
  const storage = createMemoryStorage();
  const bytes = new TextEncoder().encode("pdf");

  const first = await openDocument(storage, { bytes, fileName: "Quantum Notes.pdf" });
  assert.equal(first.meta.title, "Quantum Notes");
  assert.equal(first.meta.byteLength, 3);
  assert.deepEqual([...((await storage.getFile(first.meta.docId)) ?? [])], [...bytes]);
  assert.equal(first.data.highlights, null);

  await storage.putData(first.meta.docId, "highlights", [{ id: "h1" }]);
  const second = await openDocument(storage, { bytes, fileName: "renamed.pdf" });
  assert.equal(second.meta.docId, first.meta.docId);
  assert.equal(second.meta.title, "Quantum Notes");
  assert.equal(second.meta.addedAt, first.meta.addedAt);
  assert.deepEqual(second.data.highlights, [{ id: "h1" }]);
  assert.equal((await storage.listDocuments()).length, 1);
});

test("openDocument migrates legacy data for the File it came from", async () => {
  const storage = createMemoryStorage();
  const bytes = new TextEncoder().encode("pdf");
  const legacy = fakeLegacy({ [legacyKey("pdf-dives", FILE)]: JSON.stringify([{ id: "d1" }]) });
  const opened = await openDocument(storage, { bytes, fileName: FILE.name, legacyFile: FILE }, legacy);
  assert.deepEqual(opened.data.dives, [{ id: "d1" }]);
  assert.equal(legacy.items.size, 0);
});

// ---- Debounced writer ------------------------------------------------------

function countingStorage() {
  const storage = createMemoryStorage();
  const writes: unknown[] = [];
  const putData = storage.putData.bind(storage);
  storage.putData = async (docId, kind, value) => {
    writes.push(value);
    await putData(docId, kind, value);
  };
  return { storage, writes };
}

test("writer coalesces rapid changes into one write of the latest value", async () => {
  const { storage, writes } = countingStorage();
  const writer = new DocDataWriter(storage);
  writer.schedule(DOC_ID, "highlights", [1]);
  writer.schedule(DOC_ID, "highlights", [1, 2]);
  writer.schedule(DOC_ID, "highlights", [1, 2, 3]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(writes, [[1, 2, 3]]);
  assert.deepEqual(await storage.getData(DOC_ID, "highlights"), [1, 2, 3]);
});

test("writer skips a value it was primed with, and flush writes the rest now", async () => {
  const { storage, writes } = countingStorage();
  const writer = new DocDataWriter(storage);
  const loaded = [{ id: "h1" }];
  writer.prime(DOC_ID, "highlights", loaded);
  writer.schedule(DOC_ID, "highlights", loaded);
  writer.schedule(DOC_ID, "pins", []);
  await writer.flush();
  assert.deepEqual(writes, [[]]);
});

test("writer keeps documents apart and retries after a failed write", async () => {
  const { storage } = countingStorage();
  const errors: unknown[] = [];
  const writer = new DocDataWriter(storage, (error) => errors.push(error));
  const value = [{ id: "x" }];
  const putData = storage.putData;
  storage.putData = async () => {
    throw new Error("disk full");
  };
  writer.schedule(DOC_ID, "pins", value);
  await writer.flush();
  assert.equal(errors.length, 1);

  storage.putData = putData;
  writer.schedule(DOC_ID, "pins", value);
  writer.schedule(OTHER_ID, "pins", []);
  await writer.flush();
  assert.deepEqual(await storage.getData(DOC_ID, "pins"), value);
  assert.deepEqual(await storage.getData(OTHER_ID, "pins"), []);
});
