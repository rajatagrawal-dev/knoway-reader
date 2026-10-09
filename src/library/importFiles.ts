import { importDocument } from "../storage/documents";
import type { DocumentMeta, LibraryStorage } from "../storage/types";
import { pickTitle } from "./library";
import { readPdfInfo } from "./pdfInfo";

export interface ImportResult {
  added: DocumentMeta[];
  alreadyThere: DocumentMeta[];
  failed: string[]; // file names that weren't readable PDFs
}

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

// Adds PDFs to the library, one at a time (each is parsed for its title,
// author, page count and cover). A PDF already there — the same content,
// under any name — isn't added twice.
export async function importFiles(
  storage: LibraryStorage,
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const result: ImportResult = { added: [], alreadyThere: [], failed: [] };
  const pdfs = files.filter(isPdf);
  result.failed.push(...files.filter((file) => !isPdf(file)).map((file) => file.name));
  for (const [index, file] of pdfs.entries()) {
    onProgress?.(index, pdfs.length);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = await readPdfInfo(bytes);
      if (!info) {
        result.failed.push(file.name);
        continue;
      }
      const { meta, added } = await importDocument(storage, { bytes, fileName: file.name });
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
    } catch {
      result.failed.push(file.name);
    }
  }
  onProgress?.(pdfs.length, pdfs.length);
  return result;
}
