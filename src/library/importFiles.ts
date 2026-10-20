import { isEpub, pdfForEpub } from "../epub";
import { importDocument } from "../storage/documents";
import type { DocumentMeta, LibraryStorage } from "../storage/types";
import { pickTitle } from "./library";
import { readPdfInfo } from "./pdfInfo";

export interface ImportResult {
  added: DocumentMeta[];
  alreadyThere: DocumentMeta[];
  failed: string[]; // file names that weren't readable PDFs or EPUBs
}

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

// Adds PDFs and EPUBs to the library, one at a time (each is parsed for its
// title, author, page count and cover; an EPUB is converted to a PDF first).
// A document already there — the same content, under any name — isn't added
// twice.
export async function importFiles(
  storage: LibraryStorage,
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const result: ImportResult = { added: [], alreadyThere: [], failed: [] };
  const readable = files.filter((file) => isPdf(file) || isEpub(file));
  result.failed.push(...files.filter((file) => !readable.includes(file)).map((file) => file.name));
  for (const [index, file] of readable.entries()) {
    onProgress?.(index, readable.length);
    try {
      let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
      let docId: string | undefined;
      if (isEpub(file)) {
        const epub = await pdfForEpub(storage, bytes);
        if (epub.existing) {
          result.alreadyThere.push(epub.existing);
          continue;
        }
        ({ docId, pdf: bytes } = epub);
      }
      const info = await readPdfInfo(bytes);
      if (!info) {
        result.failed.push(file.name);
        continue;
      }
      const { meta, added } = await importDocument(storage, { bytes, fileName: file.name, docId });
      if (!added) {
        result.alreadyThere.push(meta);
        continue;
      }
      const complete: DocumentMeta = {
        ...meta,
        title: pickTitle(info.title, meta.title),
        pageCount: info.pageCount,
        ...(info.author ? { author: info.author } : {}),
      };
      await storage.putMeta(complete);
      if (info.thumbnail) await storage.putData(meta.docId, "thumbnail", info.thumbnail);
      result.added.push(complete);
    } catch (error) {
      console.error(error);
      result.failed.push(file.name);
    }
  }
  onProgress?.(readable.length, readable.length);
  return result;
}
