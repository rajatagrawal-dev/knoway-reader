import { AnnotationMode, OPS, type PDFDocumentProxy } from "pdfjs-dist";
import { findFigures, placeTextItems, type FigureRegion, type TextItemLike } from "./detect";

// The figures on each page (see detect.ts), found the first time a page is
// shown and kept for as long as the document is open. Reading a page's
// drawing operators is the costly part, so pages nobody looks at are never
// read.

const cache = new WeakMap<PDFDocumentProxy, Map<number, Promise<FigureRegion[]>>>();

async function detect(pdf: PDFDocumentProxy, pageNumber: number): Promise<FigureRegion[]> {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const geometry = { width: viewport.width, height: viewport.height, transform: viewport.transform };
  const [list, text] = await Promise.all([
    // Annotations (comments, form fields, a reader's own highlights) aren't
    // part of the page's figures.
    page.getOperatorList({ annotationMode: AnnotationMode.DISABLE }),
    page.getTextContent(),
  ]);
  const items = text.items.filter((item): item is TextItemLike & typeof item => "str" in item);
  return findFigures(list, OPS, geometry, placeTextItems(items, geometry));
}

export function getPageFigures(pdf: PDFDocumentProxy, pageNumber: number): Promise<FigureRegion[]> {
  let pages = cache.get(pdf);
  if (!pages) {
    pages = new Map();
    cache.set(pdf, pages);
  }
  let figures = pages.get(pageNumber);
  if (!figures) {
    figures = detect(pdf, pageNumber).catch(() => []); // no figures; the reader is unaffected
    pages.set(pageNumber, figures);
  }
  return figures;
}
