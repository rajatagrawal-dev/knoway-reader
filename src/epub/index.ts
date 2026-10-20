import { computeDocId } from "../storage/documents.ts";
import type { DocumentMeta, LibraryStorage } from "../storage/types.ts";

// An EPUB in the library is the PDF it was converted to (convert.ts), kept
// under the EPUB's own identity — the SHA-256 of the EPUB's bytes — so adding
// the same EPUB again finds the existing entry (and its notes) without
// converting it again. The converter is loaded only when one is needed.

export function isEpub(file: { name: string; type: string }): boolean {
  return file.type === "application/epub+zip" || /\.epub$/i.test(file.name);
}

export interface EpubDocument {
  docId: string;
  existing: DocumentMeta | null; // already in the library, with its PDF
  pdf: Uint8Array;
}

export async function pdfForEpub(storage: LibraryStorage, epub: Uint8Array): Promise<EpubDocument> {
  const docId = await computeDocId(epub);
  const existing = await storage.getMeta(docId);
  if (existing && !existing.fileMissing) {
    const stored = await storage.getFile(docId);
    if (stored) return { docId, existing, pdf: stored };
  }
  const { convertEpubToPdf } = await import("./convert.ts");
  const { pdf } = await convertEpubToPdf(epub);
  return { docId, existing: null, pdf };
}
