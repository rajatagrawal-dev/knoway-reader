import type { DocDataKind, DocumentMeta, LibraryStorage } from "./types.ts";

// A document's identity is its content: the SHA-256 of its bytes. Renaming
// or re-saving the file keeps its notes, and importing it twice opens the
// one existing entry.
export async function computeDocId(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---- Legacy localStorage data --------------------------------------------

// Before the library, each kind of per-document data lived in localStorage
// under `<prefix>:<name>:<size>:<lastModified>` of the File it was opened
// from.
const LEGACY_PREFIXES: Partial<Record<DocDataKind, string>> = {
  highlights: "pdf-highlights",
  dives: "pdf-dives",
  pins: "pdf-pins",
  diveHighlights: "pdf-dive-highlights",
  generalNotes: "pdf-general-notes",
  glossary: "pdf-glossary",
};

export interface LegacyFileIdentity {
  name: string;
  size: number;
  lastModified: number;
}

export interface LegacyStore {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

export function legacyKey(prefix: string, file: LegacyFileIdentity): string {
  return `${prefix}:${file.name}:${file.size}:${file.lastModified}`;
}

// Every legacy kind is a list of records with an `id`. Merging keeps
// everything already stored and adds the legacy records it doesn't have yet
// — two copies of one PDF (same content, different file dates) each had
// their own legacy notes, and both should survive.
export function mergeById(stored: unknown, legacy: unknown): unknown {
  if (!Array.isArray(stored) || !Array.isArray(legacy)) return stored ?? legacy;
  const ids = new Set(stored.map((item) => (item as { id?: unknown })?.id));
  return [...stored, ...legacy.filter((item) => !ids.has((item as { id?: unknown })?.id))];
}

// Moves any legacy data for `file` into `docId`'s storage, deleting each
// legacy key only once its data is safely written. Returns the kinds moved.
export async function migrateLegacy(
  storage: LibraryStorage,
  docId: string,
  file: LegacyFileIdentity,
  legacy: LegacyStore,
): Promise<DocDataKind[]> {
  const migrated: DocDataKind[] = [];
  for (const [kind, prefix] of Object.entries(LEGACY_PREFIXES) as [DocDataKind, string][]) {
    const key = legacyKey(prefix, file);
    try {
      const raw = legacy.getItem(key);
      if (raw === null) continue;
      const value: unknown = JSON.parse(raw);
      const stored = await storage.getData<unknown>(docId, kind);
      await storage.putData(docId, kind, stored === null ? value : mergeById(stored, value));
      legacy.removeItem(key);
      migrated.push(kind);
    } catch {
      // Unparseable or unwritable: leave the legacy key where it is, so a
      // later open can try again and nothing is lost.
    }
  }
  return migrated;
}

// ---- Opening a document --------------------------------------------------

// What the reader loads when a document opens.
export const READER_DATA_KINDS = [
  "highlights",
  "dives",
  "pins",
  "diveHighlights",
  "generalNotes",
  "glossary",
  "threads",
] as const satisfies readonly DocDataKind[];

export type ReaderDataKind = (typeof READER_DATA_KINDS)[number];

export interface OpenedDocument {
  meta: DocumentMeta;
  data: Record<ReaderDataKind, unknown>; // null where nothing is stored yet
}

function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "") || fileName;
}

// Adds the PDF to the library if it isn't there yet — or brings back its
// file, for notes restored from a backup without it. `open` marks it
// opened now; an import alone (from the library) doesn't. Details the PDF
// itself provides (title, author, page count) are filled in by the caller,
// who has the PDF parsed (see library/pdfInfo.ts).
export async function importDocument(
  storage: LibraryStorage,
  input: { bytes: Uint8Array; fileName: string; docId?: string; open?: boolean },
): Promise<{ meta: DocumentMeta; added: boolean }> {
  const docId = input.docId ?? (await computeDocId(input.bytes));
  const now = new Date().toISOString();

  const existing = await storage.getMeta(docId);
  let meta: DocumentMeta;
  if (existing && !existing.fileMissing) {
    meta = input.open ? { ...existing, openedAt: now } : existing;
    if (input.open) await storage.putMeta(meta);
    return { meta, added: false };
  }
  // The file first: meta without fileMissing must imply the PDF is there.
  await storage.putFile(docId, input.bytes);
  if (existing) {
    const { fileMissing: _restored, ...rest } = existing;
    meta = { ...rest, byteLength: input.bytes.byteLength, ...(input.open ? { openedAt: now } : {}) };
  } else {
    meta = {
      docId,
      title: titleFromFileName(input.fileName),
      fileName: input.fileName,
      byteLength: input.bytes.byteLength,
      addedAt: now,
      // Never opened yet: the library's "Continue reading" skips it.
      openedAt: input.open ? now : "",
    };
  }
  await storage.putMeta(meta);
  return { meta, added: true };
}

export async function loadReaderData(storage: LibraryStorage, docId: string): Promise<Record<ReaderDataKind, unknown>> {
  const values = await Promise.all(READER_DATA_KINDS.map((kind) => storage.getData<unknown>(docId, kind)));
  return Object.fromEntries(READER_DATA_KINDS.map((kind, i) => [kind, values[i]])) as Record<ReaderDataKind, unknown>;
}

// Imports the PDF into the library if it isn't there yet (otherwise just
// marks it opened), migrates legacy data when the File it came from is
// known, and loads everything the reader needs.
export async function openDocument(
  storage: LibraryStorage,
  input: { bytes: Uint8Array; fileName: string; legacyFile?: LegacyFileIdentity; docId?: string },
  legacy?: LegacyStore,
): Promise<OpenedDocument> {
  const { meta } = await importDocument(storage, { ...input, open: true });
  const { docId } = meta;

  if (input.legacyFile && legacy) await migrateLegacy(storage, docId, input.legacyFile, legacy);

  const values = await Promise.all(READER_DATA_KINDS.map((kind) => storage.getData<unknown>(docId, kind)));
  const data = Object.fromEntries(READER_DATA_KINDS.map((kind, i) => [kind, values[i]])) as Record<
    ReaderDataKind,
    unknown
  >;
  return { meta, data };
}
