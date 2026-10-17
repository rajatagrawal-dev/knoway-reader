// Everything Knoway Reader keeps per document, behind one small interface with
// two backends: plain files in the app data folder on desktop (desktop.ts)
// and IndexedDB on the web (indexedDb.ts). See
// docs/superpowers/specs/2026-09-27-grounded-study-roadmap.md §4.1.

// One stored value per kind, so saving highlights never rewrites the (much
// larger) dive history.
export type DocDataKind =
  | "highlights"
  | "dives"
  | "pins"
  | "diveHighlights"
  | "generalNotes"
  | "glossary"
  | "threads"
  | "textIndex"
  | "thumbnail"; // the library card's cover: page 1, as a JPEG data URL

export const DOC_DATA_KINDS: readonly DocDataKind[] = [
  "highlights",
  "dives",
  "pins",
  "diveHighlights",
  "generalNotes",
  "glossary",
  "threads",
  "textIndex",
  "thumbnail",
];

// How the document was last being read, restored when it's reopened.
export interface ReadingView {
  zoom: number | "auto";
  twoPage: boolean;
  continuous: boolean;
  panel: string | null; // the sidebar panel open, if any
}

export interface DocumentMeta {
  docId: string; // SHA-256 of the PDF bytes, hex
  title: string;
  fileName: string;
  byteLength: number;
  addedAt: string; // ISO timestamps
  openedAt: string;
  author?: string;
  pageCount?: number;
  lastPage?: number;
  view?: ReadingView;
  // Notes imported (from a backup) for a PDF that isn't in this library yet:
  // importing that PDF brings them together.
  fileMissing?: boolean;
}

export interface LibraryStorage {
  listDocuments(): Promise<DocumentMeta[]>;
  getMeta(docId: string): Promise<DocumentMeta | null>;
  putMeta(meta: DocumentMeta): Promise<void>;
  getFile(docId: string): Promise<Uint8Array | null>;
  putFile(docId: string, bytes: Uint8Array): Promise<void>;
  getData<T>(docId: string, kind: DocDataKind): Promise<T | null>;
  putData(docId: string, kind: DocDataKind, value: unknown): Promise<void>;
  removeDocument(docId: string): Promise<void>;
}
