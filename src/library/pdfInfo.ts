import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "../pdfWorker";

// What the library shows about a PDF that the PDF itself says: its page
// count, embedded title and author, and a cover (page 1, small).

const THUMBNAIL_WIDTH = 240;

export async function renderThumbnail(pdf: PDFDocumentProxy): Promise<string | null> {
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: THUMBNAIL_WIDTH / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch {
    return null; // no cover; the card shows a placeholder
  }
}

export interface PdfInfo {
  pageCount: number;
  title?: string;
  author?: string;
  thumbnail: string | null;
}

export async function readPdfInfoFromDocument(pdf: PDFDocumentProxy): Promise<PdfInfo> {
  let title: string | undefined;
  let author: string | undefined;
  try {
    const { info } = await pdf.getMetadata();
    const fields = info as { Title?: unknown; Author?: unknown };
    if (typeof fields.Title === "string") title = fields.Title;
    if (typeof fields.Author === "string" && fields.Author.trim()) author = fields.Author.trim();
  } catch {
    // No metadata: the file name serves as the title.
  }
  return { pageCount: pdf.numPages, title, author, thumbnail: await renderThumbnail(pdf) };
}

export async function readPdfInfo(bytes: Uint8Array): Promise<PdfInfo | null> {
  if (!GlobalWorkerOptions.workerSrc) GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  // A copy: pdf.js takes ownership of (detaches) the buffer it's given, and
  // the caller still needs these bytes.
  const task = getDocument({ data: bytes.slice() });
  try {
    const pdf = await task.promise;
    try {
      return await readPdfInfoFromDocument(pdf);
    } finally {
      void pdf.destroy();
    }
  } catch {
    return null; // not a readable PDF
  }
}
