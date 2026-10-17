import test from "node:test";
import assert from "node:assert/strict";
import { importDocument, openDocument } from "../storage/documents.ts";
import { createMemoryStorage } from "../storage/memory.ts";
import type { DocumentMeta } from "../storage/types.ts";
import {
  continueReading,
  exportNotes,
  filterDocuments,
  importNotes,
  pickTitle,
  readingProgress,
  sortDocuments,
} from "./library.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

function meta(title: string, extra: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    docId: title.padEnd(64, "0").replace(/[^0-9a-f]/g, "a").slice(0, 64),
    title,
    fileName: `${title}.pdf`,
    byteLength: 1,
    addedAt: "2026-09-01T00:00:00.000Z",
    openedAt: "",
    ...extra,
  };
}

test("pickTitle keeps real embedded titles and falls back to the file name for junk", () => {
  assert.equal(pickTitle("Quantum Computation and Quantum Information", "nielsen-chuang"), "Quantum Computation and Quantum Information");
  for (const junk of ["", "untitled", "Microsoft Word - draft.docx", "main.tex", "ab", undefined]) {
    assert.equal(pickTitle(junk, "nielsen-chuang"), "nielsen-chuang", String(junk));
  }
});

test("sorting, filtering, continue reading and progress", () => {
  const docs = [
    meta("beta", { openedAt: "2026-09-20T00:00:00.000Z", addedAt: "2026-09-02T00:00:00.000Z", pageCount: 100, lastPage: 51 }),
    meta("alpha", { openedAt: "2026-09-25T00:00:00.000Z", author: "Ada" }),
    meta("gamma", { addedAt: "2026-09-10T00:00:00.000Z" }),
    meta("delta", { openedAt: "2026-09-26T00:00:00.000Z", fileMissing: true }),
  ];
  assert.deepEqual(sortDocuments(docs, "title").map((d) => d.title), ["alpha", "beta", "delta", "gamma"]);
  assert.deepEqual(sortDocuments(docs, "added").map((d) => d.title), ["gamma", "beta", "alpha", "delta"]);
  assert.deepEqual(sortDocuments(docs, "opened").map((d) => d.title), ["delta", "alpha", "beta", "gamma"]);
  assert.deepEqual(filterDocuments(docs, "ada").map((d) => d.title), ["alpha"]);
  // Never opened, or missing its PDF: not something to continue.
  assert.deepEqual(continueReading(docs).map((d) => d.title), ["alpha", "beta"]);
  assert.deepEqual(readingProgress(docs[0]), { label: "p. 51 of 100", fraction: 0.51 });
  assert.equal(readingProgress(docs[1]), null); // no page count
  assert.equal(readingProgress(meta("new", { pageCount: 12 })), null); // never opened
});

test("importing adds a document once; opening marks it opened", async () => {
  const storage = createMemoryStorage();
  const first = await importDocument(storage, { bytes: bytes("pdf-1"), fileName: "One.pdf" });
  assert.equal(first.added, true);
  assert.equal(first.meta.openedAt, "");
  const again = await importDocument(storage, { bytes: bytes("pdf-1"), fileName: "renamed.pdf" });
  assert.equal(again.added, false);
  const opened = await openDocument(storage, { bytes: bytes("pdf-1"), fileName: "One.pdf" });
  assert.notEqual(opened.meta.openedAt, "");
  assert.equal((await storage.listDocuments()).length, 1);
});

test("a notes backup round-trips, merges into existing notes, and waits for missing PDFs", async () => {
  const source = createMemoryStorage();
  const { meta: a } = await importDocument(source, { bytes: bytes("pdf-a"), fileName: "A.pdf" });
  const { meta: b } = await importDocument(source, { bytes: bytes("pdf-b"), fileName: "B.pdf" });
  await source.putData(a.docId, "highlights", [{ id: "h1" }]);
  await source.putData(b.docId, "threads", [{ id: "t1" }]);
  await source.putData(a.docId, "textIndex", { big: true });
  const backup = JSON.parse(JSON.stringify(await exportNotes(source)));
  assert.equal(backup.documents.length, 2);
  assert.equal("textIndex" in backup.documents.find((d: { meta: DocumentMeta }) => d.meta.docId === a.docId).data, false);

  // A library that has A (with a note of its own) but not B.
  const target = createMemoryStorage();
  await importDocument(target, { bytes: bytes("pdf-a"), fileName: "A.pdf" });
  await target.putData(a.docId, "highlights", [{ id: "h0" }]);
  const summary = await importNotes(target, backup);
  assert.deepEqual(summary, { documents: 2, missingFiles: 1 });
  assert.deepEqual(await target.getData(a.docId, "highlights"), [{ id: "h0" }, { id: "h1" }]);
  assert.equal((await target.getMeta(b.docId))?.fileMissing, true);
  assert.deepEqual(await target.getData(b.docId, "threads"), [{ id: "t1" }]);

  // Importing B's PDF brings its notes and file together.
  const relinked = await importDocument(target, { bytes: bytes("pdf-b"), fileName: "B.pdf" });
  assert.equal(relinked.added, true);
  assert.equal(relinked.meta.fileMissing, undefined);
  assert.ok(await target.getFile(b.docId));
  assert.deepEqual(await target.getData(b.docId, "threads"), [{ id: "t1" }]);

  // Importing the same backup twice changes nothing.
  await importNotes(target, backup);
  assert.deepEqual(await target.getData(a.docId, "highlights"), [{ id: "h0" }, { id: "h1" }]);

  await assert.rejects(importNotes(target, { something: "else" }), /isn't a Knoway Reader notes backup/);
});
