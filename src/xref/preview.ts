import type { PDFDocumentProxy } from "pdfjs-dist";
import type { XrefTarget } from "./detect";

// What a cross-reference preview shows: the target itself, cut from its
// rendered page — the equation, theorem or figure exactly as the document
// prints it. Pages are rendered once (a few kept) and cropped per target.

const RENDER_WIDTH = 1100; // px — sharp at the card's size on a retina screen
const KEEP_PAGES = 6;
const MIN_CROP = 0.035; // of the page height
const SIDE_MARGIN = 0.05;

const pages = new Map<string, Promise<HTMLCanvasElement>>();

function renderPage(pdf: PDFDocumentProxy, pageNumber: number): Promise<HTMLCanvasElement> {
  const key = `${pdf.fingerprints?.[0] ?? ""}:${pageNumber}`;
  let rendered = pages.get(key);
  if (rendered) {
    pages.delete(key); // most recently used goes last
    pages.set(key, rendered);
    return rendered;
  }
  rendered = (async () => {
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: RENDER_WIDTH / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    return canvas;
  })();
  rendered.catch(() => pages.delete(key));
  pages.set(key, rendered);
  while (pages.size > KEEP_PAGES) pages.delete(pages.keys().next().value!);
  return rendered;
}

export async function cropTarget(pdf: PDFDocumentProxy, target: XrefTarget): Promise<string | null> {
  try {
    const page = await renderPage(pdf, target.pageNumber);
    const top = Math.max(0, target.top);
    const bottom = Math.min(1, Math.max(target.bottom, top + MIN_CROP));
    const sx = Math.round(page.width * SIDE_MARGIN);
    const sy = Math.round(page.height * top);
    const sw = page.width - sx * 2;
    const sh = Math.max(1, Math.round(page.height * (bottom - top)));
    const out = document.createElement("canvas");
    out.width = sw;
    out.height = sh;
    out.getContext("2d")!.drawImage(page, sx, sy, sw, sh, 0, 0, sw, sh);
    return out.toDataURL("image/png");
  } catch {
    return null;
  }
}
