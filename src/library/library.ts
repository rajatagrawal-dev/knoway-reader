import { mergeById, READER_DATA_KINDS } from "../storage/documents.ts";
import type { DocDataKind, DocumentMeta, LibraryStorage } from "../storage/types.ts";

// The library's own logic, apart from its UI (LibraryHome): naming,
// ordering, and moving the reader's notes in and out as one backup file.

// A PDF's embedded title, when it's a real one. Producers often leave junk
// there — "untitled", the source file's name, "Microsoft Word - draft.docx"
// — in which case the file name reads better.
export function pickTitle(embedded: string | undefined, fileTitle: string): string {
  const title = embedded?.replace(/\s+/g, " ").trim() ?? "";
  if (title.length < 3 || title.length > 200) return fileTitle;
  if (/^(untitled|unknown|title|document|slide ?\d*|microsoft word\b.*)$/i.test(title)) return fileTitle;
  if (/\.(docx?|pdf|tex|dvi|pptx?|odt|rtf|indd|ps)\b/i.test(title)) return fileTitle;
  return title;
}

export type LibrarySort = "opened" | "title" | "added";

export function sortDocuments(documents: DocumentMeta[], sort: LibrarySort): DocumentMeta[] {
  const list = [...documents];
  if (sort === "title") return list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  if (sort === "added") return list.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  // Recently opened first; never-opened ones after, newest added first.
  return list.sort((a, b) => b.openedAt.localeCompare(a.openedAt) || b.addedAt.localeCompare(a.addedAt));
}

export function filterDocuments(documents: DocumentMeta[], query: string): DocumentMeta[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return documents;
  return documents.filter((doc) => {
    const hay = `${doc.title} ${doc.author ?? ""} ${doc.fileName}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

// The few documents most recently read, for "Continue reading".
export function continueReading(documents: DocumentMeta[], count = 3): DocumentMeta[] {
  return sortDocuments(
    documents.filter((doc) => doc.openedAt && !doc.fileMissing),
    "opened",
  ).slice(0, count);
}

// "p. 124 of 310", and how far along that is (0–1) — for a document the
// reader has opened; one never opened has no progress to show.
export function readingProgress(doc: DocumentMeta): { label: string; fraction: number } | null {
  if (!doc.pageCount || !doc.openedAt) return null;
  const page = Math.min(doc.lastPage ?? 1, doc.pageCount);
  return { label: `p. ${page} of ${doc.pageCount}`, fraction: page / doc.pageCount };
}

// ---- Notes backup --------------------------------------------------------------

// Everything the reader made, per document — not the PDFs themselves, nor
// what's rebuilt from them (the text cache, the cover).
const NOTE_KINDS: DocDataKind[] = [...READER_DATA_KINDS];

const NOTES_FORMAT = "knowayreader-notes";

export interface NotesBackup {
  format: typeof NOTES_FORMAT;
  version: 1;
  exportedAt: string;
  documents: { meta: DocumentMeta; data: Partial<Record<DocDataKind, unknown>> }[];
}

export async function exportNotes(storage: LibraryStorage): Promise<NotesBackup> {
  const metas = await storage.listDocuments();
  const documents = [];
  for (const meta of metas) {
    const data: Partial<Record<DocDataKind, unknown>> = {};
    for (const kind of NOTE_KINDS) {
      const value = await storage.getData<unknown>(meta.docId, kind);
      if (value !== null) data[kind] = value;
    }
    documents.push({ meta, data });
  }
  return { format: NOTES_FORMAT, version: 1, exportedAt: new Date().toISOString(), documents };
}

export interface ImportSummary {
  documents: number; // documents the backup had notes for
  missingFiles: number; // …whose PDF isn't in this library (yet)
}

// Merges a backup into the library: notes are added to what's there
// (record by record, never overwriting), and a document whose PDF isn't here
// yet is listed as missing its file until that PDF is imported.
export async function importNotes(storage: LibraryStorage, backup: unknown): Promise<ImportSummary> {
  const parsed = backup as NotesBackup;
  if (!parsed || parsed.format !== NOTES_FORMAT || !Array.isArray(parsed.documents)) {
    throw new Error("This isn't a Knoway Reader notes backup.");
  }
  let missingFiles = 0;
  for (const { meta, data } of parsed.documents) {
    if (!meta || !/^[0-9a-f]{64}$/.test(meta.docId)) continue;
    const existing = await storage.getMeta(meta.docId);
    if (!existing) {
      await storage.putMeta({ ...meta, fileMissing: true });
      missingFiles += 1;
    } else if (existing.fileMissing) {
      missingFiles += 1;
    }
    for (const kind of NOTE_KINDS) {
      const incoming = data?.[kind];
      if (incoming === undefined || incoming === null) continue;
      const stored = await storage.getData<unknown>(meta.docId, kind);
      await storage.putData(meta.docId, kind, stored === null ? incoming : mergeById(stored, incoming));
    }
  }
  return { documents: parsed.documents.length, missingFiles };
}
