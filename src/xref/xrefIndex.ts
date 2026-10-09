import type { PDFDocumentProxy } from "pdfjs-dist";
import { getSections, getTextIndex } from "../text/documentText";
import { collectTargets, findPageRefs, type XrefRef, type XrefTarget, type XrefTargets } from "./detect";
import { readLinkRefs } from "./links";

// Every cross-reference in a document, built once per open document: the
// PDF's own links first, then references found in the text wherever no
// link already covers those words.
export interface XrefIndex {
  refsByPage: Map<number, XrefRef[]>;
  byAnnotation: Map<string, XrefTarget>; // a clicked PDF link → where it goes
  targets: XrefTargets; // every numbered thing and bibliography entry found
}

const cache = new WeakMap<PDFDocumentProxy, Promise<XrefIndex>>();

async function build(pdf: PDFDocumentProxy): Promise<XrefIndex> {
  const [index, sections] = await Promise.all([getTextIndex(pdf), getSections(pdf).catch(() => [])]);
  const targets = collectTargets(index.pages, sections);
  const links = await readLinkRefs(pdf, index, targets).catch(() => ({ refs: [], byAnnotation: new Map() }));

  const refsByPage = new Map<number, XrefRef[]>();
  for (const ref of links.refs) {
    const list = refsByPage.get(ref.pageNumber) ?? [];
    list.push(ref);
    refsByPage.set(ref.pageNumber, list);
  }
  for (const page of index.pages) {
    const linked = refsByPage.get(page.pageNumber) ?? [];
    const found = findPageRefs(page, targets).filter(
      (ref) => !linked.some((link) => ref.start < link.end && link.start < ref.end),
    );
    const all = [...linked, ...found].sort((a, b) => a.start - b.start);
    if (all.length) refsByPage.set(page.pageNumber, all);
  }
  return { refsByPage, byAnnotation: links.byAnnotation, targets };
}

export function getXrefIndex(pdf: PDFDocumentProxy): Promise<XrefIndex> {
  let index = cache.get(pdf);
  if (!index) {
    index = build(pdf);
    index.catch(() => cache.delete(pdf));
    cache.set(pdf, index);
  }
  return index;
}
